import { createContext, useContext, useEffect, useState } from 'react'
import {
  Menu,
  Tooltip,
  IconDataOutlineRegular,
  IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelChoice } from '../../shared/index.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsRuntime,
  PropsRenderFactories,
  PropsRenderSlots,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import { useUi, Notice, useLoad, useAction, type Seat, type SessionTarget } from '../ui.js'

export type Pane = {
  target: SessionTarget
  seat?: Seat
  leaderSessionId?: string
  readOnly?: boolean
  onSelection?: () => void
  onToolResult?: () => void
}
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
function useRetainedSession(target: SessionTarget) {
  const { retain } = useUi()
  const [reference, setReference] = useState<SessionReference>(),
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
  return { reference, error, retry: () => retry((v) => v + 1) }
}
function BoundPane({
  target,
  seat,
  leaderSessionId,
  readOnly = false,
  onSelection,
  onToolResult,
}: Pane) {
  const { SessionProvider, chat, t } = useUi()
  const { reference, error, retry } = useRetainedSession(target)
  useEffect(() => {
    if (!reference || !onToolResult) return
    const source = reference.binding.eventSource
    let last = source.getSnapshot().entries.at(-1)?.event.seq ?? -1
    return source.subscribe(() => {
      const entries = source.getSnapshot().entries
      const newest = entries.at(-1)?.event.seq ?? -1
      if (newest <= last) return
      const finished = entries.some(({ event }) => event.seq > last && event.type === 'tool/result')
      last = newest
      if (finished) onToolResult()
    })
  }, [reference, onToolResult])
  if (!reference || error)
    return (
      <div className="rt-pane-status">
        {error ? (
          <>
            <Notice>{error}</Notice>
            <button onClick={retry}>{t('retry')}</button>
          </>
        ) : (
          t('loading')
        )}
      </div>
    )
  return (
    <SessionProvider session={reference}>
      <section className="rt-session" aria-label={readOnly ? t('readOnly') : undefined}>
        <PaneContext.Provider
          value={{
            reference,
            seat: readOnly ? undefined : seat,
            leaderSessionId,
            onSelection,
            readOnly,
          }}
        >
          {chat()}
        </PaneContext.Provider>
      </section>
    </SessionProvider>
  )
}
const PaneContext = createContext<{
  readOnly: boolean
  reference: SessionReference
  onSelection?: () => void
  seat?: Seat
  leaderSessionId?: string
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
  const { reference, seat, readOnly } = useContext(PaneContext)!
  if (props.sessionId !== reference.sessionId) throw new Error('Mismatched SessionProvider')
  return (
    <div
      className="rt-chat"
      data-read-only={readOnly || undefined}
      data-child={seat?.parentSeatId ? true : undefined}
    >
      <div className="rt-transcript">
        {props.renderFactorySlot('conversation.content', factoryInput, { slots: { views: FixedChat } })}
      </div>
    </div>
  )
}

type PermissionSlot = PropsRuntime<'conversation.input.left'> &
  PropsRenderSlots<'roleTeam.leadPermission'>

export function ChildPermission(props: PermissionSlot) {
  const pane = useContext(PaneContext)
  if (!pane?.seat?.parentSeatId || !pane.leaderSessionId || pane.reference.sessionId !== props.sessionId)
    return null
  return (
    <LeaderPermission key={pane.leaderSessionId} {...props} leaderSessionId={pane.leaderSessionId} />
  )
}

function LeaderPermission({
  leaderSessionId,
  renderSlot,
  SessionProvider,
  useSession,
  useProjection,
}: PermissionSlot & { leaderSessionId: string }) {
  const { t } = useUi()
  const { reference, error, retry } = useRetainedSession(sessionTarget(leaderSessionId))
  const removed = useSession((s) => s.removed)
  const current = useProjection('permissions')?.currentValue
  const modes = {
    'workspace-write': t('workspaceWrite'),
    'danger-full-access': t('fullAccess'),
    'read-only': t('readOnlyMode'),
    auto: t('autoMode'),
  }
  const label = [current && (modes[current as keyof typeof modes] ?? current), t('followLeader')]
    .filter(Boolean)
    .join(' · ')
  if (error)
    return (
      <button title={error} onClick={retry}>
        {t('retry')}
      </button>
    )
  if (!reference) return null
  return (
    <Tooltip label={label} side="top" delayMs={500} portal>
      <span className="rt-permission">
        <SessionProvider session={reference}>
          {renderSlot('roleTeam.leadPermission', { locked: removed ?? true })}
        </SessionProvider>
      </span>
    </Tooltip>
  )
}

// rc.5 intentionally omits the ordinary model selector on addressed subagents.
export function ChildControls(props: PropsRuntime<'conversation.input.right'>) {
  const pane = useContext(PaneContext)
  return pane?.seat?.parentSeatId && pane.reference.sessionId === props.sessionId ? (
    <MemberSettings onSelection={pane.onSelection} seat={pane.seat} {...props} />
  ) : null
}
function MemberSettings({
  seat,
  useProjection,
  onSelection,
}: PropsRuntime<'conversation.input.right'> & {
  seat: Seat
  onSelection?: () => void
}) {
  const { t, call } = useUi(),
    action = useAction()
  const [open, toggle] = useState(false)
  const models = useLoad(seat.seatId, () => call('seatModels', {}))
  const projection = useProjection('modelSelection')
  const current = seat.selection ?? projection?.next ?? projection?.lastUsed
  const catalog = models.data ?? []
  const selected = catalog.find((m) => m.provider === current?.provider && m.model === current?.model)
  const effort = current?.reasoningEffort ?? selected?.defaultEffort
  const modelLabel = selected?.name ?? current?.model ?? t('chooseModel')
  const effortLabel = selected?.efforts.find((e) => e.id === effort)?.name ?? effort
  const choices = new Map<string, ModelChoice>()
  const modelItems = catalog.map((m) => {
    const id = JSON.stringify([m.provider, m.model])
    choices.set(id, { provider: m.provider, model: m.model, reasoningEffort: m.defaultEffort })
    return { id, label: m.name }
  })
  const effortItems =
    selected?.efforts.map((e) => {
      const id = 'effort/' + e.id
      choices.set(id, { provider: selected.provider, model: selected.model, reasoningEffort: e.id })
      return { id, label: e.name }
    }) ?? []
  const items = !modelItems.length
    ? [{ id: 'empty', label: models.error || t(models.data ? 'noModels' : 'loading'), disabled: true }]
    : [
        { id: 'models', label: t('chooseModel'), submenu: modelItems },
        ...(effortItems.length ? [{ id: 'efforts', label: t('effort'), submenu: effortItems }] : []),
      ]
  return (
    <span className="rt-child-settings">
      <Menu
        open={open}
        portal
        side="top"
        align="end"
        compact
        autoFocus
        items={items}
        selectedIds={[JSON.stringify([current?.provider, current?.model]), 'effort/' + effort]}
        onClose={() => toggle(false)}
        onSelect={(id) => {
          const selection = choices.get(id)
          if (selection)
            void action.run(async () => {
              await call('selectSeatModel', {
                seatId: seat.seatId,
                generation: seat.currentGeneration,
                selection,
              })
              onSelection?.()
              toggle(false)
            })
        }}
        anchor={
          <button
            type="button"
            className="rt-model-trigger"
            title={t('chooseModel')}
            aria-label={[modelLabel, effortLabel].filter(Boolean).join(' ')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={action.busy}
            onClick={() => {
              if (!open) models.refresh()
              toggle(!open)
            }}
          >
            <IconDataOutlineRegular className="rt-model-icon" aria-hidden="true" size={16} />
            <span>{modelLabel}</span>
            <small>{effortLabel}</small>
            <IconChevronDownOutlineRegular aria-hidden="true" size={12} />
          </button>
        }
      />
      <Notice>{action.error}</Notice>
    </span>
  )
}
