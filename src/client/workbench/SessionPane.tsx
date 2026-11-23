import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  Menu,
  Tooltip,
  IconDataOutlineRegular,
  IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ModelChoice } from '../../shared/index.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsRuntime,
  PropsRenderFactories,
  PropsRenderSlots,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSessionHeaderSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { useUi, Notice, useLoad, useAction, type Seat, type SessionTarget } from '../ui.js'

export type Pane = {
  target: SessionTarget
  seat?: Seat
  leaderSessionId?: string
  readOnly?: boolean
  onSelection?: () => void
  focusOnOpen?: boolean
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
  focusOnOpen,
}: Pane) {
  const { SessionProvider, chat, t, preview } = useUi()
  const { reference, error, retry } = useRetainedSession(target)
  const id = targetId(target)
  useEffect(() => () => preview?.leave(id), [preview, id])
  const preparePreview = (event: React.SyntheticEvent<HTMLElement>) => {
    const element = event.target
    if (!(element instanceof Element) || !event.currentTarget.contains(element)) return
    // Host Markdown and tool rows expose contextual URL/file targets as focusable
    // links or file buttons. Leave composer, trajectory and ordinary controls alone.
    if (element.closest('a[href], [data-ref-chip="file"], [data-chat-flow] button[tabindex="0"], [data-presented-file] button[title]')) {
      preview?.activate(target)
    }
  }
  const container = useRef<HTMLElement>(null)
  useEffect(() => {
    const pane = container.current
    if (!focusOnOpen || !reference || !pane) return
    const focusEditor = () => {
      const editor = pane.querySelector<HTMLElement>('[data-composer-input]')
      if (!editor) return false
      const active = document.activeElement
      if (
        editor.getClientRects().length &&
        (!active ||
          active === document.body ||
          active.matches(
            '.rt-top button, .rt-rolelist .rt-list-row > button, .rt-rolelist header button, .rt-detail > header .rt-primary, .rt-pane-status button',
          ))
      ) {
        editor.focus({ preventScroll: true })
      }
      return true
    }
    if (focusEditor()) return
    const observer = new MutationObserver(() => {
      if (focusEditor()) observer.disconnect()
    })
    observer.observe(pane, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [focusOnOpen, reference])
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
      <section
        ref={container}
        className="rt-session"
        onClickCapture={preparePreview}
        onContextMenuCapture={preparePreview}
        onKeyDownCapture={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) preparePreview(event)
        }}
        aria-label={readOnly ? t('readOnly') : undefined}
      >
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
// Instantiated by the DSH renderer underneath the retained reference, including its scoped interaction hook.
export function SessionChat(
  props: PropsRuntime<'roleTeam.chat'> &
    PropsRenderFactories &
    Pick<
      ConversationSessionHeaderSlotProps,
      'actions' | 'selectView' | 'useStore' | 'useConversationViews'
    >,
) {
  const factoryInput = {
    variant: 'embedded',
    hero: false,
    phase: 'active',
    onWorkspaceSelected: async () => {},
  } as const
  const { reference, seat, readOnly } = useContext(PaneContext)!
  const tabs = props
    .useConversationViews((views) => views)
    .filter((view) => view.id === 'chat' || view.id === 'trajectory')
  const selected = props.useStore((state) => state.view) ?? 'chat'
  function selectView(view: string) {
    props.selectView(view)
    if (view !== 'trajectory' || selected === view) return
    // Focus the last dispatched call in this pane. The native ledger can otherwise open
    // on session setup rows, with the tool and its result outside the visible page.
    const entries = reference.binding.eventSource.getSnapshot().entries
    const latest = entries.findLast(
      ({ event }) => event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start',
    )?.event
    if (latest?.type === 'tool/call') props.actions.openView(view, String(latest.data.callId))
    if (latest?.type === 'tool/ptc-dispatch-start') props.actions.openView(view, latest.data.subCallId)
  }
  if (props.sessionId !== reference.sessionId) throw new Error('Mismatched SessionProvider')
  return (
    <div
      className="rt-chat"
      data-read-only={readOnly || undefined}
      data-child={seat?.parentSeatId ? true : undefined}
    >
      <div className="rt-transcript">
        <div className="rt-session-bar">
          <SessionPreset {...props} readOnly={readOnly} />
          {tabs.length > 1 && (
            <div className="rt-view-navigation rt-segment" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === selected}
                  onClick={() => selectView(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {props.renderFactorySlot('conversation.content', factoryInput)}
      </div>
    </div>
  )
}

function SessionPreset({
  sessionId,
  readOnly,
  useProjection,
  useSession,
}: PropsRuntime<'roleTeam.chat'> & { readOnly: boolean }) {
  const { presets, t } = useUi()
  const catalog = useLoad('presets', async () => (await presets?.list()) ?? [])
  const current = useProjection('agentPreset')
  const blank = useSession((s) => s.blank && !s.running && !s.awaitingFirstTurn && !s.removed)
  const [open, setOpen] = useState(false)
  const action = useAction()
  const options = catalog.data ?? []
  const selected =
    options.find((p) => p.id === current) ?? (!current ? options.find((p) => p.isDefault) : undefined)
  const label = selected?.label ?? current
  if (!label) return <Notice>{catalog.error}</Notice>
  if (!blank || readOnly || !presets) return <small className="rt-preset-label">{label}</small>
  return (
    <>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        portal
        align="start"
        selectedId={selected?.id}
        items={options.map((p) => ({ id: p.id, label: p.label, disabled: !!p.broken }))}
        onSelect={(id) => {
          setOpen(false)
          void action.run(async () => {
            await presets.select(sessionId, id)
          })
        }}
        anchor={
          <button
            className="rt-preset-button"
            aria-label={t('agentMode') + ' · ' + label}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={action.busy || !options.length}
            onClick={() => setOpen(!open)}
          >
            {label}
            <IconChevronDownOutlineRegular size={12} />
          </button>
        }
      />
      <Notice>{action.error || catalog.error}</Notice>
    </>
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
