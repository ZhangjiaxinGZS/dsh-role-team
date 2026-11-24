import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import { useUi } from './ui.js'

type Widths = Record<string, number>
type Change = Record<string, number | null>
type Resize = (change: Change, commit: boolean) => void
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function storedWidths(key: string): Widths {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, n]) => Number.isFinite(n) && n > 0))
  } catch {
    return {}
  }
}

export function usePaneWidths(scope: string) {
  const key = 'dsh.roleTeam.widths.' + scope
  const [widths, setWidths] = useState(() => storedWidths(key))
  const resize: Resize = (change, commit) => {
    const updated = (base: Widths) => {
      const next = { ...base }
      for (const [pane, value] of Object.entries(change)) {
        if (value === null) delete next[pane]
        else next[pane] = value
      }
      return next
    }
    setWidths(updated)
    if (commit) {
      try {
        const saved = updated(storedWidths(key))
        if (Object.keys(saved).length) window.localStorage.setItem(key, JSON.stringify(saved))
        else window.localStorage.removeItem(key)
      } catch { /* Keep the current layout if browser storage is unavailable. */ }
    }
  }
  return { widths, resize }
}

export function paneStyle(width?: number): CSSProperties {
  return { '--rt-pane-width': width ? width + 'px' : undefined } as CSSProperties
}

type Kind = 'list' | 'profile' | 'members'
type Sizes = { start: number; neighbor: number; max: number }
export function PaneDivider({ label, kind, pane, neighbor, resize }: {
  label: string
  kind: Kind
  pane: string
  neighbor?: string
  resize: Resize
}) {
  const { t } = useUi()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; x: number; sizes: Sizes; change?: Change }>()
  const [dragging, setDragging] = useState(false)
  const min = kind === 'list' ? 140 : kind === 'profile' ? 310 : 300
  const [range, setRange] = useState({ now: min, max: min })
  const measure = (el: HTMLElement): Sizes => {
    const left = el.previousElementSibling?.getBoundingClientRect().width ?? 0
    const right = el.nextElementSibling?.getBoundingClientRect().width ?? 0
    const available = (el.parentElement?.clientWidth ?? 0) - 321
    const limit = kind === 'members' ? 4096 : kind === 'list' ? Math.min(340, available) : available
    return { start: kind === 'profile' ? right : left, neighbor: right, max: Math.max(min, limit) }
  }
  useLayoutEffect(() => {
    const el = ref.current!
    const sync = () => {
      const { start, max } = measure(el)
      const now = clamp(Math.round(start), min, max)
      setRange(last => last.now === now && last.max === max ? last : { now, max })
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    for (const target of [el.parentElement, el.previousElementSibling, el.nextElementSibling])
      if (target) observer.observe(target)
    return () => observer.disconnect()
  }, [kind, min, pane, neighbor])
  const changeBy = (sizes: Sizes, delta: number): Change => {
    const applied = clamp(Math.round(sizes.start + (kind === 'profile' ? -delta : delta)), min, sizes.max)
    const change: Change = { [pane]: applied }
    if (neighbor) change[neighbor] = clamp(Math.round(sizes.neighbor + sizes.start - applied), min, sizes.max)
    return change
  }
  const finish = (id: number) => {
    if (drag.current?.pointer !== id) return
    if (drag.current.change) resize(drag.current.change, true)
    drag.current = undefined
    setDragging(false)
  }
  const reset = () => resize(neighbor ? { [pane]: null, [neighbor]: null } : { [pane]: null }, true)
  return (
    <div
      className={'rt-divider rt-divider-' + kind}
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={t('resizePane') + ' · ' + label}
      title={t('resizeHint')}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={range.max}
      aria-valuenow={range.now}
      aria-valuetext={range.now + ' px'}
      data-dragging={dragging || undefined}
      onDoubleClick={reset}
      onPointerDown={e => {
        if (e.button !== 0 || drag.current) return
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { pointer: e.pointerId, x: e.clientX, sizes: measure(e.currentTarget) }
        setDragging(true)
      }}
      onPointerMove={e => {
        const active = drag.current
        if (!active || active.pointer !== e.pointerId || (!active.change && e.clientX === active.x)) return
        active.change = changeBy(active.sizes, e.clientX - active.x)
        resize(active.change, false)
      }}
      onPointerUp={e => finish(e.pointerId)}
      onLostPointerCapture={e => finish(e.pointerId)}
      onPointerCancel={e => finish(e.pointerId)}
      onKeyDown={e => {
        if (e.key === 'Home') { e.preventDefault(); reset(); return }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        resize(changeBy(measure(e.currentTarget), e.key === 'ArrowLeft' ? -16 : 16), true)
      }}
    />
  )
}
