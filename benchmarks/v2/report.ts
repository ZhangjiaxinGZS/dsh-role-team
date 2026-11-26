import {
  effectiveCost,
  passPowK,
  mcnemarExact,
  wilcoxonSignedRank,
  cliffsDelta,
  holmBonferroni,
} from '../stats.ts'
import type { Trial } from './driver.ts'
import { blindId, interpret, lengthControlledWinRate, reviewAgreement, type Coding } from './review.ts'
import { catalogue } from './scenarios.ts'

const labels = {
  pass: '1 · Artifact Pass@1',
  stable: '2 · Artifact pass³',
  milestone: '3 · Milestone KPI',
  cvr: '4 · CVR',
  coverage: '5 · Clarification coverage',
  order: '5 · Clarified before first delegation',
  f1: '6 · Semantic communication F1',
  turns: '7 · User turns',
  corrections: '7 · User corrections',
  delegation: '8 · Appropriate delegation',
  firstPass: '9 · Internal first-pass yield',
  fidelity: '9 · Handoff fidelity',
  latency: '10 · Pivot response latency (ms)',
  coherence: '10 · Post-pivot coherence',
  retention: '10 · Post-compaction retention',
  reuse: '10 · Module reuse between revisions',
  gain: '10 · T2 − T1',
  p50: '11 · Agent wall p50 (ms)',
  p95: '11 · Agent wall p95 (ms)',
  redundancy: '11 · Cross-agent redundancy',
  tokens: '12 · Tokens per solved',
  cache: '12 · Prompt cache share',
  units: '12 · Weighted cost units / trial',
  usd: '12 · Estimated USD / trial',
  screen: 'Teammate report screen share',
  mast: 'MAST failure proxies',
} as const
type Key = keyof typeof labels
type Datum = { num: number; den: number }
const ratio = (num: number, den = 1): Datum => ({ num, den })
function quantile(sorted: number[], p: number) {
  const q = (sorted.length - 1) * p
  return sorted[Math.floor(q)] + (q % 1) * (sorted[Math.ceil(q)] - sorted[Math.floor(q)])
}
function row(t: Trial, price: number, code: Coding | undefined): Partial<Record<Key, Datum>> {
  const v = t.verification,
    m = t.metrics,
    multi = t.arm !== 'single-agent',
    cost = effectiveCost(m, price)
  const s = catalogue.find((s) => s.id === t.scenario)!
  const fields: Partial<Record<Key, Datum>> = {
    pass: ratio(+v.artifactPass),
    milestone: ratio(v.milestone),
    cvr: ratio(+v.violation),
    turns: ratio(t.events.filter((e) => e.type === 'user/input').length),
    corrections: ratio(t.events.filter((e) => e.type === 'user/correction').length),
    p50: ratio(t.clock.agentWallMs),
    p95: ratio(t.clock.agentWallMs),
    tokens: ratio(m.totalTokens, +v.artifactPass),
    cache: ratio(m.cacheReadTokens, m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens),
    units: ratio(cost.units),
    usd: ratio(cost.estimatedUsd),
    mast: ratio(
      m.deniedToolCalls +
        m.staleInProgressTasks +
        m.repeatedIdenticalToolCalls +
        t.events.filter((e) => e.type === 'tool/denied').length,
    ),
  }
  if (v.coverage !== null) fields.coverage = ratio(v.coverage)
  if (v.order !== null) fields.order = ratio(v.order)
  if (multi) {
    fields.screen = ratio(t.arm === 'v0.1.0' ? m.defaultExpandedNoiseRatio : m.compactCollapsedNoiseRatio)
    fields.redundancy = ratio(m.redundantReads, m.readCalls)
  }
  if (code)
    for (const [key, n] of Object.entries(interpret(t, code))) if (n !== null) fields[key as Key] = ratio(n)
  if (v.moduleReuse != null) fields.reuse = ratio(v.moduleReuse)
  if (s.stages.length) {
    const last = Object.values(v.stages.at(-1)!)
    fields.coherence = ratio(last.filter(Boolean).length, last.length)
    const delays = t.events
      .filter((e) => e.type === 'pivot')
      .flatMap((e) => {
        const next = t.events.find(
          (x) => x.seq > e.seq && x.actor === 'lead' && x.type === 'assistant/message',
        )
        return next ? [next.time - e.time] : []
      })
    if (delays.length)
      fields.latency = ratio(
        delays.reduce((a, b) => a + b, 0),
        delays.length,
      )
    if (t.events.some((e) => e.type === 'compaction/summary')) fields.retention = fields.coherence
    if (s.id === 'E6')
      fields.gain = ratio(Number(last.every(Boolean)) - Number(Object.values(v.stages[0]).every(Boolean)))
  }
  return fields
}
function aggregate(k: Key, blocks: Datum[][]) {
  if (k === 'stable') {
    const values = blocks
      .filter((x) => x.length >= 3)
      .map((x) =>
        passPowK(
          x.map((y) => !!y.num),
          3,
        ),
      )
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  }
  const data = blocks.flat()
  if (!data.length) return null
  if (k === 'p50' || k === 'p95')
    return quantile(
      data.map((r) => r.num).sort((a, b) => a - b),
      k === 'p50' ? 0.5 : 0.95,
    )
  const den = data.reduce((n, r) => n + r.den, 0)
  return den ? data.reduce((n, r) => n + r.num, 0) / den : null
}
function interval(k: Key, blocks: Datum[][]) {
  const value = aggregate(k, blocks)
  if (value === null) return null
  let state = 12499
  const samples: number[] = []
  for (let i = 0; i < 1000; i++) {
    const draws = blocks.map(() => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return blocks[Math.floor((state / 2 ** 32) * blocks.length)]
    })
    const n = aggregate(k, draws)
    if (n !== null) samples.push(n)
  }
  samples.sort((a, b) => a - b)
  return { value, low: quantile(samples, 0.025), high: quantile(samples, 0.975) }
}
export interface Reviews {
  coding?: Record<string, Coding>
  ratings?: Record<string, { judge: number[]; human: number[] }>
  pairs?: { left: string; right: string; winner: 'left' | 'right' | 'tie' }[]
}
export function reportV2(trials: Trial[], price: number, reviews: Reviews = {}) {
  const data = new Map(trials.map((t) => [t, row(t, price, reviews.coding?.[blindId(t)])]))
  const strata = ['all', 'dev', 'holdout', ...new Set(catalogue.map((s) => s.archetype))]
  const summaries = strata.flatMap((stratum) => {
    const selection = trials.filter(
      (t) => stratum === 'all' || t.split === stratum || t.archetype === stratum,
    )
    return [...Map.groupBy(selection, (t) => t.arm)].map(([arm, ts]) => {
      const sections = [...Map.groupBy(ts, (t) => t.scenario).values()]
      const metrics = Object.fromEntries(
        (Object.keys(labels) as Key[]).map((k) => [
          k,
          interval(
            k,
            sections.map((group) => group.flatMap((t) => data.get(t)![k === 'stable' ? 'pass' : k] ?? [])),
          ),
        ]),
      )
      return {
        stratum,
        arm,
        trials: ts.length,
        capped: ts.filter((t) => t.status === 'budget_exceeded').length,
        metrics,
      }
    })
  })
  const comparisons = []
  const arms = [...new Set(trials.map((t) => t.arm))]
  for (const arm of arms) {
    const baseline =
      arm === 'v0.2.0-full'
        ? ['single-agent', 'v0.1.0']
        : arm === 'v0.1.0'
          ? ['single-agent']
          : arm === 'single-agent'
            ? []
            : ['v0.2.0-full']
    for (const base of baseline) {
      const a = trials.filter((t) => t.arm === base)
      const pairs = trials
        .filter((t) => t.arm === arm)
        .flatMap((t) => {
          const b = a.find((b) => b.scenario === t.scenario && b.repeat === t.repeat)
          return b ? [[b, t] as const] : []
        })
      const test = mcnemarExact(
        pairs.map(([a, b]) => [a.verification.artifactPass, b.verification.artifactPass]),
      )
      const continuous = (Object.keys(labels) as Key[])
        .filter((k) => !['stable', 'pass', 'cvr'].includes(k))
        .flatMap((k) => {
          const points = pairs.flatMap(([a, b]) => {
            const x = data.get(a)![k],
              y = data.get(b)![k]
            return x?.den && y?.den ? [[x.num / x.den, y.num / y.den] as [number, number]] : []
          })
          return points.length
            ? [
                {
                  metric: k,
                  n: points.length,
                  wilcoxon: wilcoxonSignedRank(points),
                  cliffs: cliffsDelta(
                    points.map((x) => x[1]),
                    points.map((x) => x[0]),
                  ),
                },
              ]
            : []
        })
      comparisons.push({ base, arm, n: pairs.length, mcnemar: test, continuous })
    }
  }
  const family = comparisons.flatMap((c) => [c.mcnemar.pValue, ...c.continuous.map((x) => x.wilcoxon.pValue)])
  const adjusted = holmBonferroni(family)
  let i = 0
  const corrected = comparisons.map((c) => ({
    ...c,
    holm: adjusted[i++],
    continuous: c.continuous.map((m) => ({ ...m, holm: adjusted[i++] })),
  }))
  const ids = new Map(trials.map((t) => [blindId(t), t]))
  const preferences = (reviews.pairs ?? []).map((p) => {
    const l = ids.get(p.left),
      r = ids.get(p.right)
    if (
      !l ||
      !r ||
      l.scenario !== r.scenario ||
      l.repeat !== r.repeat ||
      l.arm === r.arm ||
      !['G3', 'G4'].includes(l.scenario)
    )
      throw Error('Unmatched preference')
    const flip = l.arm > r.arm,
      win = p.winner === 'tie' ? 0.5 : Number(p.winner === 'left')
    return {
      pair: [l.arm, r.arm].sort().join(' vs '),
      win: flip ? 1 - win : win,
      lengthDiff: (flip ? -1 : 1) * ([...l.finalText].length - [...r.finalText].length),
    }
  })
  // Compare the three primary arms on exactly the same instances. The G5
  // specialist-only task and the targeted ablations have different support.
  const primary = ['single-agent', 'v0.1.0', 'v0.2.0-full']
  const matched = [...Map.groupBy(trials, (t) => t.scenario + ':' + t.repeat).values()]
    .filter((group) => primary.every((a) => group.some((t) => t.arm === a)))
    .flat()
  const points = primary.flatMap((arm) => {
    const sample = matched.filter((t) => t.arm === arm)
    if (!sample.length) return []
    const priceUnits = sample.reduce((n, t) => n + effectiveCost(t.metrics, price).units, 0) / sample.length
    const p50 = quantile(
      sample.map((t) => t.clock.agentWallMs).sort((a, b) => a - b),
      0.5,
    )
    const pass = sample.filter((t) => t.verification.artifactPass).length / sample.length
    return [{ arm, n: sample.length, pass, priceUnits, p50 }]
  })
  const frontier = points.map((p) => ({
    ...p,
    efficient: !points.some(
      (q) =>
        q.pass >= p.pass &&
        q.priceUnits <= p.priceUnits &&
        q.p50 <= p.p50 &&
        (q.pass > p.pass || q.priceUnits < p.priceUnits || q.p50 < p.p50),
    ),
  }))
  return {
    frontier,
    summaries,
    comparisons: corrected,
    agreement: reviewAgreement(trials, reviews.ratings ?? {}),
    lengthControlledWins: Object.fromEntries(
      [...Map.groupBy(preferences, (p) => p.pair)].map(([pair, v]) => [pair, lengthControlledWinRate(v)]),
    ),
  }
}
export function renderV2(report: ReturnType<typeof reportV2>, price: number) {
  const lines = [
    '# Benchmark v2 · offline dry-run',
    '',
    'Synthetic fixtures exercise the protocol. Reported usage and trial scores describe the fixture executor only.',
    '',
    'Costs use weights 1 / 0.1 / 1.25 / 4 for uncached input / cache read / cache write / output. Estimated USD assumes ' +
      price +
      ' USD per million units.',
    '',
    'Intervals are 95% percentile bootstrap intervals resampling scenario blocks (1,000 seeded draws). Single-agent excludes G5. Paired comparisons use common scenario/repeat keys. A dash marks insufficient or inapplicable evidence.',
  ]
  for (const stratum of new Set(report.summaries.map((r) => r.stratum))) {
    const groups = report.summaries.filter((r) => r.stratum === stratum)
    lines.push(
      '',
      '## ' + stratum,
      '',
      '| Metric | ' + groups.map((g) => g.arm + ' (n=' + g.trials + ')').join(' | ') + ' |',
      '|---|' + groups.map(() => '---:').join('|') + '|',
    )
    const table = (key: string, title: string) =>
      lines.push(
        '| ' +
          title +
          ' | ' +
          groups
            .map((g) => {
              const v = g.metrics[key]
              return v ? v.value.toFixed(4) + ' [' + v.low.toFixed(4) + ', ' + v.high.toFixed(4) + ']' : '—'
            })
            .join(' | ') +
          ' |',
      )
    for (const [k, v] of Object.entries(labels)) if (k !== 'screen' && k !== 'mast') table(k, v)
    lines.push(
      '',
      '### Auxiliary diagnostics',
      '',
      '| Metric | ' + groups.map((g) => g.arm).join(' | ') + ' |',
      '|---|' + groups.map(() => '---:').join('|') + '|',
    )
    table('screen', labels.screen)
    table('mast', labels.mast)
    lines.push('| Length-controlled win rate | ' + groups.map(() => '—').join(' | ') + ' |')
  }
  lines.push(
    '',
    '## Matched cost / latency / accuracy frontier',
    '',
    '| Arm | Matched trials | Pass@1 | Mean weighted units | p50 agent ms | Pareto-efficient |',
    '|---|---:|---:|---:|---:|---|',
  )
  for (const p of report.frontier)
    lines.push(
      '| ' +
        [p.arm, p.n, p.pass.toFixed(4), p.priceUnits.toFixed(3), p.p50.toFixed(3), p.efficient].join(' | ') +
        ' |',
    )
  lines.push(
    '',
    '## Length-controlled blind preferences',
    '',
    '| Ordered arm pair | Equal-length win probability |',
    '|---|---:|',
  )
  for (const [pair, rate] of Object.entries(report.lengthControlledWins))
    lines.push('| ' + pair + ' | ' + (rate ?? '—') + ' |')
  if (!Object.keys(report.lengthControlledWins).length)
    lines.push('| No independent preference ballots | — |')
  lines.push(
    '',
    '## Paired inference',
    '',
    '| Baseline | Arm | Pairs | McNemar p | Holm p | Milestone Wilcoxon p | Cliff’s δ |',
    '|---|---|---:|---:|---:|---:|---:|',
  )
  for (const c of report.comparisons) {
    const m = c.continuous.find((v) => v.metric === 'milestone')
    lines.push(
      '| ' +
        [c.base, c.arm, c.n, c.mcnemar.pValue, c.holm, m?.wilcoxon.pValue, m?.cliffs.delta].join(' | ') +
        ' |',
    )
  }
  lines.push(
    '',
    'The JSON report includes all continuous comparisons and Holm-adjusted p-values. Blinded binary atom agreement (Krippendorff’s α): ' +
      (report.agreement.alpha ?? 'pending independent human review') +
      '. Required blind sample: ' +
      report.agreement.required +
      '. Require α ≥ 0.80 before interpreting semantic scores.',
    '',
    'Holdout traces are reserved for final evaluation. Do not use them to tune prompts or policies.',
  )
  return lines.join('\n') + '\n'
}
