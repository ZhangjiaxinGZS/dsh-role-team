import {
  Menu,
  Modal as NativeModal,
  IconEllipsisOutlineRegular,
  IconEditOutlineRegular,
  IconTrashOutlineRegular,
  IconArchiveOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RoleTeamRpc, IndexRecord } from '../shared/index.js'
import type en from '../../locales/en-US.json'

export type Labels = keyof typeof en.ui
export type Seat = IndexRecord<'team_seats'>
export type Run = IndexRecord<'team_runs'>
export type Training = IndexRecord<'training_sessions'>
export type Team = { run: Run; seats: Seat[]; formalSessionIds?: string[]; capabilities?: { schedules: boolean } }
export type SessionTarget = Parameters<ISessions['retain']>[0]
export type PreviewState = 'unavailable' | 'closed' | 'open'
export interface WorkspacePreview {
  activate(target: SessionTarget): void
  leave(id: string): void
  setDefault(target: SessionTarget): () => void
  subscribe(listener: () => void): () => void
  state(): PreviewState
  shortcut(): { readonly keys?: readonly string[]; readonly aria?: string } | undefined
  toggle(): void
}
export interface Ui {
  language?: 'zh' | 'en'
  call<K extends keyof RoleTeamRpc>(
    method: K,
    ...args: Parameters<RoleTeamRpc[K]>
  ): ReturnType<RoleTeamRpc[K]>
  retain(target: SessionTarget): SessionReference
  sessionList: ISessions['list']
  SessionProvider: SessionProviderComponent
  sessionStatus?: import('@deepseek-ai/dsh-client-ui-session/client').UiSession['sessionStatus']
  preview?: WorkspacePreview
  chat(): ReactNode
  presets?: {
    list(): Promise<{ id: string; label: string; isDefault: boolean; broken?: string }[]>
    select(sessionId: SessionReference['sessionId'], preset: string): Promise<string>
  }
  permissions?: {
    list(): Promise<{ options: { value: string; name: string }[]; defaultPreset: string } | null>
  }
  pick?: () => Promise<string | null>
  settings?: {
    read(): Promise<{ revision: number; writable: boolean }>
    write(path: string, revision: number): Promise<void>
  }
  t: (key: Labels) => string
}
export const Client = createContext<Ui | null>(null)
export function useUi() {
  const ctx = useContext(Client)
  if (!ctx) throw new Error('Missing role team client')
  return ctx
}
export function unwrap<T>(r: RemoteResult<T>): T {
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
export function useAction() {
  const lock = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return { busy, error, run, clear: () => setError('') }
}
/** Keep only results for the visible identity. Overlapping refreshes cannot publish stale data. */
export function useLoad<T>(key: string, read: () => Promise<T>, interval = 0, revision?: string) {
  const reader = useRef(read)
  reader.current = read
  const sequence = useRef(0),
    [version, setVersion] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    let alive = true,
      pending = false
    const refresh = async () => {
      if (pending) return
      const seq = ++sequence.current
      pending = true
      try {
        const data = await reader.current()
        if (alive && seq === sequence.current) setState({ key, data })
      } catch (e) {
        if (alive && seq === sequence.current)
          setState((last) => ({
            key,
            data: last.key === key ? last.data : undefined,
            error: String(e instanceof Error ? e.message : e),
          }))
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = interval
      ? window.setInterval(() => {
          if (!document.hidden) void refresh()
        }, interval)
      : undefined
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [key, interval, version, revision])
  return {
    ...(state.key === key ? state : {}),
    refresh: useCallback(() => setVersion((v) => v + 1), []),
  }
}
export function Notice({ children }: { children?: ReactNode }) {
  return children ? (
    <div className="rt-error" role="alert">
      {children}
    </div>
  ) : null
}
export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useUi()
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number>()
  useEffect(() => () => window.clearTimeout(resetTimer.current), [])
  const copy = (button: HTMLButtonElement) => {
    void navigator.clipboard?.writeText(text).then(() => {
      if (!button.isConnected) return
      window.clearTimeout(resetTimer.current)
      setCopied(true)
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return <button type="button" disabled={!navigator.clipboard?.writeText} onClick={e => copy(e.currentTarget)}>
    {copied ? t('copiedPath') : label}
  </button>
}
export function Modal({
  title,
  children,
  close,
  locked = false,
}: {
  title: string
  children: ReactNode
  close: () => void
  locked?: boolean
}) {
  const { t } = useUi()
  return (
    <NativeModal
      open
      title={title}
      closeLabel={t('close')}
      onClose={() => {
        if (!locked) close()
      }}
      className="rt-modal"
      contentClassName="rt-modal-content"
    >
      {children}
    </NativeModal>
  )
}
type MenuAction = 'deleteRole' | 'deleteTeam' | 'archiveTeam' | 'edit' | 'deleteMemory'
const actionIcons = {
  deleteRole: IconTrashOutlineRegular,
  deleteTeam: IconTrashOutlineRegular,
  archiveTeam: IconArchiveOutlineRegular,
  edit: IconEditOutlineRegular,
  deleteMemory: IconTrashOutlineRegular,
}
export function MoreMenu({
  name,
  actions,
}: {
  name: string
  actions: Partial<Record<MenuAction, () => void>>
}) {
  const { t } = useUi()
  const [open, setOpen] = useState(false)
  const label = t('moreActions') + ' · ' + name
  return (
    <Menu
      open={open}
      align="end"
      portal
      autoFocus
      anchor={
        <button
          type="button"
          className="rt-icon"
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <IconEllipsisOutlineRegular size={16} />
        </button>
      }
      items={(Object.keys(actions) as MenuAction[]).map((id) => {
        const Icon = actionIcons[id]
        return {
          id,
          label: t(id),
          icon: <Icon size={16} />,
          danger: id === 'deleteRole' || id === 'deleteTeam' || id === 'deleteMemory',
        }
      })}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        actions[id as MenuAction]?.()
      }}
    />
  )
}
export function PathInput({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const { t, pick } = useUi(),
    a = useAction()
  return (
    <>
      <label>
        {t('directory')}
        <span className="rt-inline">
          <input
            required
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="/workspace/project"
          />
          {pick && (
            <button
              type="button"
              disabled={a.busy}
              onClick={() =>
                a.run(async () => {
                  const path = await pick()
                  if (path) onChange(path)
                })
              }
            >
              {t('browse')}
            </button>
          )}
        </span>
      </label>
      <small>{t('dirHint')}</small>
      <Notice>{a.error}</Notice>
    </>
  )
}
