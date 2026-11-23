import type { ReactNode } from 'react'
import { Notice, useAction, useUi, type Training } from '../ui.js'
import { SessionPane, sessionTarget } from '../workbench/SessionPane.js'

export function TrainingDetail({
  toolbarActions,
  chatHint,
  row,
  refresh,
  changed,
}: {
  toolbarActions?: ReactNode
  chatHint?: string
  row: Training
  refresh: () => void
  changed: () => void
}) {
  const { call, t } = useUi(),
    a = useAction(),
    trainingId = row.trainingId,
    pending = row.proposals?.filter((p) => p.status === 'pending')
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
      refresh()
    })
  return (
    <>
      <Notice>{a.error}</Notice>
      <SessionPane
        toolbarActions={toolbarActions}
        chatHint={chatHint}
        focusOnOpen
        target={sessionTarget(row.sessionId)}
        onToolResult={changed}
      />
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
  )
}
