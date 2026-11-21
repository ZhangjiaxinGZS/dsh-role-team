import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import { useUi, Notice, unwrap, useAction, type Seat, type SessionTarget } from '../ui.js'

export type Pane = { target: SessionTarget; seat?: Seat; readOnly?: boolean }
export function targetId(target: SessionTarget) {
  return typeof target === 'string' ? target : target.childSessionId
}
export const sessionTarget = (id: string, parent?: string | null): SessionTarget =>
  parent
    ? { parentSessionId: parent as SessionId, childSessionId: id as SessionId, mode: 'continuable' }
    : (id as SessionId)
export function SessionPane(props: Pane) {
  return <BoundPane key={targetId(props.target)} {...props} />
}
function BoundPane({ target, seat, readOnly = false }: Pane) {
  const { retain, SessionProvider, chat, t } = useUi(),
    [reference, setReference] = useState<SessionReference>(),
    [error, setError] = useState(''),
    [attempt, retry] = useState(0)
  const id = targetId(target),
    parent = typeof target === 'string' ? null : target.parentSessionId
  useEffect(() => {
    let live = true,
      ref: SessionReference | undefined
    setReference(undefined)
    setError('')
    try {
      ref = retain(sessionTarget(id, parent))
      const acquired = ref
      void acquired.ready.then(
        () => {
          if (live) setReference(acquired)
        },
        (e) => {
          if (live) setError(String(e))
        },
      )
    } catch (e) {
      setError(String(e))
    }
    return () => {
      live = false
      ref?.release()
    }
  }, [id, parent, retain, attempt])
  if (!reference || error)
    return (
      <div className="rt-pane-status">
        {error ? (
          <>
            <Notice>{error}</Notice>
            <button onClick={() => retry((v) => v + 1)}>{t('retry')}</button>
          </>
        ) : (
          t('loading')
        )}
      </div>
    )
  return (
    <SessionProvider session={reference}>
      {readOnly ? (
        <History reference={reference} />
      ) : (
        <section className="rt-session">
          <PaneContext.Provider value={{ reference, seat }}>{chat()}</PaneContext.Provider>
        </section>
      )}
    </SessionProvider>
  )
}
const PaneContext = createContext<{ reference: SessionReference; seat?: Seat } | null>(null)
function FixedChat({ renderSlot }: ConversationViewsProps) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}
// Instantiated by the DSH renderer underneath the retained reference, including its scoped interaction hook.
export function SessionChat(props: PropsRuntime<'roleTeam.chat'> & PropsRenderFactories) {
  const factoryInput = {
    variant: 'embedded',
    hero: false,
    phase: 'active',
    onWorkspaceSelected: async () => {},
  } as const
  const { reference, seat } = useContext(PaneContext)!
  if (props.sessionId !== reference.sessionId) throw new Error('Mismatched SessionProvider')
  const interaction = props.useSessionStatus((s) => s.get(props.sessionId)?.pendingInteraction)
  const running = props.useSession((s) => s.running)
  const model = props.useProjection('modelSelection')
  const route = model?.next ?? model?.lastUsed
  const { t, call } = useUi(),
    a = useAction(),
    stop = useAction(),
    [text, setText] = useState(''),
    [delivery, setDelivery] = useState<'queue' | 'steer'>('queue')
  const pending = useRef<{ text: string; delivery: string; requestId: string }>()
  return (
    <div className="rt-chat" data-own-composer={seat && !interaction ? 'true' : undefined}>
      {seat && route && (
        <small className="rt-model">
          {route.provider} / {route.model}
        </small>
      )}
      <div className="rt-transcript">
        {props.renderFactorySlot('conversation.content', factoryInput, { slots: { views: FixedChat } })}
      </div>
      {seat && !interaction && (
        <form
          className="rt-compose"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return
            void a.run(async () => {
              if (pending.current?.text !== text || pending.current.delivery !== delivery) {
                const requestId =
                  crypto.randomUUID?.() ??
                  Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
                    n.toString(16).padStart(2, '0'),
                  ).join('')
                pending.current = { text, delivery, requestId }
              }
              await call('promptSeat', {
                seatId: seat.seatId,
                generation: seat.currentGeneration,
                requestId: pending.current.requestId,
                text,
                delivery,
              })
              pending.current = undefined
              setText('')
            })
          }}
        >
          <textarea
            aria-label={t('message')}
            placeholder={t('message') + '…'}
            value={text}
            disabled={a.busy}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="rt-row">
            <select
              aria-label={t('message')}
              value={delivery}
              onChange={(e) => setDelivery(e.target.value as typeof delivery)}
            >
              <option value="queue">{t('queue')}</option>
              <option value="steer">{t('steer')}</option>
            </select>
            <span className="rt-grow" />
            {running && (
              <button
                type="button"
                disabled={stop.busy}
                onClick={() =>
                  stop.run(async () => {
                    unwrap(await reference.binding.session.cancel())
                  })
                }
              >
                {t('stop')}
              </button>
            )}
            <button className="rt-primary" disabled={a.busy || !text.trim()}>
              {t('send')} ↑
            </button>
          </div>
          <Notice>{a.error || stop.error}</Notice>
        </form>
      )}
    </div>
  )
}
function History({ reference }: { reference: SessionReference }) {
  const { t } = useUi(),
    a = useAction(),
    { eventSource, session } = reference.binding
  const window = useSyncExternalStore(
    (fn) => eventSource.subscribe(fn),
    () => eventSource.getSnapshot(),
  )
  const rows: ReactNode[] = []
  for (const { event } of window.entries) {
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      rows.push(
        <details key={event.seq}>
          <summary>{event.type}</summary>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </details>,
      )
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'user/message') continue
    const message = event.type === 'assistant/message' ? event.data.message : event.data
    rows.push(
      <article key={event.seq}>
        <b>{t(event.type === 'assistant/message' ? 'assistant' : 'self')}</b>
        <pre>
          {message.content
            .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b, null, 2)))
            .join('\n')}
        </pre>
      </article>,
    )
  }
  return (
    <section className="rt-history" aria-label={t('readOnly')}>
      {window.hasMore && (
        <button disabled={a.busy} onClick={() => a.run(() => session.loadOlder())}>
          {t('older')}
        </button>
      )}
      <Notice>{a.error}</Notice>
      {rows.length ? rows : <p>{t('noHistory')}</p>}
    </section>
  )
}
