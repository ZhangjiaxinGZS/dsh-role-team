import type { FieldChange } from '../../shared/role-diff.js'
import type { Labels, Ui } from '../ui.js'

export const fieldLabels = { name: 'name', body: 'body', summary: 'duty', defaultModel: 'defaultModel',
  defaultPermission: 'defaultPermission', otherSettings: 'otherSettings',
  newExperience: 'newExperience', revisedExperience: 'revisedExperience' } as const satisfies Record<string, Labels>

export function DiffLines({ hunks }: Pick<FieldChange, 'hunks'>) {
  return <div className="rt-diff-lines">{hunks.map((h, i) =>
    <pre key={i}>{h.lines.map((line, j) => <span key={j} data-sign={line[0]}>{line}</span>)}</pre>)}</div>
}

export function RoleDiffView({ changes, t }: { changes: FieldChange[]; t: Ui['t'] }) {
  return changes.length ? <div className="rt-field-diffs">{changes.map(change =>
    <section key={change.field}><h4>{t(fieldLabels[change.field])}</h4><DiffLines hunks={change.hunks} /></section>)}</div>
    : <p>{t('noProfileChanges')}</p>
}
