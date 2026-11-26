import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'
export const s6: ScenarioSpec = {
  id: 'S6',
  title: 'Transfer a migration lesson to a fresh deployment',
  category: 'Cross-task learning',
  theoreticalBasis: 'Xu et al. (2024); Yao et al. (2024)',
  roles: [
    { id: 'lead', name: 'Release lead', duty: 'Coordinate releases.' },
    { id: 'engineer', name: 'Engineer', duty: 'Apply the migration procedure.' },
  ],
  seedWorkspace: (dir) =>
    seedFiles(dir, { 't1.txt': 'East release; sort IDs and deduplicate before cutover: 3,1,1,2.' }),
  initialPrompt:
    'Complete T1 east release in t1.json with region and ids. Train the engineer on the verified migration procedure before a fresh west release. Deliver the second result in t2.json.',
  pivots: [
    { progress: 0.5, instruction: 'Start T2 in a fresh conversation. West input IDs are 8,5,8,6.' },
  ],
  simulatedUser: (q) =>
    /west|T2/i.test(q)
      ? 'Use the same migration acceptance rules for the west release.'
      : 'Sort and deduplicate IDs before cutover.',
  async verify(ctx) {
    const t1 = await document(ctx.workspace, 't1.json'),
      t2 = await document(ctx.workspace, 't2.json')
    const first = ctx.observations.find((o) => o.kind === 'stage1')
    const memory = ctx.observations.find(
      (o) =>
        o.kind === 'experience' &&
        first &&
        o.step > first.step &&
        /sort/i.test(o.text) &&
        /deduplicat/i.test(o.text),
    )
    const second = ctx.observations.find((o) => o.kind === 'stage2' && first && o.step > first.step)
    const stage1Passed =
      first?.text === 'accepted' && t1.region === 'east' && JSON.stringify(t1.ids) === '[1,2,3]'
    const stage2Passed =
      second?.text === 'accepted' && t2.region === 'west' && JSON.stringify(t2.ids) === '[5,6,8]'
    return {
      ...(await verdict(ctx, {
        stage1: stage1Passed,
        trained: !!memory && !!second && memory.step < second.step,
        stage2: stage2Passed,
      })),
      stage1Passed,
      stage2Passed,
    }
  },
}
