import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'
const facts = { network: 'MTU-1420', storage: 'TTL-7d', runtime: 'API-v3', audit: 'ZONE-EU' }
export const s5: ScenarioSpec = {
  id: 'S5',
  title: 'Reconcile four parallel specialist reports',
  category: 'Handoff',
  theoreticalBasis: 'Salas et al. (2005); Galbraith (1974)',
  roles: [
    { id: 'lead', name: 'Coordinator', duty: 'Reconcile all four signed observations.' },
    ...Object.keys(facts).map((id) => ({
      id,
      name: id,
      duty: 'Inspect ' + id + '.txt and report to the lead.',
    })),
  ],
  seedWorkspace: (dir) =>
    seedFiles(
      dir,
      Object.fromEntries(
        Object.entries(facts).map(([id, v]) => [id + '.txt', 'Verified constraint: ' + v]),
      ),
    ),
  initialPrompt:
    'Dispatch network, storage, runtime and audit in parallel. In each assignment include goal, constraint and acceptance. Each member reports status and conclusion with its verified fact, then updates its task. Reconcile exact facts keyed by specialist in delivery.json.',
  async verify(ctx) {
    const d = await document(ctx.workspace)
    let retained = 0,
      closed = 0,
      delivered = 0
    const assignments: number[] = [],
      receipts: number[] = []
    for (const [id, fact] of Object.entries(facts)) {
      const events = ctx.observations.filter((e) => e.actor === id)
      const assignment = events.find(
        (e) =>
          e.kind === 'assignment' &&
          ['goal', 'constraint', 'acceptance'].every((k) => e.text.toLowerCase().includes(k)),
      )
      const report = events.find(
        (e) =>
          e.kind === 'report' && e.text.includes(fact) && (!assignment || e.step >= assignment.step),
      )
      if (d[id] === fact) delivered++
      if (assignment) assignments.push(assignment.step)
      if (report) receipts.push(report.step)
      if (report && d[id] === fact) retained++
      if (
        assignment &&
        report &&
        /status/i.test(report.text) &&
        /conclusion|blocker/i.test(report.text) &&
        events.some((e) => e.kind === 'board' && e.step >= assignment.step && e.text === 'completed')
      )
        closed++
    }
    return {
      ...(await verdict(ctx, {
        delivered: delivered === 4,
        parallel:
          assignments.length === 4 &&
          receipts.length === 4 &&
          Math.max(...assignments) < Math.min(...receipts),
        handoffs: retained === 4,
        closed: closed === 4,
      })),
      handoffFidelity: retained / 4,
      closedLoopRate: closed / 4,
    }
  },
}
