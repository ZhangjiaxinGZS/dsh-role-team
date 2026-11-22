import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TeamProjection } from '@deepseek-ai/dsh-agent-team/types'
import {
  Avatar,
  Modal,
  Notice,
  useAction,
  useLoad,
  useUi,
  type Team,
  type Seat,
  type Run,
} from '../ui.js'
import { TeamSetup, type RoleChoice } from '../team-setup/TeamSetup.js'
import { SessionPane, sessionTarget } from './SessionPane.js'

export function Workbench({ roles }: { roles: RoleChoice[] }) {
  const { call, t } = useUi(),
    runs = useLoad('runs', () => call('listTeams', {}))
  const [selected, setSelected] = useState(''),
    [setup, setSetup] = useState(false)
  const list = runs.data ?? [],
    id = selected || list.find((r) => r.status === 'active')?.runId || list[0]?.runId
  const opened = (run: Run) => {
    setSelected(run.runId)
    runs.refresh()
    setSetup(false)
  }
  return (
    <section className="rt-work">
      <header className="rt-toolbar">
        <div className="rt-heading">
          {list.length ? (
            <select
              className="rt-team-select"
              aria-label={t('chooseTeam')}
              value={id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {list.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.title}
                  {r.status === 'archived' ? ' · ' + t('archive') : ''}
                </option>
              ))}
            </select>
          ) : (
            <h2>{t('team')}</h2>
          )}
        </div>
        <button className="rt-primary" onClick={() => setSetup(true)}>
          ＋ {t('newTeam')}
        </button>
      </header>
      <Notice>{runs.error}</Notice>
      {id ? (
        <TeamBoard key={id} id={id} roles={roles} />
      ) : (
        <div className="rt-empty">
          <h2>{t(runs.data ? 'emptyTeams' : 'loading')}</h2>
          <p>{t('emptyTeamHint')}</p>
        </div>
      )}
      {setup && <TeamSetup roles={roles} close={() => setSetup(false)} onDone={opened} />}
    </section>
  )
}
function TeamBoard({ id, roles }: { id: string; roles: RoleChoice[] }) {
  const { call, t } = useUi(),
    team = useLoad(id, () => call('getTeam', { runId: id }), 2500)
  const [single, setSingle] = useState(false),
    [focus, setFocus] = useState(''),
    [drawer, setDrawer] = useState(false),
    [add, setAdd] = useState(false)
  if (!team.data)
    return (
      <div className="rt-pane-status">
        {team.error ? (
          <>
            <Notice>{team.error}</Notice>
            <button onClick={team.refresh}>{t('retry')}</button>
          </>
        ) : (
          t('loading')
        )}
      </div>
    )
  const data = team.data,
    active = data.run.status === 'active',
    seats = data.seats.filter((s) => s.status !== 'archived' || !active),
    target = focus || data.run.leaderSeatId
  return (
    <>
      <Notice>{team.error}</Notice>
      <div className="rt-roster">
        <div className="rt-chips">
          {seats.map((s) => (
            <button
              key={s.seatId}
              className="rt-chip"
              aria-pressed={target === s.seatId}
              onClick={() => {
                setFocus(s.seatId)
                if (!single)
                  document
                    .getElementById('seat-' + s.seatId)
                    ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
              }}
            >
              {s.parentSeatId === null ? '♛ ' : ''}
              {s.displayName}
              <small>G{s.currentGeneration}</small>
              {s.pendingRoleRev && <i aria-label={t('pending')} />}
            </button>
          ))}
        </div>
        <button disabled={!active} onClick={() => setAdd(true)}>
          ＋ {t('addMember')}
        </button>
      </div>
      <div className="rt-controls">
        <div className="rt-segment">
          {(['columns', 'focus'] as const).map((k, i) => (
            <button aria-pressed={single === !!i} key={k} onClick={() => setSingle(!!i)}>
              {t(k)}
            </button>
          ))}
        </div>
        <button aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
          {t('board')}
        </button>
      </div>
      <div className="rt-floor">
        <div className={'rt-columns' + (single ? ' rt-single' : '')}>
          {seats
            .filter((s) => !single || s.seatId === target)
            .map((s) => (
              <MemberColumn
                key={s.seatId}
                seat={s}
                team={data}
                refresh={team.refresh}
                single={single}
                toggleFocus={() => {
                  setFocus(s.seatId)
                  setSingle(!single)
                }}
              />
            ))}
        </div>
        {drawer && (
          <aside className="rt-drawer">
            <header>
              <h3>{t('board')}</h3>
              <button aria-label={t('close')} onClick={() => setDrawer(false)}>
                ×
              </button>
            </header>
            <Tasks root={data.run.rootSessionId} />
            <Notes run={data.run} />
          </aside>
        )}
      </div>
      {add && (
        <TeamSetup
          team={data}
          roles={roles}
          close={() => setAdd(false)}
          onDone={() => {
            setAdd(false)
            team.refresh()
          }}
        />
      )}
    </>
  )
}
function MemberColumn({
  seat: s,
  team,
  refresh,
  single,
  toggleFocus,
}: {
  seat: Seat
  team: Team
  refresh: () => void
  single: boolean
  toggleFocus: () => void
}) {
  const { call, t } = useUi(),
    a = useAction(),
    [reset, setReset] = useState(false),
    [version, setVersion] = useState(''),
    [showHistory, setHistory] = useState(false)
  const history = useLoad(s.seatId + ':' + s.currentGeneration + ':' + showHistory, () =>
    showHistory ? call('listGenerations', { seatId: s.seatId }) : Promise.resolve([]),
  )
  const parent = team.seats.find((row) => row.seatId === s.parentSeatId)
  const readOnly = !!version || s.status === 'archived' || team.run.status !== 'active'
  const protectedBy = !parent
    ? t('protectLead')
    : team.seats.some((c) => c.parentSeatId === s.seatId && c.status !== 'archived')
      ? t('protectParent')
      : ''
  const rev = s.pendingRoleRev ?? s.pendingMemoryRev
  const apply = (decision: 'keep' | 'next-turn') =>
    a.run(async () => {
      await call('versionDecision', { seatId: s.seatId, revision: rev!, decision })
      refresh()
    })
  return (
    <article className="rt-column" id={'seat-' + s.seatId}>
      <header>
        <Avatar name={s.displayName} />
        <div className="rt-grow">
          <h3>
            {s.displayName} {!parent && <span aria-label={t('leader')}>♛</span>}
          </h3>
          <small>
            {s.roleId} · G{s.currentGeneration} · r{s.adoptedRoleRev}
          </small>
        </div>
        <button
          className="rt-icon"
          title={t(single ? 'columns' : 'focus')}
          aria-label={t(single ? 'columns' : 'focus')}
          onClick={toggleFocus}
        >
          ⛶
        </button>
        <button
          className="rt-icon"
          title={t('history')}
          aria-label={t('history')}
          aria-expanded={showHistory}
          onClick={() => {
            setHistory(!showHistory)
            setVersion('')
          }}
        >
          ◷
        </button>
        <button
          className="rt-icon"
          title={protectedBy || t('reset')}
          aria-label={t('reset')}
          disabled={team.run.status !== 'active'}
          onClick={() => setReset(true)}
        >
          ↺
        </button>
      </header>
      {showHistory && (
        <div className="rt-strip">
          <label>
            {t('history')}{' '}
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="">{t('current')}</option>
              {history.data
                ?.filter((g) => g.generation < s.currentGeneration)
                .map((g) => (
                  <option key={g.sessionId} value={g.sessionId}>
                    G{g.generation} · {t('readOnly')}
                  </option>
                ))}
            </select>
          </label>
          <Notice>{history.error}</Notice>
        </div>
      )}
      {!!rev && !readOnly && (
        <div className="rt-update">
          <span>
            {t('pending')} · r{rev}
          </span>
          <button disabled={a.busy} onClick={() => apply('next-turn')}>
            {t('next')}
          </button>
          <button disabled={a.busy} onClick={() => apply('keep')}>
            {t('keep')}
          </button>
        </div>
      )}
      {s.approved && (
        <small className="rt-strip">
          {t('scheduled')} · r{s.approved.revision}
        </small>
      )}
      <Notice>{a.error}</Notice>
      {s.status === 'resetting' && !version ? (
        <div className="rt-pane-status">
          {t('resetting')} <button onClick={() => setReset(true)}>{t('retryReset')}</button>
        </div>
      ) : (
        <SessionPane
          target={sessionTarget(version || s.currentSessionId, parent?.currentSessionId)}
          permission={team.run.permissionPreset}
          readOnly={readOnly}
          seat={s}
        />
      )}
      {reset && (
        <SeatResetModal
          seat={s}
          protection={protectedBy}
          close={() => setReset(false)}
          done={() => {
            setReset(false)
            setVersion('')
            refresh()
          }}
        />
      )}
    </article>
  )
}
export function SeatResetModal({
  seat,
  protection,
  close,
  done,
}: {
  seat: Seat
  protection: string
  close: () => void
  done: () => void
}) {
  const { t, call } = useUi(),
    a = useAction(),
    [handoff, write] = useState(seat.reset?.handoff ?? '')
  return (
    <Modal title={t('reset')} close={close} locked={a.busy}>
      {protection ? (
        <p>{protection}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void a.run(async () => {
              await call('resetSeat', {
                seatId: seat.seatId,
                generation: seat.currentGeneration,
                handoff,
              })
              done()
            })
          }}
        >
          <p>{t('resetHint')}</p>
          <label>
            {t('handoff')}
            <textarea
              maxLength={8000}
              value={handoff}
              readOnly={!!seat.reset}
              onChange={(e) => write(e.target.value)}
            />
          </label>
          <Notice>{a.error}</Notice>
          <footer>
            <button type="button" onClick={close} disabled={a.busy}>
              {t('cancel')}
            </button>
            <button className="rt-primary" disabled={a.busy}>
              {t(a.busy ? 'working' : 'reset')}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  )
}
function Tasks({ root }: { root: string }) {
  const { retain } = useUi(),
    [ref, setRef] = useState<SessionReference>(),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const ref = retain(sessionTarget(root))
    ref.ready.then(
      () => {
        if (active) setRef(ref)
      },
      (err) => {
        if (active) setError(String(err))
      },
    )
    return () => {
      active = false
      ref.release()
    }
  }, [root, retain])
  return (
    <>
      <Notice>{error}</Notice>
      {ref && <TaskList reference={ref} />}
    </>
  )
}
function TaskList({ reference }: { reference: SessionReference }) {
  const { t } = useUi(),
    face = reference.binding.session.projections.faceOf('agentTeam')
  const board = useSyncExternalStore(
    (fn) => face.subscribe(fn),
    () => face.getSnapshot(),
  ) as TeamProjection | undefined
  return (
    <section>
      <h4>{t('tasks')}</h4>
      <Notice>{board?.failure}</Notice>
      {board?.tasks
        .filter((x) => x.status !== 'deleted')
        .map((task) => (
          <article key={task.id}>
            <strong>{task.subject}</strong>
            <p>{task.description}</p>
            <small>
              {task.ownerName ?? '—'} ·{' '}
              {t(
                task.status === 'pending'
                  ? 'pendingTask'
                  : task.status === 'completed'
                    ? 'completed'
                    : 'in_progress',
              )}
            </small>
          </article>
        ))}
      {!board?.tasks.some((x) => x.status !== 'deleted') && <small>{t('noTasks')}</small>}
    </section>
  )
}
function Notes({ run }: { run: Run }) {
  const { t, call } = useUi(),
    notes = useLoad(run.runId, () => call('listNotes', { runId: run.runId }), 3000),
    [content, setContent] = useState(''),
    a = useAction()
  return (
    <section>
      <h4>{t('notes')}</h4>
      {notes.data?.map((n) => (
        <article key={n.noteId}>{n.content}</article>
      ))}
      {!notes.data?.length && <small>{t('noNotes')}</small>}
      <Notice>{notes.error || a.error}</Notice>
      {run.status === 'active' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void a.run(async () => {
              await call('addNote', { runId: run.runId, content })
              setContent('')
              notes.refresh()
            })
          }}
        >
          <label>
            {t('newNote')}
            <textarea
              required
              maxLength={8000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button disabled={a.busy || !content.trim()}>{t('add')}</button>
        </form>
      )}
    </section>
  )
}
