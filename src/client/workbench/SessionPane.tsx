import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { ModelChoice } from '../../shared/index.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import { useUi, Modal, Notice, useLoad, useAction, type Seat, type SessionTarget } from '../ui.js'

export type Pane = { target: SessionTarget; seat?: Seat; permission?: string; readOnly?: boolean }
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
function BoundPane({ target, seat, permission, readOnly = false }: Pane) {
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
          <PaneContext.Provider value={{ reference, seat, permission }}>{chat()}</PaneContext.Provider>
        </section>
      )}
    </SessionProvider>
  )
}
const PaneContext = createContext<{
  reference: SessionReference
  seat?: Seat
  permission?: string
} | null>(null)
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
  return (
    <div className="rt-chat" data-child={seat?.parentSeatId ? true : undefined}>
      <div className="rt-transcript">
        {props.renderFactorySlot('conversation.content', factoryInput, { slots: { views: FixedChat } })}
      </div>
    </div>
  )
}

// rc.5 intentionally omits the ordinary model selector on addressed subagents.
export function ChildControls(props: PropsRuntime<'conversation.input.right'>) {
  const pane = useContext(PaneContext)
  return pane?.seat?.parentSeatId && pane.reference.sessionId === props.sessionId ? (
    <MemberSettings permission={pane.permission} seat={pane.seat} {...props} />
  ) : null
}
function MemberSettings({
  seat,
  permission,
  useProjection,
}: PropsRuntime<'conversation.input.right'> & { seat: Seat; permission?: string }) {
  const { t, call } = useUi(),
    action = useAction()
  const [open, toggle] = useState(false)
  const models = useLoad(String(open), () => (open ? call('seatModels', {}) : Promise.resolve([])))
  const projection = useProjection('modelSelection')
  const current = seat.selection ?? projection?.next ?? projection?.lastUsed
  const permissions = useProjection('permissions') as { currentValue: string } | undefined
  const mode = permission ?? permissions?.currentValue
  const modes = {
    'workspace-write': t('workspaceWrite'),
    'danger-full-access': t('fullAccess'),
    'read-only': t('readOnlyMode'),
    auto: t('autoMode'),
  }
  const [draft, setDraft] = useState<ModelChoice>()
  const selected = models.data?.find((m) => m.provider === draft?.provider && m.model === draft?.model)
  const apply = (provider: string, model: string, reasoningEffort?: string) =>
    action.run(async () => {
      await call('selectSeatModel', {
        seatId: seat.seatId,
        generation: seat.currentGeneration,
        selection: { provider, model, reasoningEffort },
      })
      toggle(false)
    })
  return (
    <span className="rt-child-settings">
      <small title={t('followLeader')}>
        {t('followLeader')}
        {mode && ' · ' + (modes[mode as keyof typeof modes] ?? mode)}
      </small>
      <button
        type="button"
        title={t('chooseModel')}
        onClick={() => {
          setDraft(current ?? undefined)
          toggle(true)
        }}
      >
        {current?.model ?? t('chooseModel')}
        {current?.reasoningEffort && ' · ' + current.reasoningEffort} ▾
      </button>
      {open && (
        <Modal title={t('chooseModel')} close={() => toggle(false)} locked={action.busy}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (draft && selected) void apply(draft.provider, draft.model, draft.reasoningEffort)
            }}
          >
            <label>
              {t('chooseModel')}
              <select
                disabled={action.busy}
                value={selected ? JSON.stringify([selected.provider, selected.model]) : ''}
                onChange={(e) => {
                  const [provider, model] = JSON.parse(e.target.value)
                  setDraft({ provider, model })
                }}
              >
                <option value="" disabled>
                  {t('chooseModel')}
                </option>
                {models.data?.map((m) => (
                  <option
                    key={JSON.stringify([m.provider, m.model])}
                    value={JSON.stringify([m.provider, m.model])}
                  >
                    {m.provider} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            {!!selected?.efforts.length && (
              <label>
                {t('effort')}
                <select
                  disabled={action.busy}
                  value={draft?.reasoningEffort ?? ''}
                  onChange={(e) =>
                    setDraft({
                      provider: selected.provider,
                      model: selected.model,
                      reasoningEffort: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">{t('modelDefault')}</option>
                  {selected.efforts.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {models.data?.length === 0 && <small>{t('noModels')}</small>}
            <Notice>{models.error || action.error}</Notice>
            <footer>
              <button className="rt-primary" disabled={!selected || action.busy}>
                {t('save')}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </span>
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
