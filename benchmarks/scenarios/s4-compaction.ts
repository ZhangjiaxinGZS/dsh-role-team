import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'
export const s4: ScenarioSpec = {
  id: 'S4',
  title: 'Retain decisions across compaction and seat replacement',
  category: 'Continuity',
  theoreticalBasis: 'Cannon-Bowers et al. (1993)',
  roles: [
    { id: 'lead', name: 'Maintainer', duty: 'Coordinate and preserve decisions.' },
    { id: 'operator', name: 'Operator', duty: 'Continue the handoff after replacement.' },
  ],
  initialPrompt:
    'Adopt release key R17, EU region and a 7-day rollback window. Process the incident log. After compaction and handoff, record the retained key, region and rollbackDays in delivery.json.',
  seedWorkspace: (dir) =>
    seedFiles(dir, {
      'incidents.txt': Array.from(
        { length: 256 },
        (_, i) => 'Incident ' + i + ': routine checksum review.',
      ).join('\n'),
    }),
  async verify(ctx) {
    const d = await document(ctx.workspace)
    const compact = ctx.observations.find((o) => o.kind === 'compaction')
    const reset = ctx.observations.find((o) => o.kind === 'reset' && compact && o.step >= compact.step)
    const resumed = ctx.observations.filter(
      (o) => o.kind === 'work' && reset && o.step > reset.step && o.actor === reset.actor,
    )
    const after = resumed.length > 0
    const handoff = resumed.map((o) => o.text).join(' ')
    const facts = [
      d.key === 'R17' && /\bR17\b/.test(handoff),
      d.region === 'EU' && /\bEU\b/.test(handoff),
      d.rollbackDays === 7 && /\b7\b/.test(handoff),
    ]
    return {
      ...(await verdict(ctx, {
        compacted: !!compact,
        replaced: !!reset,
        resumed: after,
        retained: facts.every(Boolean),
      })),
      postCompactionRetention: after ? facts.filter(Boolean).length / 3 : 0,
    }
  },
}
