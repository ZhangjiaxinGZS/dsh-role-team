import { PaneDivider, paneStyle, usePaneWidths } from '../PaneDivider.js'
import { useNavigation } from '../navigation.js'
import {
  IconChevronRightOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  Button,
  Menu,
  IconChevronDownOutlineRegular,
  IconSettingsOutlineRegular,
  IconFullscreenOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Fragment, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
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
    runs = useLoad('runs', () => call('listTeams', { includeMemberCounts: true }))
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
  const listSize = usePaneWidths('teams.list')
  const teamRow = (r: (typeof list)[number]) => {
    const method = r.status === 'active' ? 'archiveTeam' : 'deleteTeam'
    return (
      <div key={r.runId} className="rt-list-row">
        <button title={r.title} aria-current={id === r.runId ? 'page' : undefined} onClick={() => setSelected(r.runId)}>
          {r.title}
        </button>
        {r.memberCount !== undefined && <small title={t('members')} className="rt-member-count">{r.memberCount}</small>}
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
        <aside style={paneStyle(listSize.widths.list)} className="rt-team-list rt-list" aria-label={t('teamsList')}>
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
      {!collapsed && <PaneDivider label={t('teamsList')} kind="list" pane="list" resize={listSize.resize} />}
      <div className="rt-board">
        <Notice>{runs.error}</Notice>
        {id ? (
          <TeamBoard key={id} id={id} roles={roles} toggle={toggle} onMembersChanged={runs.refresh} />
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
function TeamBoard({ id, roles, toggle, onMembersChanged }: {
  id: string; roles: RoleChoice[]; toggle: React.ReactNode; onMembersChanged: () => void
}) {
  const { call, t } = useUi(),
    team = useLoad(id, () => call('getTeam', { runId: id }), 2500)
  const [layout, setLayout] = useNavigation('layout'),
    [focus, setFocus] = useState(''),
    [add, setAdd] = useState(false)
  const single = layout === 'focus'
  const [settings, showSettings] = useState(false)
  const board = useRef<HTMLDivElement>(null)
  const defaults = usePaneWidths('workbench')
  const width = Math.min(960, Math.max(320, defaults.widths.column ?? 480))
  const columns = usePaneWidths('team.' + id + '.members')
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
    target = seats.some(s => s.seatId === focus) ? focus : data.run.leaderSeatId
  function pickSeat(seatId: string) {
    setFocus(seatId)
    if (single) return
    const container = board.current
    const item = Array.from(container?.children ?? []).find(el => el.getAttribute('data-seat') === seatId)
    item?.scrollIntoView?.({
      block: 'nearest', inline: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }
  function changeWidth(value: number | null) {
    defaults.resize({ column: value }, true)
    const overrides = Object.keys(columns.widths)
    if (overrides.length) columns.resize(Object.fromEntries(overrides.map(key => [key, null])), true)
  }
  return (
    <>
      <Notice>{team.error}</Notice>
      <header className="rt-controls">
        <div className="rt-team-navigation">
          {toggle}
          <strong title={data.run.title}>{data.run.title}</strong>
          <div className="rt-segment">
            {(['columns', 'focus'] as const).map(k => (
              <button aria-pressed={layout === k} key={k} onClick={() => setLayout(k)}>
                {t(k)}
              </button>
            ))}
          </div>
        </div>
        <button aria-label={t('addMember')} title={t('addMember')} className="rt-add-member" disabled={!active} onClick={() => setAdd(true)}>
          <IconPlusOutlineRegular size={14} /><span>{t('addMember')}</span>
        </button>
        <button className="rt-icon" title={t('boardSettings')} aria-label={t('boardSettings')} onClick={() => showSettings(true)}>
          <IconSettingsOutlineRegular size={16} />
        </button>
      </header>
      <MemberBar seats={seats} active={active} target={target} pickSeat={pickSeat} />
      {settings && <Modal title={t('boardSettings')} close={() => showSettings(false)}>
        <div className="rt-width-settings">
          <label htmlFor="rt-column-width">{t('columnWidth')} <output htmlFor="rt-column-width">{width} px</output></label>
          <input id="rt-column-width" type="range" min={320} max={960} step={10} value={width}
            onChange={e => changeWidth(e.currentTarget.valueAsNumber)} />
          <div className="rt-row">
            {([[360, 'compactWidth'], [480, 'comfortableWidth'], [640, 'wideWidth']] as const).map(([px, key]) =>
              <button key={key} aria-pressed={width === px} onClick={() => changeWidth(px)}>{t(key)}</button>)}
            <button onClick={() => changeWidth(null)}>{t('restoreWidth')}</button>
          </div>
        </div>
      </Modal>}
      <div className="rt-floor">
        <div ref={board} className={'rt-columns' + (single ? ' rt-single' : '')}
          style={{
            '--rt-column-width': defaults.widths.column ? width + 'px' : undefined,
            '--rt-count': Math.max(1, seats.length),
          } as React.CSSProperties}>
          {seats
            .filter((s) => !single || s.seatId === target)
            .map((s, index) => (
              <Fragment key={s.seatId}>
                {!single && index > 0 && (
                  <PaneDivider kind="members" label={seats[index - 1].displayName + ' / ' + s.displayName}
                    pane={seats[index - 1].seatId} neighbor={s.seatId} resize={columns.resize} />
                )}
                <MemberColumn
                  width={columns.widths[s.seatId]}
                  seat={s}
                  team={data}
                  refresh={team.refresh}
                  single={single}
                  toggleFocus={() => {
                    setFocus(s.seatId)
                    setLayout('focus')
                  }}
                />
              </Fragment>
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
            onMembersChanged()
          }}
        />
      )}
    </>
  )
}
function MemberBar({ seats, active, target, pickSeat }: {
  seats: Seat[]; active: boolean; target: string; pickSeat: (id: string) => void
}) {
  const { t } = useUi()
  const chips = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [picker, showPicker] = useState(false)
  useLayoutEffect(() => {
    const strip = chips.current!, content = track.current!, bar = row.current!
    const edges = () => {
      strip.toggleAttribute('data-before', strip.scrollLeft > 1)
      strip.toggleAttribute('data-after', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
    }
    const measure = () => {
      // Compare against the whole row so the menu cannot cause its own overflow.
      const exceeds = content.scrollWidth > bar.clientWidth
      setOverflow(exceeds)
      if (!exceeds) showPicker(false)
      edges()
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
      const before = strip.scrollLeft
      strip.scrollLeft += event.deltaY * unit
      if (strip.scrollLeft !== before) event.preventDefault()
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    for (const element of [bar, strip, content]) observer?.observe(element)
    strip.addEventListener('scroll', edges)
    strip.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer?.disconnect()
      strip.removeEventListener('scroll', edges)
      strip.removeEventListener('wheel', wheel)
    }
  }, [])
  function select(id: string) {
    showPicker(false)
    pickSeat(id)
    const chip = Array.from(track.current?.children ?? []).find(el => el.getAttribute('data-seat') === id)
    chip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <nav ref={row} className="rt-member-bar" aria-label={t('members')}>
      <div className="rt-chips" ref={chips}>
        <div className="rt-chip-track" ref={track}>
          {seats.map(s => (
            <button key={s.seatId} className="rt-chip" data-seat={s.seatId} title={s.displayName}
              aria-pressed={target === s.seatId} onClick={() => select(s.seatId)}>
              <SeatLabel seat={s} active={active} />
            </button>
          ))}
        </div>
      </div>
      {overflow && <Menu open={picker} align="end" portal autoFocus selectedId={target}
        anchor={<button className="rt-picker" aria-haspopup="menu" aria-expanded={picker} onClick={() => showPicker(!picker)}>
          {t('allMembers')} ({seats.length}) <IconChevronDownOutlineRegular size={12} />
        </button>}
        items={picker ? seats.map(s => ({
          id: s.seatId,
          label: <span className="rt-menu-member"><SeatLabel seat={s} active={active} /></span>,
        })) : []}
        onClose={() => showPicker(false)} onSelect={select} />}
    </nav>
  )
}
const emptySubscribe = () => () => {}
function SeatLabel({ seat, active }: { seat: Seat; active: boolean }) {
  const { t, sessionStatus } = useUi()
  const status = useSyncExternalStore(sessionStatus?.subscribe ?? emptySubscribe, () => {
    const value = active && sessionStatus?.getSnapshot().get(seat.currentSessionId as SessionId)
    if (value && value.pendingInteraction?.kind === 'approval') return 'seatApproval'
    return value && value.running ? 'seatWorking' : 'seatIdle'
  })
  return <>
    <span className="rt-seat-dot" data-status={status} role="img" aria-label={t(status)} title={t(status)} />
    <span className="rt-seat-name" title={seat.displayName}>{seat.displayName}</span>
    {seat.parentSeatId === null && <span className="rt-lead-badge">{t('leader')}</span>}
  </>
}
function MemberColumn({
  seat: s,
  width,
  team,
  refresh,
  single,
  toggleFocus,
}: {
  seat: Seat
  width?: number
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
    <article style={paneStyle(width)} className="rt-column" data-seat={s.seatId} id={'seat-' + s.seatId}>
      {!single && (
        <header>
          <div className="rt-grow">
            <h3><SeatLabel seat={s} active={!readOnly} /></h3>
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
