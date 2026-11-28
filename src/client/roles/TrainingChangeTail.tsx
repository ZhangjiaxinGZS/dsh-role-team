import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useMemo, useSyncExternalStore } from 'react'
import { trainingChanges, type Receipt } from './training-change-events.js'
import type { Ui } from '../ui.js'
import { DiffLines, fieldLabels } from './RoleDiffView.js'

type Tail = PropsRuntime<'conversation.chat.turnTail'>
export function TrainingChangeCard({ receipts, t, language = 'en' }: Pick<Ui, 't' | 'language'> & { receipts: Receipt[] }) {
  if (!receipts.length) return null
  const versions = [...new Set(receipts.flatMap(r => r.revision ? ['v' + r.revision] : []))]
  return <section className="rt-change-card" aria-label={t('savedUpdates')}>
    <header><strong>{t('savedUpdates')}</strong>{versions.length > 0 && <small>{versions.join(' · ')}</small>}</header>
    <p>{[...new Set(receipts.map(r => r.summary[language]))].join(' · ')}</p>
    {receipts.flatMap(r => r.changes.map((change, index) =>
      <details key={r.callId + '/' + index}>
        <summary><b>{t(fieldLabels[change.field])}</b>{'title' in change && <span>{change.title}</span>}</summary>
        {'hunks' in change ? <DiffLines hunks={change.hunks} /> :
          <div className="rt-saved-text">{'savedText' in change ? change.savedText || '—' : change.body}</div>}
      </details>))}
  </section>
}

export function registerTrainingChangeTail(ctx: Context, ui: Pick<Ui, 't' | 'language'>) {
  function TrainingTail({ turn, useChat }: Tail) {
    const native = useChat(s => s.nodes.turnDataSource(turn.turn, 'tool-call'))
    const hidden = useChat(s => s.nodes.turnDataSource(turn.turn, 'role-team-training-change'))
    const calls = useSyncExternalStore(native.subscribe, native.getSnapshot, native.getSnapshot)
    const changes = useSyncExternalStore(hidden.subscribe, hidden.getSnapshot, hidden.getSnapshot)
    const receipts = useMemo(() => trainingChanges(calls.map(call => call.root), changes), [calls, changes])
    return <TrainingChangeCard receipts={receipts} t={ui.t} language={ui.language} />
  }
  function TailSlot(props: Tail) {
    return props.sessionId.startsWith('rt-training-') ? <TrainingTail {...props} /> : null
  }
  const slot = 'conversation.chat.turnTail'
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'dsh-role-team.training-changes' }, TailSlot))
}
