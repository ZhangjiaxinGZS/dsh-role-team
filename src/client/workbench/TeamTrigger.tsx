import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState, type ComponentType } from 'react'
import type { Ui } from '../ui.js'

type Input = Pick<ContextMessageNode, 'source' | 'content'>
type Props = PropsRuntime<'conversation.chat.node', 'turn-trigger'> & PropsLocale<'chat'>
type Sender = { name: string | null } | null
type Text = Ui['t']

export function teamMessage({ source, content }: Input) {
  if (!source || typeof source !== 'object' || !('kind' in source) ||
      (source.kind !== 'agent-message' && source.kind !== 'team-message')) return null
  const field = (key: string) => {
    const value: unknown = Reflect.get(source, key)
    return typeof value === 'string' && value.length && value.length <= 256 ? value : undefined
  }
  // Relay prefixes can share a text block with the message or occupy their own block.
  const parts: Array<{ text: string } | { block: unknown }> = []
  for (const block of content) {
    const prev = parts.at(-1)
    if (block.type !== 'text') parts.push({ block })
    else if (prev && 'text' in prev) prev.text += block.text
    else parts.push({ text: block.text })
  }
  let alias: string | undefined
  const first = parts[0]
  if (first && 'text' in first) {
    const prefix = /^Agent ([^\r\n]{1,256}?) sent a message:[ \t]?/.exec(first.text)
    alias = prefix?.[1]
    if (prefix) first.text = first.text.slice(prefix[0].length)
    first.text = first.text.replace(/^\s*这条通知触发了本轮回复。[ \t]*(?:\r?\n|$)/, '')
  }
  return { senderId: field('senderSessionId') ?? field('senderId'), senderName: field('senderName') ?? alias, parts }
}

type Message = NonNullable<ReturnType<typeof teamMessage>>
export function TeamMessageCard({ message, name, time, t }: { message: Message; name: string; time: number; t: Text }) {
  const [open, setOpen] = useState(true)
  const id = useId()
  const date = new Date(time)
  return <section className="rt-team-trigger" data-turn-trigger>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>{t('messageFrom').replace('{name}', () => name)}</span>
      <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <IconChevronDownOutlineRegular size={12} />
    </button>
    {open && <div id={id} className="rt-team-trigger-body">{message.parts.map((part, i) =>
      'text' in part ? <MarkdownText key={i} text={part.text} omitHtml labels={{
        code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes'),
      }} /> : <pre key={i}>{JSON.stringify(part.block, null, 2)?.slice(0, 8000)}</pre>)}</div>}
  </section>
}

export function registerTeamTrigger(ctx: Context, call: Ui['call'], t: Text) {
  const slot = 'conversation.chat.node'
  // Several historical cards can share a sender. Share the lookup while it is in flight.
  const pending = new Map<string, Promise<Sender>>()
  function Routed(props: Props) {
    const { node, sessionId } = props
    const message = teamMessage(node.data)
    const { senderId, senderName } = message ?? {}
    const key = message && /^rt-(root|child)-/.test(sessionId) ? JSON.stringify([sessionId, senderId, senderName]) : null
    const [resolved, resolve] = useState<{ key: string; sender: Sender }>()
    useEffect(() => {
      if (!key) return
      let live = true
      let lookup = pending.get(key)
      if (!lookup) {
        lookup = call('teamMessageSender', { sessionId, senderId, senderName }).finally(() => pending.delete(key))
        pending.set(key, lookup)
      }
      lookup.then(sender => { if (live) resolve({ key, sender }) }, () => { if (live) resolve({ key, sender: null }) })
      return () => { live = false }
    }, [key, sessionId, senderId, senderName])
    if (message && resolved?.key === key && resolved?.sender) {
      const alias = senderName && !/^(?:role-|rt-(?:root|child)-|lead$)/.test(senderName) ? senderName : undefined
      return <TeamMessageCard message={message} name={resolved.sender.name ?? alias ?? t('messageMember')} time={node.data.time} t={t} />
    }
    // Delegate to the installed chat renderer with its own locale and original props.
    const native = ctx.slots.entries(slot).find(e => e.options.key === 'turn-trigger' && e.locale === 'chat' && e.component !== Routed)
    const Native = native?.component as ComponentType<Props> | undefined
    return Native ? <Native {...props} /> : null
  }
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key: 'turn-trigger', priority: -1, locale: 'chat' }, Routed))
}
