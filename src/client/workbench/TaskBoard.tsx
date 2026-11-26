import { IconChevronRightOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore } from 'react'
import type { TeamProjection, TeamTaskView } from '@deepseek-ai/dsh-agent-team/client'
import { Notice, useLoad, useUi, type Run, type Seat } from '../ui.js'
import { sessionTarget, useRetainedSession } from './SessionPane.js'

const groups = ['in_progress', 'pending', 'completed'] as const
const nothing = () => undefined
const noopSubscribe = () => () => {}

export function taskOwner(task: TeamTaskView, seats: Seat[]) {
  if (task.ownerId) {
    const exact = seats.find(s => s.currentSessionId === task.ownerId)
    if (exact) return exact
  }
  if (!task.ownerName) return
  if (task.ownerName === 'lead') return seats.find(s => !s.parentSeatId)
  const alias = task.ownerName.split('/').at(-1)
  const matches = seats.filter(s => s.nativeAgentName === alias || s.roleId === alias)
  if (matches.length === 1) return matches[0]
}

export function useTeamTasks(run: Run) {
  const { reference, error } = useRetainedSession(sessionTarget(run.rootSessionId))
  const face = reference?.binding.session.projections.faceOf('agentTeam')
  const projection = useSyncExternalStore(face?.subscribe ?? noopSubscribe, face?.getSnapshot ?? nothing) as TeamProjection | undefined
  const tasks = projection?.tasks.filter(task => task.status !== 'deleted') ?? []
  const grouped = groups.map(status => tasks.filter(task => task.status === status))
  // The host emits full task snapshots. This orders recent completions by their
  // transition even if an older task finished after a newer one.
  if (grouped[2].length > 1) {
    const completed = new Map<string, number>()
    for (const { event } of reference?.binding.eventSource.getSnapshot().entries ?? [])
      if (event.type === 'team/task' && event.data.task.status === 'completed') completed.set(event.data.task.id, event.seq)
    grouped[2].reverse().sort((a,b) => (completed.get(b.id) ?? -1) - (completed.get(a.id) ?? -1))
  }
  return { tasks, grouped, error: error || projection?.failure, loading: !reference }
}

export function TeamPreview({ run }: { run: Run }) {
  const { call, t } = useUi()
  const team = useLoad(run.runId, () => call('getTeam', { runId: run.runId }))
  const { grouped, tasks, error, loading } = useTeamTasks(run)
  const active = [...grouped[0], ...grouped[1]]
  const visible = active.length ? active.slice(0, 3) : grouped[2].slice(0, 2)
  return <section className="rt-task-preview" aria-label={t('taskBoard')}>
    <strong>{run.title}</strong>
    <Notice>{error}</Notice>
    <small>{groups.map((status, i) => t(status) + ' ' + grouped[i].length).join(' · ')}</small>
    {loading ? t('loading') : !tasks.length ? t('noTeamTasks') : visible.map(task =>
      <article key={task.id} data-status={task.status}><strong>{task.subject}</strong>
        <footer>{t(task.status)} · {taskOwner(task, team.data?.seats ?? [])?.displayName ?? task.ownerName ?? t('unassigned')}</footer>
      </article>)}
    {!loading && active.length > 3 && <small>{t('previewMoreActive').replace('{n}', String(active.length - 3))}</small>}
    {!loading && !active.length && grouped[2].length > 2 && <small>{t('previewCompletedTotal').replace('{n}', String(grouped[2].length))}</small>}
  </section>
}

type Filter = typeof groups[number] | 'allTasks'

function TaskRow({ task, tasks, seats, onOwner }: {
  task: TeamTaskView; tasks: readonly TeamTaskView[]; seats: Seat[]; onOwner: (id: string) => void
}) {
  const { t } = useUi()
  const [expanded, setExpanded] = useState(false)
  const owner = taskOwner(task, seats)
  const dependencies = task.blockedBy.map(id => tasks.find(other => other.id === id))
  const blocked = dependencies.some(dep => dep?.status !== 'completed')
  return <article className="rt-task-row">
    <div className="rt-task-summary">
      <button className="rt-task-toggle" title={task.subject} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="rt-task-status" aria-label={t(task.status)}>{({in_progress: '◐', pending: '○', completed: '✓', deleted: ''})[task.status]}</span>
        <span className="rt-task-subject">{task.subject}</span>
      </button>
      {blocked && <small title={t('blockedBy')}>{t('blocked')}</small>}
      {owner ? <button className="rt-task-owner" title={owner.displayName} onClick={() => onOwner(owner.seatId)}>{owner.displayName}</button>
        : <small className="rt-task-owner">{task.ownerName ?? t('unassigned')}</small>}
    </div>
    {expanded && <div className="rt-task-detail">
      <strong>{task.subject}</strong>
      {task.description && <p>{task.description}</p>}
      {!!dependencies.length && <small>{t('taskDependencies')} · {dependencies.map((dep, i) => dep?.subject ?? task.blockedBy[i]).join(' · ')}</small>}
    </div>}
  </article>
}

export function TaskBoard({ state, seats, onOwner, close, embedded }: {
  state: ReturnType<typeof useTeamTasks>; embedded?: boolean; seats: Seat[]; onOwner: (id: string) => void; close: () => void
}) {
  const { t } = useUi()
  const { grouped, tasks, error, loading } = state
  const [filter, setFilter] = useState<Filter>('allTasks')
  const [search, setSearch] = useState('')
  const [opened, setOpened] = useState({ in_progress: true, pending: true, completed: false })
  const [limit, setLimit] = useState(5)
  const query = search.trim().toLocaleLowerCase()
  const matching = grouped.map(list => list.filter(task =>
    !query || [task.subject, task.description, taskOwner(task, seats)?.displayName ?? task.ownerName]
      .some(text => text?.toLocaleLowerCase().includes(query))))
  function selectFilter(next: Filter) {
    setFilter(next)
    setOpened({ in_progress: true, pending: true, completed: next === 'completed' || !!query })
    setLimit(5)
  }
  return <section className="rt-task-board" data-embedded={embedded || undefined} aria-label={t('taskBoard')} onKeyDown={e => {
    if (!embedded && e.key === 'Escape') { e.stopPropagation(); close() }
  }}>
    {!embedded && <header><h3>{t('taskBoard')}</h3><button className="rt-icon" aria-label={t('close')} title={t('close')} onClick={close}><IconCloseOutlineRegular size={16}/></button></header>}
    <input type="search" aria-label={t('searchTasks')} placeholder={t('searchTasks')} value={search} onChange={e => {
      setSearch(e.target.value); setLimit(5)
      setOpened({ in_progress: true, pending: true, completed: !!e.target.value.trim() || filter === 'completed' })
    }} />
    <div className="rt-task-filters">{(['allTasks', ...groups] as const).map(key =>
      <button key={key} aria-pressed={key === filter} onClick={() => selectFilter(key)}>{t(key)}</button>)}</div>
    <Notice>{error}</Notice>
    <div className="rt-task-results">
      {loading ? t('loading') : !tasks.length ? t('noTeamTasks') :
        !matching.some((list, i) => list.length && (filter === 'allTasks' || filter === groups[i])) ? t('noMatchingTasks') :
        groups.map((status, i) => {
          if (filter !== 'allTasks' && filter !== status || !matching[i].length) return null
          const list = matching[i]
          return <section key={status} className="rt-task-group">
            <button className="rt-task-heading" aria-expanded={opened[status]} onClick={() => {
              setOpened({ ...opened, [status]: !opened[status] })
              if (status === 'completed') setLimit(5)
            }}>
              <IconChevronRightOutlineRegular size={12}/>{t(status)} ({list.length})
            </button>
            {opened[status] && <>
              {(status === 'completed' ? list.slice(0, limit) : list).map(task =>
                <TaskRow key={task.id} task={task} tasks={tasks} seats={seats} onOwner={onOwner}/>)}
              {status === 'completed' && list.length > limit && <button className="rt-task-more" onClick={() => setLimit(limit + 5)}>{t('moreTasks')}</button>}
            </>}
          </section>
        })}
    </div>
  </section>
}
