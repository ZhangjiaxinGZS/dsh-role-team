import { useState } from 'react'
import { fileId } from '../../shared/index.js'
import { Modal, Notice, useAction, useLoad, useUi, type Training } from '../ui.js'
import { SessionPane, sessionTarget } from '../workbench/SessionPane.js'

function DebriefTeamField({ value, select }: { value: string; select: (id: string) => void }) {
  const { t, call } = useUi(),
    teams = useLoad('debrief-teams', () => call('listTeams', {}))
  return (
    <>
      <label>
        {t('sourceTeam')}
        <select value={value} onChange={(e) => select(e.target.value)}>
          <option value="">{t('none')}</option>
          {teams.data
            ?.filter((r) => r.status === 'active')
            .map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.title}
              </option>
            ))}
        </select>
      </label>
      <Notice>{teams.error}</Notice>
    </>
  )
}
export function TrainingDialog({
  debriefRoleId,
  close,
  done,
}: {
  debriefRoleId?: string
  close: () => void
  done: (row: Training) => void
}) {
  const { t, call } = useUi(),
    a = useAction(),
    [id, setId] = useState(''),
    [run, setRun] = useState('')
  return (
    <Modal title={t(debriefRoleId ? 'debrief' : 'trainNew')} close={close} locked={a.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void a.run(async () => {
            const request = debriefRoleId
              ? { roleId: debriefRoleId, mode: 'debrief' as const, ...(run && { sourceRunId: run }) }
              : { roleId: fileId.parse(id.trim()), mode: 'create' as const }
            done(await call('createTraining', request))
          })
        }}
      >
        {debriefRoleId ? (
          <DebriefTeamField value={run} select={setRun} />
        ) : (
          <label>
            {t('roleId')}
            <input required autoFocus value={id} onChange={(e) => setId(e.target.value)} />
          </label>
        )}
        <Notice>{a.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={a.busy || (!debriefRoleId && !id.trim())}>
            {t('startTraining')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
export function TrainingPanel({
  roleId,
  initialId,
  hasRole,
  changed,
}: {
  roleId: string
  initialId?: string
  hasRole: boolean
  changed: () => void
}) {
  const { t, call } = useUi(),
    list = useLoad(roleId + ':' + initialId, () => call('listTrainings', { roleId })),
    [selected, setSelected] = useState(initialId ?? ''),
    [debrief, setDebrief] = useState(false),
    start = useAction()
  const opened = (row: Training) => {
    setSelected(row.trainingId)
    setDebrief(false)
    list.refresh()
  }
  const id = selected || list.data?.[0]?.trainingId
  return (
    <section className="rt-training">
      <header>
        <h3>{t('training')}</h3>
        <div className="rt-row">
          {hasRole && (
            <button onClick={() => setDebrief(true)} disabled={start.busy}>
              {t('debrief')}
            </button>
          )}
          <button
            className="rt-primary"
            disabled={start.busy}
            onClick={() =>
              start.run(async () =>
                opened(await call('createTraining', { roleId, mode: hasRole ? 'coach' : 'create' })),
              )
            }
          >
            {t(hasRole ? 'newTraining' : 'trainNew')}
          </button>
        </div>
      </header>
      <Notice>{list.error || start.error}</Notice>
      {id && (
        <>
          <select
            aria-label={t('trainingSession')}
            value={id}
            onChange={(e) => setSelected(e.target.value)}
          >
            {list.data?.map((x) => (
              <option key={x.trainingId} value={x.trainingId}>
                {t(x.mode === 'create' ? 'createMode' : x.mode)} · {x.trainingId.slice(-8)}
              </option>
            ))}
          </select>
          <TrainingDetail key={id} trainingId={id} changed={changed} />
        </>
      )}
      {debrief && (
        <TrainingDialog debriefRoleId={roleId} close={() => setDebrief(false)} done={opened} />
      )}
    </section>
  )
}
export function TrainingDetail({ trainingId, changed }: { trainingId: string; changed: () => void }) {
  const { t, call } = useUi(),
    record = useLoad(trainingId, () => call('getTraining', { trainingId }), 1800),
    a = useAction()
  const row = record.data,
    pending = row?.proposals?.filter((p) => p.status === 'pending')
  const review = (proposalId: string, approve: boolean) =>
    a.run(async () => {
      if (approve) {
        const result = await call('confirmProposal', { trainingId, proposalId })
        if (!result.ok)
          throw new Error(
            result.code === 'invalid'
              ? result.error.file +
                ' · ' +
                t('line') +
                ' ' +
                result.error.line +
                ' · ' +
                result.error.message
              : t('conflict') + ' · ' + t('resolveConf'),
          )
        changed()
      } else await call('rejectProposal', { trainingId, proposalId })
      record.refresh()
    })
  return (
    <>
      <Notice>{record.error || a.error}</Notice>
      {row && (
        <>
          <SessionPane target={sessionTarget(row.sessionId)} />
          <section className="rt-proposals">
            <h4>
              {t('proposals')} <small>{pending?.length ?? 0}</small>
            </h4>
            {pending?.map((p) => (
              <article key={p.id}>
                <strong>{p.memoryId ? 'memories/' + p.memoryId + '.md' : 'role.md'}</strong>
                <pre>{p.diff}</pre>
                <div className="rt-row">
                  <button className="rt-primary" disabled={a.busy} onClick={() => review(p.id, true)}>
                    {t('approve')}
                  </button>
                  <button disabled={a.busy} onClick={() => review(p.id, false)}>
                    {t('reject')}
                  </button>
                </div>
              </article>
            ))}
            {!pending?.length && <small>{t('noProposals')}</small>}
          </section>
        </>
      )}
    </>
  )
}
