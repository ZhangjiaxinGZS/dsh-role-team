import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { extractMarkdownPlainText, IconChevronDownOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Ui } from '../ui.js'

type Input = Pick<ContextMessageNode, 'source' | 'content'>
type NodeKind = 'turn-trigger' | 'context' | 'turn-process'
type Props<K extends NodeKind> = PropsRuntime<'conversation.chat.node', K> & PropsLocale<'chat'>
type Sender = { name: string | null; fromParent?: boolean } | null
type Text = Ui['t']

export function teamMessage({ source, content }: Input) {
  if (!source || typeof source !== 'object' || !('kind' in source) ||
      (source.kind !== 'agent-message' && source.kind !== 'team-message' && source.kind !== 'subagent-settled')) return null
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
  const settled = source.kind === 'subagent-settled'
  let status = field('stopReason')
  let omitted = false
  const first = parts[0]
  if (first && 'text' in first) {
    const text = first.text.replace(/^\s*这条通知触发了本轮回复。[ \t]*(?:\r?\n|$)/, '')
    if (settled) {
      // The host may emit the envelope, marker and answer in separate text blocks.
      const prefix = /^Background subagent ([^\r\n]{1,256}?) (finished and will do no further work unless you send it more\.|finished\. It cannot receive follow-up messages\.|was stopped before it finished\.|ran out of room before it finished\.|declined the task\.|failed before it finished\.|ended abnormally \([^\r\n)]*\) before it finished\.)/.exec(text)
      alias = prefix?.[1]
      const summary = field('summary')
      let body = prefix ? text.slice(prefix[0].length) : summary && text.startsWith(summary) ? text.slice(summary.length) : text
      if (!status && prefix) {
        const line = prefix[2]
        status = line.startsWith('finished') ? 'completed' : line.startsWith('was stopped') ? 'aborted'
          : line.startsWith('ran out') ? 'max-tokens' : line.startsWith('declined') ? 'refusal'
          : line.startsWith('failed') ? 'error' : 'unknown'
      }
      omitted = /^\s*It sent you a message just before finishing, so its closing message is omitted\./.test(body)
      // Native notices have a dedicated marker block. Preserve significant Markdown
      // whitespace at the beginning of the following answer (e.g. an indented code block).
      if (content[1]?.type === 'text' && content[1].text === 'Its closing message:' && body.startsWith(content[1].text))
        body = body.slice(content[1].text.length)
      else body = body.replace(/^\s*(?:Its closing message:|It left no closing message\.|It sent you a message just before finishing, so its closing message is omitted\.)[ \t]*(?:\r?\n)?/, '')
      first.text = body
    } else {
      const prefix = /^Agent ([^\r\n]{1,256}?) sent a message:[ \t]?/.exec(text)
      alias = prefix?.[1]
      first.text = prefix ? text.slice(prefix[0].length) : text
    }
    first.text = first.text.replace(/^\s*这条通知触发了本轮回复。[ \t]*(?:\r?\n|$)/, '')
  }
  return { senderId: field('senderSessionId') ?? field('senderId'), senderName: field('senderName') ?? alias, parts, settled, status, omitted }
}

type Message = NonNullable<ReturnType<typeof teamMessage>>
function isEmptyCompletion(message: Message) {
  return message.omitted && (!message.status || message.status === 'completed')
    && !message.parts.some(part => 'block' in part || part.text.trim())
}

const statusLabels: Readonly<Partial<Record<string, Parameters<Text>[0]>>> = {
  completed: 'reportCompleted', aborted: 'reportAborted', error: 'reportError',
  'max-tokens': 'reportLimit', refusal: 'reportRefused',
}

function ReportBody({ message, t, id, clamp }: { clamp: boolean; message: Message; t: Text; id: string }) {
  const content = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false), [full, setFull] = useState(false)
  useLayoutEffect(() => {
    if (!clamp) return
    const element = content.current!
    const measure = () => setLong(element.getBoundingClientRect().height > 260)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' && new ResizeObserver(measure)
    if (observer) observer.observe(element)
    return () => { if (observer) observer.disconnect() }
  }, [message, clamp])
  return <div id={id} className="rt-report">
    <div className="rt-report-window" data-full={!clamp || (long && full) || undefined} id={id + '-body'}>
      <div className="rt-team-trigger-body" ref={content}>
        {message.omitted && <small>{t('reportAlreadySent')}</small>}
        {message.parts.map((part, i) => 'text' in part
          ? part.text.trim() && <MarkdownText key={i} text={part.text} omitHtml labels={{
            code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes'),
          }} /> : <pre key={i}>{JSON.stringify(part.block, null, 2)?.slice(0, 8000)}</pre>)}
      </div>
    </div>
    {long && <footer data-clamped={!full || undefined}><button type="button" aria-controls={id + '-body'} aria-expanded={full}
      onClick={() => setFull(!full)}>{t(full ? 'reportCollapse' : 'reportExpand')}</button></footer>}
  </div>
}

export function TeamMessageCard({ message, name, time, t, fromParent = false }: { fromParent?: boolean; message: Message; name: string; time: number; t: Text }) {
  const [open, setOpen] = useState(fromParent)
  const id = useId()
  const date = new Date(time)
  const title = t('messageFrom').replace('{name}', () => name)
  const status = message.status && Object.hasOwn(statusLabels, message.status) ? statusLabels[message.status] : undefined
  const markdown = fromParent ? '' : message.parts.flatMap(part => 'text' in part ? [part.text] : []).join('\n')
  const summary = useMemo(() => fromParent ? '' : extractMarkdownPlainText(markdown, { mode: 'first-line' }), [fromParent, markdown])
  const alert = ['aborted', 'error', 'refusal'].includes(message.status ?? '')
  return <section className="rt-team-trigger" data-turn-trigger data-alert={alert || undefined} data-status={message.status}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className="rt-report-sender">{title}{message.settled && <span className="rt-report-status">{' · ' + t(status ?? 'reportEnded')}</span>}</span>
      {!open && !fromParent && <span className="rt-report-summary">{summary}</span>}
      <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <IconChevronDownOutlineRegular size={12} />
    </button>
    {open && <ReportBody clamp={fromParent} id={id} message={message} t={t} />}
  </section>
}

function syncSnapshot({ source, content }: Input, t: Text) {
  if (!source || typeof source !== 'object' || !('kind' in source) ||
      (source.kind !== 'team-policy' && source.kind !== 'team-brief')) return null
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (source.kind === 'team-policy') {
    const mode = Reflect.get(source, 'mode')
    const name = mode === 'custom' ? 'policyCustom' : mode === 'balanced' ? 'policyBalanced' : 'policyDelegate'
    return { policy: true, title: t('policySynced') + ' · ' + t(name),
      body: text.replace(/^<team-leader-policy\b[^>]*>\r?\n?/, '').replace(/\r?\n?<\/team-leader-policy>\s*$/, '') }
  }
  const body = text
    .replace(/^<team-brief-update\b[^>]*>\r?\n?/, '').replace(/\r?\n?<\/team-brief-update>\s*$/, '')
    .replace(/^(?:说明：用户最新直接指令的优先级始终高于本简报。|Note: The user’s latest direct instruction always overrides this brief\.)\r?\n/, '')
  return { body, policy: false, title: t('briefSynced') + ' · ' + t(Reflect.get(source, 'updatedBy') === 'leader' ? 'briefUpdatedByLeader' : 'briefUpdatedByUser') }
}

function SyncNotice({ notice, time, t }: { notice: NonNullable<ReturnType<typeof syncSnapshot>>; time: number; t: Text }) {
  const [open, setOpen] = useState(false)
  const id = useId(), date = new Date(time)
  return <section className="rt-team-trigger" data-brief-notice={!notice.policy || undefined} data-policy-notice={notice.policy || undefined}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>{notice.title}</span>
      <time dateTime={date.toISOString()}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <IconChevronDownOutlineRegular size={12}/>
    </button>
    {open && <div id={id} className="rt-team-trigger-body"><MarkdownText text={notice.body} omitHtml labels={{
      code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes'),
    }}/></div>}
  </section>
}

export function registerTeamTrigger(ctx: Context, call: Ui['call'], t: Text) {
  const slot = 'conversation.chat.node'
  // Several historical cards can share a sender. Share the lookup while it is in flight.
  const pending = new Map<string, Promise<Sender>>()
  function Report({ message, sessionId, time, fallback, moved }: {
    message: Message; sessionId: string; time: number; fallback: ReactNode; moved?: boolean
  }) {
    const { senderId, senderName } = message
    const key = JSON.stringify([sessionId, senderId, senderName])
    const [resolved, resolve] = useState<{ key: string; sender: Sender }>()
    useEffect(() => {
      let live = true
      let lookup = pending.get(key)
      if (!lookup) {
        lookup = call('teamMessageSender', { sessionId, senderId, senderName }).finally(() => pending.delete(key))
        pending.set(key, lookup)
      }
      lookup.then(sender => { if (live) resolve({ key, sender }) }, () => { if (live) resolve({ key, sender: null }) })
      return () => { live = false }
    }, [key, sessionId, senderId, senderName])
    if (resolved?.key !== key || !resolved.sender) return fallback
    if (moved || isEmptyCompletion(message)) return null
    const alias = senderName && !/^(?:role-|rt-(?:root|child)-|lead$)/.test(senderName) ? senderName : undefined
    return <TeamMessageCard fromParent={resolved.sender.fromParent} message={message} name={resolved.sender.name ?? alias ?? t('messageMember')} time={time} t={t} />
  }

  // Only move context rows inside the native fold range. Partially loaded turns
  // without a visible process controller keep their reports at the original seat.
  function inProcess(seq: number, { node, turnProcess }: Pick<Props<NodeKind>, 'node' | 'turnProcess'>) {
    const loc = node.location
    if (!turnProcess || (loc.kind !== 'turn' && loc.kind !== 'step') || !(loc.turn.start || loc.turn.end)) return false
    const { processStartSeq, answerAnchorSeq } = turnProcess.spec
    return seq >= processStartSeq && (loc.turn.status !== 'closed' || answerAnchorSeq === null || seq < answerAnchorSeq)
  }

  function ProcessReports(props: Props<'turn-process'>) {
    const { node, useChat, sessionId } = props
    const source = useChat(s => s.nodes.turnDataSource(node.data.turn, 'context'))
    const rows = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const latest = new Map<string, Message>()
    const entries = rows.filter(row => inProcess(row.seq, props))
      .map(row => ({ row, message: teamMessage(row) }))
      .filter(({ message }) => {
        if (!message) return true
        const key = message.senderId ? 'id:' + message.senderId : message.senderName && 'name:' + message.senderName
        if (!key) return true
        if (!message.settled) {
          latest.set(key, message)
          return true
        }
        const report = latest.get(key)
        if (!report || !isEmptyCompletion(message)) return true
        report.settled = true
        report.status = 'completed'
        return false
      })
    return <>{entries.map(({ row, message }) => {
      const notice = syncSnapshot(row, t)
      if (notice) return <SyncNotice key={row.seq} notice={notice} time={row.time} t={t}/>
      return message && <Report key={row.seq} message={message} sessionId={sessionId} time={row.time} fallback={null} />
    })}</>
  }

  function register<K extends NodeKind>(key: K, render: (props: Props<K>, native: ReactNode) => ReactNode) {
    function Routed(props: Props<K>) {
      const entry = ctx.slots.entries(slot).find(e => e.options.key === key && e.locale === 'chat' && e.component !== Routed)
      const Native = entry?.component as ComponentType<Props<K>> | undefined
      const native = Native ? <Native {...props} /> : null
      return /^rt-(root|child)-/.test(props.sessionId) ? render(props, native) : native
    }
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: -1, locale: 'chat' }, Routed))
  }
  register('turn-process', (props, native) => <>{native}<ProcessReports {...props} /></>)
  for (const key of ['turn-trigger', 'context'] as const) {
    register(key, (props, native) => {
      const { data } = props.node
      const notice = syncSnapshot(data, t)
      if (notice) return props.node.kind === 'context' && inProcess(data.seq, props)
        ? null : <SyncNotice notice={notice} time={data.time} t={t}/>
      const message = teamMessage(data)
      return message ? <Report message={message} sessionId={props.sessionId} time={data.time} fallback={native}
        moved={props.node.kind === 'context' && inProcess(data.seq, props)} /> : native
    })
  }
}
