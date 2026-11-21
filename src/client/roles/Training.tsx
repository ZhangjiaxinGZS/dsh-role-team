import { useState } from 'react'
import { fileId } from '../../shared/index.js'
import { Modal, Notice, PathInput, useAction, useLoad, useUi, type Training } from '../ui.js'
import { SessionPane, sessionTarget } from '../workbench/SessionPane.js'

export function TrainingDialog({
  role,
  close,
  done,
}: {
  role?: string
  close: () => void
  done: (row: Training) => void
}) {
  const { t, call } = useUi(),
    a = useAction(),
    [id, setId] = useState(role ?? ''),
    [cwd, setCwd] = useState(''),
    [mode, setMode] = useState<Training['mode']>(role ? 'coach' : 'create'),
    [run, setRun] = useState('')
  const teams = useLoad('training-runs', () => call('listTeams', {}))
  return (
    <Modal title={t(role ? 'newTraining' : 'trainNew')} close={close} locked={a.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void a.run(async () =>
            done(
              await call('createTraining', {
                roleId: fileId.parse(id),
                mode,
                workspaceCwd: cwd.trim(),
                ...(run && { sourceRunId: run }),
              }),
            ),
          )
        }}
      >
        {!role && (
          <label>
            {t('roleId')}
            <input required value={id} onChange={(e) => setId(e.target.value)} />
          </label>
        )}
        {role && (
          <label>
            {t('mode')}
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              {(['coach', 'debrief', 'create'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(k === 'create' ? 'createMode' : k)}
                </option>
              ))}
            </select>
          </label>
        )}
        <PathInput value={cwd} onChange={setCwd} />
        <label>
          {t('sourceTeam')}
          <select value={run} onChange={(e) => setRun(e.target.value)}>
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
        <Notice>{a.error || teams.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={a.busy}>
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
  changed,
}: {
  roleId: string
  initialId?: string
  changed: () => void
}) {
  const { t, call } = useUi(),
    list = useLoad(roleId + ':' + initialId, () => call('listTrainings', { roleId })),
    [selected, setSelected] = useState(initialId ?? ''),
    [show, setShow] = useState(false)
  const id = selected || list.data?.[0]?.trainingId
  return (
    <section className="rt-training">
      <header>
        <h3>{t('training')}</h3>
        <button onClick={() => setShow(true)}>＋ {t('newTraining')}</button>
      </header>
      <Notice>{list.error}</Notice>
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
      {show && (
        <TrainingDialog
          role={roleId}
          close={() => setShow(false)}
          done={(row) => {
            setSelected(row.trainingId)
            setShow(false)
            list.refresh()
          }}
        />
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
