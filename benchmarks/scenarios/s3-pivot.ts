import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'
const pivots = [
  { progress: 0.4, instruction: 'Switch transport to batch.' },
  { progress: 0.7, instruction: 'Switch encoding to ndjson; keep batch.' },
]
export const s3: ScenarioSpec = {
  id: 'S3',
  title: 'Migrate an interface through two pivots',
  category: 'Adaptation',
  theoreticalBasis: 'Burke et al. (2006)',
  roles: [
    { id: 'lead', name: 'Integrator', duty: 'Keep producer and consumer compatible.' },
    { id: 'producer', name: 'Producer', duty: 'Build the producer.' },
    { id: 'consumer', name: 'Consumer', duty: 'Build the consumer.' },
  ],
  seedWorkspace: (dir) =>
    seedFiles(dir, {
      'contract.txt': 'Reuse contract ID IF-17. Start with stream transport and JSON encoding.',
    }),
  initialPrompt:
    'Coordinate ten implementation checkpoints. Write producer.json and consumer.json with contract, transport and encoding. Apply sponsor changes at checkpoints four and seven and retain the original contract ID.',
  pivots,
  simulatedUser: (q) =>
    pivots.find((p) => q.includes(String(p.progress * 100)))?.instruction ??
    'Keep the latest interface agreement.',
  async verify(ctx) {
    const outputs = await Promise.all(
      ['producer.json', 'consumer.json'].map((n) => document(ctx.workspace, n)),
    )
    const coherence =
      outputs.filter((d) => d.transport === 'batch' && d.encoding === 'ndjson').length / 2
    const reuse = outputs.filter((d) => d.contract === 'IF-17').length / 2
    const delays: number[] = []
    let missed = 0
    for (const [i, p] of pivots.entries()) {
      const pivot = ctx.observations.find((o) => o.kind === 'pivot' && o.text === p.instruction)
      const end = i === 0 ? 7 : 11
      for (const worker of ctx.workers) {
        const first =
          pivot &&
          ctx.observations.find(
            (o) =>
              o.actor === worker &&
              o.kind === 'work' &&
              o.step >= pivot.step &&
              o.step < end &&
              o.text.includes(i === 0 ? 'batch' : 'ndjson'),
          )
        if (first && pivot) delays.push(first.step - pivot.step)
        else missed++
      }
    }
    const transitions = pivots.every((p) =>
      ctx.observations.some(
        (o) => o.kind === 'pivot' && o.step === p.progress * 10 && o.text === p.instruction,
      ),
    )
    const v = await verdict(ctx, {
      transitions,
      reused: reuse === 1,
      consistent: coherence === 1,
      adapted: delays.length > 0 && missed === 0,
    })
    return {
      ...v,
      postPivotCoherence: coherence,
      adaptationLatencySteps:
        !missed && delays.length ? delays.reduce((a, b) => a + b) / delays.length : undefined,
      details: { ...v.details, artifactReuse: reuse, unobservedTransitions: missed },
    }
  },
}
