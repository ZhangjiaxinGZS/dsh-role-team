import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useId,
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
export type Team = { run: Run; seats: Seat[] }
export type SessionTarget = Parameters<ISessions['retain']>[0]
export interface Ui {
  call<K extends keyof RoleTeamRpc>(
    method: K,
    ...args: Parameters<RoleTeamRpc[K]>
  ): ReturnType<RoleTeamRpc[K]>
  retain(target: SessionTarget): SessionReference
  SessionProvider: SessionProviderComponent
  chat(): ReactNode
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
export function useLoad<T>(key: string, read: () => Promise<T>, interval = 0) {
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
  }, [key, interval, version])
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
  const ref = useRef<HTMLDialogElement>(null),
    id = useId()
  const { t } = useUi()
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '')
    return () => {
      dialog.close?.()
      previous?.focus?.()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="rt-modal"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault()
        if (!locked) close()
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button aria-label={t('close')} disabled={locked} onClick={close} type="button">
          ×
        </button>
      </header>
      {children}
    </dialog>
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
export function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className={'rt-avatar tone-' + (Array.from(name).reduce((n, c) => n + c.codePointAt(0)!, 0) % 4)}
    >
      {Array.from(name.trim())[0]?.toUpperCase()}
    </span>
  )
}
