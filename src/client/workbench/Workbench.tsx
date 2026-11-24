import { useNavigation } from '../navigation.js'
import {
  IconChevronRightOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  Button,
  IconFullscreenOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import {
  MoreMenu,
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
  const [selected, setSelected] = useNavigation('team'),
    [setup, setSetup] = useState(false)
  const [collapsed, setCollapsed] = useState(false),
    [confirm, setConfirm] = useState<{ run: Run; method: 'archiveTeam' | 'deleteTeam' }>()
  const action = useAction()
  const list = runs.data ?? [],
    active = list.filter((r) => r.status === 'active')
  const id = selected === '' ? undefined : list.find((r) => r.runId === selected)?.runId ?? active[0]?.runId
  const toggle = (
    <button
      className="rt-icon"
      title={t(collapsed ? 'expandTeams' : 'collapseTeams')}
      aria-label={t(collapsed ? 'expandTeams' : 'collapseTeams')}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed(!collapsed)}
    >
      <IconPanelLeftOutlineRegular size={16} />
    </button>
  )
  const teamRow = (r: Run) => {
    const method = r.status === 'active' ? 'archiveTeam' : 'deleteTeam'
    return (
      <div key={r.runId} className="rt-list-row">
        <button aria-current={id === r.runId ? 'page' : undefined} onClick={() => setSelected(r.runId)}>
          {r.title}
        </button>
        <MoreMenu
          name={r.title}
          actions={{ [method]: () => { action.clear(); setConfirm({ run: r, method }) } }}
        />
      </div>
    )
  }
  return (
    <section className="rt-work">
      {!collapsed && (
        <aside className="rt-team-list rt-list" aria-label={t('teamsList')}>
          <header>
            <h3>{t('teamsList')}</h3>
            <button
              className="rt-icon"
              title={t('newTeam')}
              aria-label={t('newTeam')}
              onClick={() => setSetup(true)}
            >
              <IconPlusOutlineRegular size={16} />
            </button>
          </header>
          {active.map(teamRow)}
          {list.some((r) => r.status === 'archived') && (
            <details>
              <summary>
                <IconChevronRightOutlineRegular size={14} />
                {t('archive')}
              </summary>
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
              <h2>{t(!runs.data ? 'loading' : active.length ? 'selectTeam' : 'emptyTeams')}</h2>
              <button className="rt-primary" onClick={() => setSetup(true)}>
                {t('newTeam')}
              </button>
            </div>
          </>
        )}
      </div>
      {confirm && (
        <Modal title={t(confirm.method)} close={() => setConfirm(undefined)} locked={action.busy}>
          <p>{confirm.run.title} · {t(confirm.method === 'deleteTeam' ? 'deleteTeamHint' : 'archiveTeamHint')}</p>
          <Notice>{action.error}</Notice>
          <footer>
            <button data-modal-autofocus disabled={action.busy} onClick={() => setConfirm(undefined)}>
              {t('cancel')}
            </button>
            <button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await call(confirm.method, { runId: confirm.run.runId })
                  if (id === confirm.run.runId) {
                    const next = confirm.method === 'archiveTeam' && active.find((r) => r.runId !== id)
                    setSelected(next ? next.runId : '')
                  }
                  setConfirm(undefined)
                  runs.refresh()
                })
              }
            >
              {t(confirm.method)}
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
          <IconPlusOutlineRegular size={14} /> {t('addMember')}
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
  const { t } = useUi(), [reset, setReset] = useState(false)
  const parent = team.seats.find((row) => row.seatId === s.parentSeatId)
  const readOnly = s.status === 'archived' || team.run.status !== 'active'
  const canReset = !readOnly && s.status === 'active' && !s.joining && !!parent &&
    !team.seats.some((child) => child.parentSeatId === s.seatId && child.status !== 'archived')
  return (
    <article className="rt-column" id={'seat-' + s.seatId}>
      {!single && (
        <header>
          <div className="rt-grow">
            <h3>{s.displayName} {!parent && <span aria-label={t('leader')}>♛</span>}</h3>
          </div>
          <button className="rt-icon" title={t('focus')} aria-label={t('focus')} onClick={toggleFocus}>
            <IconFullscreenOutlineRegular size={16} />
          </button>
          {canReset && (
            <button className="rt-icon" title={t('reset')} aria-label={t('reset')} onClick={() => setReset(true)}>
              <IconRefreshOutlineRegular size={16} />
            </button>
          )}
        </header>
      )}
      {s.status === 'resetting' && !readOnly ? (
        <div className="rt-pane-status">
          {t('resetting')} <button onClick={() => setReset(true)}>{t('retryReset')}</button>
        </div>
      ) : (
        <SessionPane
          target={sessionTarget(s.currentSessionId, parent?.currentSessionId)}
          toolbarActions={single && canReset && (
            <div className="rt-chat-actions">
              <Button variant="outline" size="sm" onClick={() => setReset(true)}>{t('reset')}</Button>
            </div>
          )}
          defaultPreview={single || s.seatId === team.run.leaderSeatId}
          leaderSessionId={team.run.rootSessionId}
          onSelection={refresh}
          readOnly={readOnly}
          seat={s}
        />
      )}
      {reset && (
        <SeatResetModal
          seat={s}
          close={() => setReset(false)}
          done={() => {
            setReset(false)
            refresh()
          }}
        />
      )}
    </article>
  )
}
export function SeatResetModal({
  seat,
  close,
  done,
}: {
  seat: Seat
  close: () => void
  done: () => void
}) {
  const { t, call } = useUi(),
    a = useAction(),
    [handoff, write] = useState(seat.reset?.handoff ?? '')
  return (
    <Modal title={t('reset')} close={close} locked={a.busy}>
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
    </Modal>
  )
}
