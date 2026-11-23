import { useState } from 'react'
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
  const [collapsed, setCollapsed] = useState(false),
    [archive, setArchive] = useState<Run>()
  const action = useAction()
  const list = runs.data ?? [],
    active = list.filter((r) => r.status === 'active')
  const id = selected || active[0]?.runId || list.find((r) => r.status === 'archived')?.runId
  const toggle = (
    <button
      className="rt-icon"
      title={t(collapsed ? 'expandTeams' : 'collapseTeams')}
      aria-label={t(collapsed ? 'expandTeams' : 'collapseTeams')}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed(!collapsed)}
    >
      ☰
    </button>
  )
  const teamRow = (r: Run) => (
    <div key={r.runId} className="rt-team-item">
      <button aria-current={id === r.runId ? 'page' : undefined} onClick={() => setSelected(r.runId)}>
        {r.title}
      </button>
      {r.status === 'active' && (
        <button
          title={t('archiveTeam')}
          aria-label={t('archiveTeam') + ' · ' + r.title}
          onClick={() => {
            action.clear()
            setArchive(r)
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="M2 2.5h12v3H2zM3.5 5.5v8h9v-8M6 8h4" />
          </svg>
        </button>
      )}
    </div>
  )
  return (
    <section className="rt-work">
      {!collapsed && (
        <aside className="rt-team-list" aria-label={t('teamsList')}>
          <header>
            <h3>{t('teamsList')}</h3>
            <button title={t('newTeam')} aria-label={t('newTeam')} onClick={() => setSetup(true)}>
              ＋
            </button>
          </header>
          {active.map(teamRow)}
          {list.some((r) => r.status === 'archived') && (
            <details>
              <summary>{t('archive')}</summary>
              {list.filter((r) => r.status === 'archived').map(teamRow)}
            </details>
          )}
        </aside>
      )}
      <div className="rt-board">
        <Notice>{runs.error}</Notice>
        {id ? (
          <TeamBoard key={id} id={id} roles={roles} toggle={toggle} />
        ) : (
          <>
            <div className="rt-controls">{toggle}</div>
            <div className="rt-empty">
              <h2>{t(runs.data ? 'emptyTeams' : 'loading')}</h2>
              <button className="rt-primary" onClick={() => setSetup(true)}>
                {t('newTeam')}
              </button>
            </div>
          </>
        )}
      </div>
      {archive && (
        <Modal title={t('archiveTeam')} close={() => setArchive(undefined)} locked={action.busy}>
          <p>
            {archive.title} · {t('archiveTeamHint')}
          </p>
          <Notice>{action.error}</Notice>
          <footer>
            <button disabled={action.busy} onClick={() => setArchive(undefined)}>
              {t('cancel')}
            </button>
            <button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await call('archiveTeam', { runId: archive.runId })
                  setSelected(active.find((r) => r.runId !== archive.runId)?.runId ?? '')
                  setArchive(undefined)
                  runs.refresh()
                })
              }
            >
              {t('archiveTeam')}
            </button>
          </footer>
        </Modal>
      )}
      {setup && (
        <TeamSetup
          roles={roles}
          close={() => setSetup(false)}
          onDone={(r) => {
            setSelected(r.runId)
            runs.refresh()
            setSetup(false)
          }}
        />
      )}
    </section>
  )
}
function TeamBoard({ id, roles, toggle }: { id: string; roles: RoleChoice[]; toggle: React.ReactNode }) {
  const { call, t } = useUi(),
    team = useLoad(id, () => call('getTeam', { runId: id }), 2500)
  const [single, setSingle] = useState(false),
    [focus, setFocus] = useState(''),
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
      <header className="rt-controls">
        <div className="rt-team-navigation">
          {toggle}
          <strong title={data.run.title}>{data.run.title}</strong>
          <div className="rt-segment">
            {(['columns', 'focus'] as const).map((k, i) => (
              <button aria-pressed={single === !!i} key={k} onClick={() => setSingle(!!i)}>
                {t(k)}
              </button>
            ))}
          </div>
          {single && (
            <div className="rt-chips">
              {seats.map((s) => (
                <button
                  key={s.seatId}
                  className="rt-chip"
                  aria-pressed={target === s.seatId}
                  onClick={() => setFocus(s.seatId)}
                >
                  {s.parentSeatId === null ? '♛ ' : ''}
                  {s.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="rt-add-member" disabled={!active} onClick={() => setAdd(true)}>
          ＋ {t('addMember')}
        </button>
      </header>
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
  return (
    <article className="rt-column" id={'seat-' + s.seatId}>
      <header>
        <Avatar name={s.displayName} />
        <div className="rt-grow">
          <h3>
            {s.displayName} {!parent && <span aria-label={t('leader')}>♛</span>}
          </h3>
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
                    {g.archivedAt && new Date(g.archivedAt).toLocaleString() + ' · '}
                    {t('readOnly')}
                  </option>
                ))}
            </select>
          </label>
          <Notice>{history.error}</Notice>
        </div>
      )}
      {s.status === 'resetting' && !version ? (
        <div className="rt-pane-status">
          {t('resetting')} <button onClick={() => setReset(true)}>{t('retryReset')}</button>
        </div>
      ) : (
        <SessionPane
          target={sessionTarget(version || s.currentSessionId, parent?.currentSessionId)}
          leaderSessionId={team.run.rootSessionId}
          onSelection={refresh}
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
