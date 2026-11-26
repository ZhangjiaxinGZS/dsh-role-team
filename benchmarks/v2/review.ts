import { createHash } from 'node:crypto'
import { communicationF1, krippendorffAlpha } from '../stats.ts'
import { redact } from './protocol.ts'
import type { Trial } from './driver.ts'
import { catalogue } from './scenarios.ts'

export interface Coding {
  // Each claimed atom is assigned zero or more rubric element IDs. Repetition
  // earns no additional precision or recall.
  atoms: string[][]
  correctAssignments: string[]
  firstPass: string[]
  retained: string[]
}
export const blindId = (t: Trial) =>
  createHash('sha256')
    .update('review:' + t.nonce)
    .digest('hex')
    .slice(0, 16)
export function blindPacket(t: Trial) {
  const s = catalogue.find((s) => s.id === t.scenario)!
  return {
    id: blindId(t),
    scenario: s.id,
    reply: redact(t.finalText),
    task: s.prompt,
    requirements:
      s.id.startsWith('E') || s.id === 'L1'
        ? Object.entries(s.files)
            .filter(([n]) => n.endsWith('.txt'))
            .map(([, text]) => text)
        : [],
    revisions: s.stages.map((stage) => stage.instruction),
    rubric: s.facts.length
      ? s.facts.map((f) => ({ id: f.key, meaning: f.label, accepted: f.values }))
      : [
          {
            id: 'contract',
            meaning: 'Describe the effective final API and its behavior accurately.',
            accepted: [],
          },
          { id: 'validation', meaning: 'Give concrete evidence of the delivered behavior.', accepted: [] },
          {
            id: 'constraints',
            meaning: 'Explain how module constraints or the latest revision were reconciled.',
            accepted: [],
          },
        ],
    expectedSpecialists: (t.arm === 'single-agent' ? [] : s.roles.slice(1)).map((r) => ({
      id: r.id,
      duty: r.duty,
    })),
    reports: t.events
      .filter((e) => e.tool === 'send_message' || e.type === 'team/report')
      .map((e) => ({ speaker: e.actor, recipient: e.target, text: redact(e.text ?? '') })),
  }
}
export function interpret(t: Trial, c: Coding) {
  const s = catalogue.find((s) => s.id === t.scenario)!
  const ids = blindPacket(t).rubric.map((f) => f.id),
    expected = s.roles.slice(1).map((r) => r.id)
  const seen = new Set<string>()
  let relevant = 0
  for (const atom of c.atoms) {
    if (atom.some((k) => !ids.includes(k))) throw Error('Unknown semantic rubric key')
    if (atom.some((k) => !seen.has(k))) relevant++
    atom.forEach((k) => seen.add(k))
  }
  for (const list of [c.correctAssignments, c.firstPass, c.retained]) {
    if (new Set(list).size !== list.length) throw Error('Duplicate rating')
  }
  if (
    [...c.correctAssignments, ...c.firstPass].some((k) => !expected.includes(k)) ||
    c.retained.some((k) => !ids.includes(k))
  )
    throw Error('Invalid blinded coding')
  const multi = t.arm !== 'single-agent'
  return {
    f1: ids.length ? communicationF1(relevant / Math.max(1, c.atoms.length), seen.size / ids.length) : null,
    delegation: multi ? c.correctAssignments.length / expected.length : null,
    firstPass: multi ? c.firstPass.length / expected.length : null,
    fidelity: multi && s.multiAgentOnly ? c.retained.length / ids.length : null,
  }
}
export function blindSample(trials: Trial[]) {
  return trials
    .map(blindId)
    .sort()
    .slice(0, Math.ceil(trials.length / 5))
}
export function reviewAgreement(
  trials: Trial[],
  ratings: Record<string, { judge: number[]; human: number[] }>,
) {
  const sample = blindSample(trials),
    judge: number[] = [],
    human: number[] = []
  for (const id of sample) {
    const r = ratings[id]
    if (!r) return { required: sample.length, alpha: null, accepted: false }
    if (
      !r.judge.length ||
      r.judge.length !== r.human.length ||
      [...r.judge, ...r.human].some((x) => x !== 0 && x !== 1)
    )
      throw Error('Invalid blind ratings')
    judge.push(...r.judge)
    human.push(...r.human)
  }
  const a = krippendorffAlpha([judge, human], 'nominal')
  return { required: sample.length, alpha: Number.isFinite(a) ? a : null, accepted: a >= 0.8 }
}
// Logistic paired preference vs standardized signed length difference.
// The intercept gives the win probability at equal lengths. Undefined if the
// observations cannot identify a finite fit (e.g. unanimous or separated).
export function lengthControlledWinRate(pairs: { lengthDiff: number; win: number }[]) {
  if (pairs.some((p) => !Number.isFinite(p.lengthDiff) || ![0, 0.5, 1].includes(p.win)))
    throw Error('Invalid pairwise preference')
  if (pairs.length < 3) return null
  const scale = Math.max(1, ...pairs.map((p) => Math.abs(p.lengthDiff)))
  let a = 0,
    b = 0
  for (let iter = 0; iter < 50; iter++) {
    let s0 = 0,
      s1 = 0,
      h00 = 0,
      h01 = 0,
      h11 = 0
    for (const row of pairs) {
      const x = row.lengthDiff / scale,
        p = 1 / (1 + Math.exp(-(a + b * x))),
        w = p * (1 - p)
      s0 += row.win - p
      s1 += (row.win - p) * x
      h00 += w
      h01 += w * x
      h11 += w * x * x
    }
    const det = h00 * h11 - h01 * h01
    if (det < 1e-10) return null
    const da = (s0 * h11 - s1 * h01) / det,
      db = (s1 * h00 - s0 * h01) / det
    a += da
    b += db
    if (Math.max(Math.abs(da), Math.abs(db)) < 1e-7) return 1 / (1 + Math.exp(-a))
  }
  return null
}

export function preferencePackets(trials: Trial[]) {
  const packets = []
  for (const group of Map.groupBy(
    trials.filter((t) => ['G3', 'G4'].includes(t.scenario)),
    (t) => t.scenario + '-' + t.repeat,
  ).values()) {
    const ordered = [...group].sort((a, b) => blindId(a).localeCompare(blindId(b)))
    for (let i = 0; i < ordered.length; i++)
      for (const right of ordered.slice(i + 1)) {
        const left = ordered[i]
        packets.push({
          task: catalogue.find((s) => s.id === left.scenario)!.prompt,
          left: { id: blindId(left), text: redact(left.finalText) },
          right: { id: blindId(right), text: redact(right.finalText) },
        })
      }
  }
  return packets
}
