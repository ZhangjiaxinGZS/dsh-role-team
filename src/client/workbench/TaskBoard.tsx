import { useSyncExternalStore } from 'react'
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

export function TeamPreview({ run }: { run: Run }) {
  const { call } = useUi()
  const team = useLoad(run.runId, () => call('getTeam', { runId: run.runId }))
  return <TaskBoard run={run} seats={team.data?.seats ?? []} />
}

export function TaskBoard({ run, seats, onOwner }: {
  run: Run; seats: Seat[]; onOwner?: (id: string) => void
}) {
  const { t } = useUi()
  const { reference, error } = useRetainedSession(sessionTarget(run.rootSessionId))
  const face = reference?.binding.session.projections.faceOf('agentTeam')
  const projection = useSyncExternalStore(face?.subscribe ?? noopSubscribe, face?.getSnapshot ?? nothing) as TeamProjection | undefined
  const tasks = projection?.tasks ?? []
  const grouped = groups.map(status => tasks.filter(task => task.status === status))
  const preview = !onOwner
  // The host emits full task snapshots. This orders recent completions by their
  // transition even if an older task finished after a newer one.
  if (grouped[2].length > 1 && preview) {
    const completed = new Map<string, number>()
    for (const { event } of reference?.binding.eventSource.getSnapshot().entries ?? [])
      if (event.type === 'team/task' && event.data.task.status === 'completed') completed.set(event.data.task.id, event.seq)
    grouped[2].reverse().sort((a,b) => (completed.get(b.id) ?? -1) - (completed.get(a.id) ?? -1))
  }
  let remaining = preview ? 5 : Infinity
  return <section className={preview ? 'rt-task-preview' : 'rt-task-board'} aria-label={t('taskBoard')}>
    {preview && <strong>{run.title}</strong>}
    <Notice>{error || projection?.failure}</Notice>
    {preview && <small>{groups.map((status,i) => t(status) + ' ' + grouped[i].length).join(' · ')}</small>}
    {!reference ? t('loading') : tasks.length === 0 ? <p>{t('noTeamTasks')}</p> :
      <div className="rt-task-groups">{groups.map((status,i) => {
        const list = grouped[i].slice(0, remaining)
        remaining -= list.length
        if (!list.length && preview) return null
        return <section key={status} className="rt-task-group">
          {!preview && <h3>{t(status)} <small>{grouped[i].length}</small></h3>}
          {list.map(task => {
            const owner = taskOwner(task, seats)
            const blockers = task.blockedBy.map(id => tasks.find(t => t.id === id)).filter(b => b && b.status !== 'completed')
            return <article key={task.id}>
              <strong>{task.subject}</strong>
              {!preview && task.description && <p>{task.description}</p>}
              <footer>{preview && <span>{t(status)}</span>}
                {owner && onOwner ? <button onClick={() => onOwner(owner.seatId)}>{owner.displayName}</button>
                  : <span>{owner?.displayName ?? task.ownerName ?? t('unassigned')}</span>}
              </footer>
              {!preview && !!blockers.length && <small>{t('blockedBy')} · {blockers.map(b => b!.subject).join(' · ')}</small>}
            </article>
          })}
        </section>
      })}</div>}
  </section>
}
