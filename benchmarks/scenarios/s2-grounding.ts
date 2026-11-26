import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'
const slots = [
  { key: 'audience', pattern: /audience|users?|受众|用户/i, answer: 'operators' },
  { key: 'budget', pattern: /budget|cost|预算/i, answer: '40 credits' },
  { key: 'deadline', pattern: /deadline|date|when|截止|日期/i, answer: 'Friday' },
]
const decisions = ['deploy offline', '40 credits', 'Friday', 'approve pilot']
export const s2: ScenarioSpec = {
  id: 'S2',
  title: 'Clarify a pilot release',
  category: 'Grounding',
  theoreticalBasis: 'Clark & Brennan (1991); Yao et al. (2024)',
  roles: [
    { id: 'lead', name: 'Planner', duty: 'Clarify unknowns with the sponsor.' },
    { id: 'review', name: 'Reviewer', duty: 'Check viability.' },
  ],
  seedWorkspace: (dir) =>
    seedFiles(dir, { 'request.txt': 'Prepare an offline pilot. Sponsor approval is required.' }),
  initialPrompt:
    'Plan the pilot. Ask the sponsor about missing audience, budget and deadline. Write those three values to delivery.json, then give a concise decision note with conclusion, budget evidence, deadline risk and requested approval (one per line).',
  simulatedUser(question) {
    return (
      slots
        .filter((s) => s.pattern.test(question))
        .map((s) => s.key + ': ' + s.answer)
        .join('; ') || 'Specify which planning decision needs clarification.'
    )
  },
  async verify(ctx) {
    const d = await document(ctx.workspace),
      questions = ctx.observations.filter((o) => o.kind === 'question')
    const asked = slots.filter((s) => questions.some((q) => s.pattern.test(q.text))).length
    const answer = ctx.observations.filter((o) => o.kind === 'answer').at(-1)?.text ?? ''
    const lines = answer
      .split(/\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const found = new Set<string>()
    let useful = 0
    for (const line of lines) {
      const fresh = decisions.filter((v) => line.includes(v.toLowerCase()) && !found.has(v))
      if (fresh.length) useful++
      fresh.forEach((v) => found.add(v))
    }
    const checks = Object.fromEntries(slots.map((s) => [s.key, d[s.key] === s.answer]))
    return {
      ...(await verdict(ctx, { ...checks, clarified: asked === 3, decision: found.size === 4 })),
      clarificationCoverage: asked / 3,
      commPrecision: useful / Math.max(1, lines.length),
      commRecall: found.size / 4,
    }
  },
}
