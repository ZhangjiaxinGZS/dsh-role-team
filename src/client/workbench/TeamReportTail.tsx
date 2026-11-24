import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventWindow, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useState } from 'react'
import type { Ui } from '../ui.js'
import { teamMessage } from './TeamTrigger.js'

type TailProps = PropsRuntime<'conversation.chat.turnTail'>
type Receipt = { time: number; text: string }

// A child turn can finish without a notification (for example if its parent is
// offline). Only label a reply whose text actually arrived in the parent's log.
export function receivedReports(window: SessionEventWindow, child: string): Receipt[] {
  const receipts: Receipt[] = []
  const seen = new Set<string>()
  for (const { event } of window.entries) {
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []
    for (const message of messages) {
      if (message.source.kind !== 'subagent-settled' || message.source.senderSessionId !== child || seen.has(message.id)) continue
      seen.add(message.id)
      const report = teamMessage(message)
      if (!report || report.omitted || (report.status && report.status !== 'completed')) continue
      receipts.push({ time: event.time, text: report.parts.flatMap(part => 'text' in part ? [part.text] : []).join('').trim() })
    }
  }
  return receipts
}

export function registerTeamReportTail(ctx: Context, ui: Pick<Ui, 'retain' | 'call' | 't'>) {
  // All visible turns of one child share one membership check and one parent event feed.
  type Listener = (name: string, receipts: readonly Receipt[]) => void
  type Feed = { listeners: Set<Listener>; name: string; receipts: Receipt[]; release?: () => void }
  const feeds = new Map<SessionId, Feed>()
  function watch(child: SessionId, parent: SessionId, listener: Listener) {
    let feed = feeds.get(child)
    if (!feed) {
      const current: Feed = { listeners: new Set(), name: '', receipts: [] }
      feeds.set(child, current)
      feed = current
      void (async () => {
        const member = await ui.call('teamMessageSender', { sessionId: child, senderId: parent })
        const name = member?.name
        if (!name || feeds.get(child) !== current) return
        const ref: SessionReference = ui.retain(parent)
        current.release = () => ref.release()
        await ref.ready
        if (feeds.get(child) !== current) return
        const source = ref.binding.eventSource
        const update = () => {
          const window = source.getSnapshot()
          if (current.name && (window.change.kind === 'settle-assistant' || (window.change.kind === 'append' &&
              !window.change.entries.some(({ event }) => event.type === 'agent/inbox/spliced' || event.type === 'user/message')))) return
          current.name = name
          current.receipts = receivedReports(window, child)
          for (const notify of current.listeners) notify(current.name, current.receipts)
        }
        const unsubscribe = source.subscribe(update)
        current.release = () => { unsubscribe(); ref.release() }
        update()
      })().catch(() => { /* Without confirmation, leave the tail empty. */ })
    }
    feed.listeners.add(listener)
    listener(feed.name, feed.receipts)
    return () => {
      feed.listeners.delete(listener)
      if (!feed.listeners.size) { feeds.delete(child); feed.release?.() }
    }
  }

  function ChildTail({ sessionId, turn, useChat, useSession }: TailProps) {
    const parent = useSession(s => s.subagent?.address.parentSessionId)
    const text = useChat(snapshot => {
      for (const key of snapshot.locations.getTurn(turn.turn)) {
        const node = snapshot.nodes.get(key) as ChatNode | undefined
        if (node?.kind === 'turn-tail') return node.data.closing?.blocks.flatMap(b => b.kind === 'text' ? [b.text] : []).join('').trim() ?? ''
      }
      return ''
    })
    const until = useChat(snapshot => snapshot.timeline.turns.get(turn.turn + 1)?.start?.time ?? Infinity)
    const ended = turn.end?.time
    const [delivery, setDelivery] = useState<{ child: string; name: string }>()
    useEffect(() => {
      if (!parent || !text || ended === undefined) return
      return watch(sessionId, parent, (name, receipts) => {
        const received = receipts.some(r => r.time >= ended && r.time < until && r.text === text)
        setDelivery(prev => {
          if (!received) return undefined
          return prev?.child === sessionId && prev.name === name ? prev : { child: sessionId, name }
        })
      })
    }, [sessionId, parent, text, ended, until])
    return delivery?.child === sessionId && text ? <small className="rt-report-delivered">{ui.t('reportDelivered').replace('{name}', () => delivery.name)}</small> : null
  }
  function ReportTail(props: TailProps) {
    return props.sessionId.startsWith('rt-child-') && props.turn.end?.data.reason.kind === 'completed' ? <ChildTail {...props} /> : null
  }
  const slot = 'conversation.chat.turnTail'
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'dsh-role-team.report' }, ReportTail))
}
