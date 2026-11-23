import { useState } from 'react'
import { Notice, useAction, useLoad, useUi, type Training } from '../ui.js'
import { SessionPane, sessionTarget } from '../workbench/SessionPane.js'

export function TrainingPanel({
  roleId,
  initialId,
  hasRole,
  empty,
  changed,
}: {
  roleId: string
  initialId?: string
  empty?: boolean
  hasRole: boolean
  changed: () => void
}) {
  const { t, call } = useUi(),
    list = useLoad(roleId + ':' + initialId, () => call('listTrainings', { roleId }), 2400),
    [selected, setSelected] = useState(initialId ?? ''),
    start = useAction()
  const opened = (row: Training) => {
    setSelected(row.trainingId)
    list.refresh()
  }
  const latest = list.data?.at(-1)?.trainingId
  const id = latest || selected
  return (
    <section className="rt-training">
      <header>
        <h3>{t('training')}</h3>
        <div className="rt-row">
          <button
            className="rt-primary"
            title={t('freshChatHint')}
            disabled={start.busy}
            onClick={() =>
              start.run(async () =>
                opened(await call('createTraining', { roleId, mode: hasRole ? 'coach' : 'create' })),
              )
            }
          >
            {t('newTraining')}
          </button>
        </div>
      </header>
      <Notice>{list.error || start.error}</Notice>
      {(!id || empty) && <p className="rt-intro">{t('firstTopic')}</p>}
      {id && <TrainingDetail key={id} trainingId={id} changed={changed} />}
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
          <SessionPane target={sessionTarget(row.sessionId)} onToolResult={changed} />
          {!!pending?.length && (
            <section className="rt-proposals">
              <h4>
                {t('proposals')} <small>{pending?.length ?? 0}</small>
              </h4>
              {pending?.map((p) => (
                <article key={p.id}>
                  <strong>{t(p.memoryId ? 'memories' : 'card')}</strong>
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
            </section>
          )}
        </>
      )}
    </>
  )
}
