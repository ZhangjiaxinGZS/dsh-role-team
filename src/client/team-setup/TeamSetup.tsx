import { useState } from 'react'
import {
  Modal,
  PathInput,
  Notice,
  useAction,
  useLoad,
  useUi,
  type Team,
  type Run,
  type Seat,
} from '../ui.js'
export type RoleChoice = { id: string; name: string; revision: number | null }
export function TeamSetup({
  roles,
  team,
  onDone,
  close,
}: {
  roles: RoleChoice[]
  team?: Team
  onDone: (run: Run) => void
  close: () => void
}) {
  const { call, presets, t } = useUi(),
    a = useAction(),
    eligible = roles.filter((r) => r.revision !== null)
  const [name, setName] = useState(''),
    [cwd, setCwd] = useState(team?.run.workspaceCwd ?? ''),
    [leader, setLeader] = useState(eligible[0]?.id ?? '')
  const [preset, setPreset] = useState('')
  const catalog = useLoad('presets', async () => (team ? [] : ((await presets?.list()) ?? [])))
  const [selected, choose] = useState<string[]>([]),
    [parents, setParents] = useState<Record<string, string>>({}),
    [parent, setParent] = useState(team?.run.leaderSeatId ?? '')
  const [partial, setPartial] = useState<Team>(),
    [createdSeats, setCreatedSeats] = useState<Record<string, string>>({})
  const members = selected.filter((id) => id !== leader)
  const changeLeader = (id: string) => {
    setLeader(id)
    setParents({})
  }
  const create = async () => {
    if (team) {
      await call('addMember', { runId: team.run.runId, roleId: leader, parentSeatId: parent })
      onDone(team.run)
      return
    }
    const current =
      partial ??
      (await call('createTeam', {
        title: name.trim(),
        workspaceCwd: cwd.trim(),
        roleId: leader,
        ...(preset && { agentPreset: preset }),
      }))
    setPartial(current)
    const ids = { ...createdSeats, [leader]: current.run.leaderSeatId }
    for (const roleId of members) {
      if (ids[roleId]) continue
      const row = await call('addMember', {
        runId: current.run.runId,
        roleId,
        parentSeatId: ids[parents[roleId]] ?? current.run.leaderSeatId,
      })
      ids[roleId] = row.seatId
      setCreatedSeats({ ...ids })
    }
    onDone(current.run)
  }
  return (
    <Modal
      title={t(team ? 'addMember' : 'newTeam')}
      locked={a.busy}
      close={() => (partial ? onDone(partial.run) : close())}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void a.run(create)
        }}
      >
        <fieldset disabled={a.busy || !!partial}>
          {!team && (
            <>
              <label>
                {t('name')}
                <input
                  required
                  data-modal-autofocus
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <PathInput value={cwd} onChange={setCwd} />
            </>
          )}
          {!eligible.length && <p>{t('libraryFirst')}</p>}
          <label>
            {t(team ? 'role' : 'leader')}
            <select required value={leader} onChange={(e) => changeLeader(e.target.value)}>
              {eligible.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {!team && !!catalog.data?.length && (
            <label>
              {t('agentMode')}
              <select
                aria-label={t('agentMode')}
                value={preset || catalog.data.find((p) => p.isDefault)?.id || ''}
                onChange={(e) => setPreset(e.target.value)}
              >
                {catalog.data.map((p) => (
                  <option key={p.id} value={p.id} disabled={!!p.broken}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Notice>{catalog.error}</Notice>
          {team ? (
            <label>
              {t('parent')}
              <select value={parent} onChange={(e) => setParent(e.target.value)}>
                {team.seats
                  .filter((s) => s.status === 'active' && !s.joining)
                  .map((s) => (
                    <option key={s.seatId} value={s.seatId}>
                      {s.displayName}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            eligible.length > 1 && (
              <div className="rt-member-list">
                <strong>{t('addAnother')}</strong>
                {eligible
                  .filter((r) => r.id !== leader)
                  .map((r) => (
                    <div key={r.id} className="rt-row">
                      <label className="rt-check">
                        <input
                          type="checkbox"
                          checked={members.includes(r.id)}
                          onChange={(e) =>
                            choose(
                              e.target.checked
                                ? [...selected, r.id]
                                : selected.filter((x) => x !== r.id),
                            )
                          }
                        />
                        {r.name}
                      </label>
                      {members.includes(r.id) && (
                        <select
                          aria-label={r.name + ' · ' + t('parent')}
                          value={
                            members.slice(0, members.indexOf(r.id)).includes(parents[r.id])
                              ? parents[r.id]
                              : leader
                          }
                          onChange={(e) => setParents({ ...parents, [r.id]: e.target.value })}
                        >
                          {[leader, ...members.slice(0, members.indexOf(r.id))].map((id) => (
                            <option key={id} value={id}>
                              {t('parent')} · {eligible.find((r) => r.id === id)?.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
              </div>
            )
          )}
        </fieldset>
        <Notice>{a.error}</Notice>
        {partial && a.error && <p>{t('partial')}</p>}
        <footer>
          <button
            type="button"
            disabled={a.busy}
            onClick={() => (partial ? onDone(partial.run) : close())}
          >
            {t('close')}
          </button>
          <button className="rt-primary" disabled={a.busy || !leader}>
            {t(a.busy ? 'working' : partial ? 'retry' : team ? 'add' : 'create')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
