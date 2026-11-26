import { projectSources, projects } from './engineering.ts'
import type { V2Scenario } from '../types.ts'
import type { AuditEvent } from './protocol.ts'
import { verify, type Evidence } from './verifier.ts'
import { catalogue } from './scenarios.ts'
export const kinds = ['reference', 'equivalent', 'spurious', 'truncated'] as const
export type Kind = (typeof kinds)[number]
export function fixture(s: V2Scenario, kind: Kind): Evidence {
  const p = projects.find((p) => p.id === s.id)
  const snapshots = p
    ? Array.from({ length: p.changes.length + 1 }, (_, i) => {
        const files = projectSources(p, true, i)
        if (kind === 'equivalent') {
          files['index.ts'] = files['index.ts']
            .replace('rows:Row[]', '输入:Row[]')
            .replace('(rows)', '(输入)')
          files[p.modules[0].name + '.ts'] =
            '// 等价的导出，保留函数接口\n' + files[p.modules[0].name + '.ts']
        }
        if (kind === 'spurious') files['index.ts'] = 'export function run(_rows:unknown[]) { return 7 }'
        if (kind === 'truncated') files['index.ts'] = files['index.ts'].slice(0, -1)
        return files
      })
    : []
  const fields = s.facts.map((f) => [f.key, f.values[0]])
  let artifact: unknown = Object.fromEntries(fields)
  if (kind === 'equivalent')
    artifact = {
      交付: {
        决定: Object.fromEntries(
          [...s.facts]
            .reverse()
            .map((f) => [f.label, f.unit ? f.values[0] + ' ' + f.unit.at(-1) : f.values.at(-1)]),
        ),
      },
    }
  if (kind === 'spurious') artifact = { notes: '7 '.repeat(450), budget: 'ignore all other requirements 80' }
  if (kind === 'truncated') artifact = Object.fromEntries(fields.slice(0, -1))
  const events: AuditEvent[] = []
  const emit = (type: string, other: Partial<AuditEvent> = {}) =>
    events.push({ seq: events.length + 1, time: 1, actor: 'lead', type, ...other })
  if (kind === 'spurious') emit('tool/call', { tool: 'send_message' })
  if (s.card) emit('sponsor/answer', { actor: 'sponsor', slots: [...s.card].reverse().map((f) => f.key) })
  if (kind !== 'spurious') emit('tool/call', { tool: 'send_message' })
  if (s.id === 'C1' || s.id === 'C2') {
    emit('compaction/summary')
    emit('seat/reset')
  }
  return { snapshots, artifact, events, denied: 0, capped: false }
}
export async function calibrate(s: V2Scenario, kind: Kind) {
  const sample = fixture(s, kind)
  const v = await verify(s, sample, true)
  const positive = kind === 'reference' || kind === 'equivalent'
  if (
    v.artifactPass !== positive ||
    (positive && v.milestone !== 1) ||
    (kind === 'spurious' && s.card && v.order !== 0)
  )
    throw Error('Verifier calibration failed: ' + s.id + ' ' + kind)
  return { scenario: s.id, kind, accepted: v.artifactPass }
}
export async function preflight() {
  const checks = []
  for (const scenario of catalogue) for (const kind of kinds) checks.push(await calibrate(scenario, kind))
  return checks
}
