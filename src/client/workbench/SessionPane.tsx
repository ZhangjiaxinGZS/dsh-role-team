import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  Menu,
  Tooltip,
  IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ModelSelectInjected, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  OwnerOf,
  PropsLocale,
  PropsRuntime,
  PropsRenderFactories,
  PropsRenderSlots,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSessionHeaderSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { useUi, Notice, useLoad, useAction, type Seat, type SessionTarget } from '../ui.js'

import type {} from '@deepseek-ai/dsh-subagent/client'
import { SubagentPanel } from './SubagentPanel.js'
import { useActivity } from './activity.js'

export type Pane = {
  formalSessionIds?: readonly string[]
  target: SessionTarget
  toolbarActions?: ReactNode
  chatHint?: string
  seat?: Seat
  leaderSessionId?: string
  readOnly?: boolean
  onSelection?: () => void
  defaultPreview?: boolean
  focusOnOpen?: boolean
  onToolResult?: () => void
}
export function targetId(target: SessionTarget) {
  return typeof target === 'string' ? target : target.childSessionId
}
export const sessionTarget = (id: string, parent?: string | null, mode: Exclude<SessionTarget, string>['mode'] = 'continuable'): SessionTarget =>
  parent
    ? { parentSessionId: parent as SessionId, childSessionId: id as SessionId, mode }
    : (id as SessionId)
export function SessionPane(props: Pane) {
  return <BoundPane key={targetId(props.target)} {...props} />
}
export function useRetainedSession(target: SessionTarget) {
  const { retain } = useUi()
  const [reference, setReference] = useState<SessionReference>(),
    [error, setError] = useState(''),
    [attempt, retry] = useState(0)
  const id = targetId(target),
    parent = typeof target === 'string' ? null : target.parentSessionId,
    mode = typeof target === 'string' ? undefined : target.mode
  useEffect(() => {
    let live = true,
      ref: SessionReference | undefined
    setReference(undefined)
    setError('')
    try {
      ref = retain(sessionTarget(id, parent, mode))
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
  }, [id, parent, mode, retain, attempt])
  return { reference, error, retry: () => retry((v) => v + 1) }
}
function BoundPane({
  target,
  seat,
  leaderSessionId,
  readOnly = false,
  onSelection,
  toolbarActions,
  chatHint,
  onToolResult,
  focusOnOpen,
  formalSessionIds,
  defaultPreview = true,
}: Pane) {
  const { SessionProvider, chat, t, preview } = useUi()
  const { reference, error, retry } = useRetainedSession(target)
  const id = targetId(target)
  const parent = typeof target === 'string' ? null : target.parentSessionId,
    mode = typeof target === 'string' ? undefined : target.mode
  useEffect(() => {
    if (reference && defaultPreview) return preview?.setDefault(sessionTarget(id, parent, mode))
  }, [preview, reference, defaultPreview, id, parent, mode])
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
            '.rt-top button, .rt-rolelist .rt-list-row > button, .rt-rolelist header button, .rt-chat-actions button, .rt-pane-status button',
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
        {toolbarActions}
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
            formalSessionIds,
            seat: readOnly ? undefined : seat,
            leaderSessionId,
            onSelection,
            toolbarActions,
            chatHint,
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
  formalSessionIds?: readonly string[]
  toolbarActions?: ReactNode
  chatHint?: string
  readOnly: boolean
  reference: SessionReference
  onSelection?: () => void
  seat?: Seat
  leaderSessionId?: string
} | null>(null)
// Instantiated by the DSH renderer underneath the retained reference, including its scoped interaction hook.
export function SessionChat(
  props: PropsRuntime<'roleTeam.chat'> &
    PropsRenderSlots<'roleTeam.headerActions'> &
    PropsRenderFactories &
    Pick<
      ConversationSessionHeaderSlotProps,
      'actions' | 'selectView' | 'useStore' | 'useConversationViews'
    >,
) {
  const { t } = useUi()
  const factoryInput = {
    variant: 'embedded',
    hero: false,
    phase: 'active',
    onWorkspaceSelected: async () => {},
  } as const
  const { reference, seat, readOnly, toolbarActions, chatHint, formalSessionIds } = useContext(PaneContext)!
  const tabs = props
    .useConversationViews((views) => views)
    .filter((view) => view.id === 'chat' || view.id === 'trajectory')
  const catalog = props.useProjection('subagentCatalog')
  const children = formalSessionIds && Array.isArray(catalog) ? catalog.filter(child => !formalSessionIds.includes(child.id)) : []
  const childStatus = useActivity(children.map(child => child.id), '', true)
  const [showChildren, setShowChildren] = useState(false)
  const viewingChildren = showChildren && children.length > 0
  useEffect(() => { if (!children.length) setShowChildren(false) }, [children.length])
  const selected = props.useStore((state) => state.view) ?? 'chat'
  function selectView(view: string) {
    setShowChildren(false)
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
          {(tabs.length > 1 || children.length > 0) && (
            <div className="rt-view-navigation rt-segment" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={!viewingChildren && tab.id === selected}
                  onClick={() => selectView(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              {children.length > 0 && <button type="button" role="tab" aria-selected={viewingChildren} onClick={() => setShowChildren(true)}>
                {(childStatus === 'seatWorking' || childStatus === 'seatApproval') && <span className="rt-seat-dot" data-status={childStatus} aria-label={t(childStatus)} role="img" />}
                {t('subagents')} ({children.length})
              </button>}
            </div>
          )}
          <div className="rt-header-actions">{props.renderSlot('roleTeam.headerActions', {})}</div>
          {toolbarActions}
        </div>
        {chatHint && selected === 'chat' && <p className="rt-intro">{chatHint}</p>}
        {viewingChildren ? <SubagentPanel parent={reference.sessionId}>{children}</SubagentPanel> : props.renderFactorySlot('conversation.content', factoryInput)}
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

type NativePickerProps = ModelSelectInjected & PropsLocale<'model'> & {
  locked: boolean
  renderSlot: PropsRenderSlots<'conversation.input.model.label' | 'conversation.input.model.options'>['renderSlot']
}
export type MemberPickerBinding = {
  Picker: ComponentType<NativePickerProps>
  modelFace: (id: SessionId) => ModelSelectInjected
  loadCatalog: (leader: SessionId) => Promise<unknown>
  save: (seat: Seat, selection: ModelSelection) => ReturnType<ModelSelectInjected['select']>
}
type MemberControls = PropsRuntime<'conversation.input.right'> & PropsLocale<'model'> & MemberPickerBinding
  & PropsRenderSlots<'roleTeam.modelLabel' | 'roleTeam.modelOptions'>

export function ChildControls(props: MemberControls) {
  const pane = useContext(PaneContext)
  if (!pane?.seat?.parentSeatId || !pane.leaderSessionId || pane.reference.sessionId !== props.sessionId) return null
  return <MemberPicker {...props} seat={pane.seat} leader={pane.leaderSessionId as SessionId} onSelection={pane.onSelection} />
}

function MemberPicker({ Picker, modelFace, save, loadCatalog, seat, leader, onSelection, sessionId, useSession, t, renderSlot }:
  MemberControls & { seat: Seat; leader: SessionId; onSelection?: () => void }) {
  const face = useMemo(() => modelFace(sessionId), [modelFace, sessionId])
  const [pending, setPending] = useState<ModelSelection | null>(null)
  const [error, setError] = useState('')
  const removed = useSession(state => state.removed)
  // A sleeping seat can have a durable next model before a live child emits its projection.
  const directory = useMemo(() => {
    let last: ModelDirectoryState | undefined
    let view: ModelDirectoryState
    return {
      ...face.directory,
      subscribe: face.directory.subscribe,
      getSnapshot() {
        const source = face.directory.getSnapshot()
        if (source !== last) {
          last = source
          const current = seat.selection ?? source.current
          view = { ...source, current, pending,
            routable: current && source.status === 'ready'
              ? source.groups.some(group => group.id === current.provider && group.models.some(model => model.id === current.model))
              : source.routable }
        }
        return view
      },
    }
  }, [face.directory, seat.selection, pending])
  return <>
    <Picker {...face} available directory={directory} t={t} locked={!!removed || !!pending}
      load={() => { setError(''); void loadCatalog(leader).catch(e => setError(String(e))) }}
      select={async selection => {
        setPending(selection)
        try {
          const result = await save(seat, selection)
          if (result?.ok) onSelection?.()
          return result
        } catch (e) {
          setError(String(e))
        } finally {
          setPending(null)
        }
      }}
      renderSlot={(slot, owner, options) => slot === 'conversation.input.model.label'
        ? renderSlot('roleTeam.modelLabel', owner as unknown as OwnerOf<'roleTeam.modelLabel'>, options)
        : renderSlot('roleTeam.modelOptions', owner as unknown as OwnerOf<'roleTeam.modelOptions'>)} />
    <Notice>{error}</Notice>
  </>
}
