import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { useUi, type Seat, type Team } from '../ui.js'
import { BriefPanel, type BriefGuard } from './BriefPanel.js'
import { TaskBoard, type useTeamTasks } from './TaskBoard.js'
import { SchedulePanel, useTeamSchedules } from './SchedulePanel.js'

const tabs = ['brief', 'tasks', 'schedules'] as const
type Tab = typeof tabs[number]
const storageKey = 'dsh-role-team:drawer-tab'
function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(storageKey)
    return tabs.find(tab => tab === saved) ?? 'brief'
  }
  catch { return 'brief' }
}

export interface DrawerHandle { requestClose(): void }
export const TeamDrawer = forwardRef<DrawerHandle, {
  team: Team; seats: Seat[]; tasks: ReturnType<typeof useTeamTasks>; close(): void; onOwner(id: string): void
}>(function TeamDrawer({ team, seats, tasks, close, onOwner }, ref) {
  const { t } = useUi()
  const id = useId()
  const [tab, setTab] = useState(initialTab)
  const guard = useRef<BriefGuard>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const available = team.capabilities?.schedules !== false
  const schedules = useTeamSchedules(team.run.runId, available)
  const counts = { brief: 0, tasks: tasks.grouped[0].length + tasks.grouped[1].length,
    schedules: available ? schedules.data?.filter(s => s.status === 'active').length ?? 0 : 0 }

  const leave = useCallback((action: () => void) => guard.current ? guard.current(action) : action(), [])
  const requestClose = useCallback(() => leave(close), [leave, close])
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose])
  useEffect(() => {
    tabList.current?.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus()
  }, [])
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role=dialog]')) {
        e.preventDefault()
        requestClose()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [requestClose])

  function select(next: Tab) {
    if (next === tab) return
    leave(() => {
      setTab(next)
      try { localStorage.setItem(storageKey, next) } catch { /* This window uses in-memory state. */ }
      tabList.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    })
  }
  return <aside className="rt-team-drawer" aria-label={t('teamPanel')}>
    <header><div className="rt-segment" role="tablist" aria-label={t('teamPanel')} ref={tabList}>
      {tabs.map((key, i) => <button key={key} role="tab" data-tab={key} id={id + key} aria-controls={id + '-page'} aria-selected={key === tab} tabIndex={key === tab ? 0 : -1}
        onClick={() => select(key)} onKeyDown={e => {
          const next = e.key === 'ArrowRight' ? tabs[(i + 1) % 3] : e.key === 'ArrowLeft' ? tabs[(i + 2) % 3]
            : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[2] : undefined
          if (next) { e.preventDefault(); select(next) }
        }}>{t(`${key}Tab`)}{counts[key] > 0 && <span className="rt-badge">{counts[key]}</span>}</button>)}
    </div><button className="rt-icon" aria-label={t('close')} onClick={requestClose}><IconCloseOutlineRegular size={16}/></button></header>
    <div role="tabpanel" id={id + '-page'} aria-labelledby={id + tab} className="rt-drawer-page" data-page={tab}>
      {tab === 'brief' && <BriefPanel run={team.run} guard={guard}/>}
      {tab === 'tasks' && <TaskBoard embedded state={tasks} seats={seats} onOwner={onOwner} close={close}/>}
      {tab === 'schedules' && <SchedulePanel runId={team.run.runId} active={team.run.status === 'active'} available={available} tasks={schedules}/>}
    </div>
  </aside>
})
