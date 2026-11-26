import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { arms, safePath, type TrialResult, type ArmStats, type ComparisonReport } from './types.ts'
import {
  bootstrapCI,
  passAt1,
  passPowK,
  communicationF1,
  cliffsDelta,
  wilcoxonSignedRank,
  mcnemarExact,
} from './stats.ts'

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null)
const defined = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const comm = (t: TrialResult) =>
  defined(t.verification.commPrecision) && defined(t.verification.commRecall)
    ? communicationF1(t.verification.commPrecision, t.verification.commRecall)
    : null
const metrics: Record<string, (t: TrialResult) => number | null | undefined> = {
  pass: (t) => Number(t.verification.passed),
  cvr: (t) => Number(t.verification.constraintViolations > 0),
  milestone: (t) => t.verification.milestoneKpi,
  pooling: (t) =>
    t.verification.hiddenFactsTotal
      ? t.verification.hiddenFactsPooled! / t.verification.hiddenFactsTotal
      : null,
  cache: (t) => t.metrics.kvCacheHitRate,
  tokens: (t) => t.metrics.totalTokens,
  latency: (t) => t.verification.adaptationLatencySteps,
  noise: (t) =>
    t.arm === 'v0.1.0' ? t.metrics.defaultExpandedNoiseRatio : t.metrics.compactCollapsedNoiseRatio,
  commF1: comm,
  clarification: (t) => t.verification.clarificationCoverage,
  coherence: (t) => t.verification.postPivotCoherence,
  retention: (t) => t.verification.postCompactionRetention,
  fidelity: (t) => t.verification.handoffFidelity,
  closedLoop: (t) => t.verification.closedLoopRate,
  resync: (t) => t.metrics.postCompactionResyncRate,
  learning: (t) =>
    t.scenario === 'S6' ? Number(t.verification.stage2Passed) - Number(t.verification.stage1Passed) : null,
}
function armStats(ts: TrialResult[]): ArmStats {
  const outcomes = ts.map((t) => t.verification.passed),
    solved = outcomes.filter(Boolean).length
  const byScenario = Map.groupBy(ts, (t) => t.scenario)
  const groups = [...byScenario.values()]
  const input = sum(ts.map((t) => t.metrics.inputTokens)),
    cached = sum(ts.map((t) => t.metrics.cacheReadTokens)),
    written = sum(ts.map((t) => t.metrics.cacheWriteTokens))
  const promptTokens = input + cached + written
  const intervals = Object.fromEntries(
    Object.entries(metrics).map(([name, get]) => {
      const values = ts.map(get).filter(defined)
      return [name, values.length ? bootstrapCI(values) : null]
    }),
  )
  const total = (key: 'deniedToolCalls' | 'repeatedIdenticalToolCalls' | 'staleInProgressTasks') =>
    sum(ts.map((t) => t.metrics[key]))
  const { model, preset, mode, arm } = ts[0]
  return {
    model,
    preset,
    mode,
    arm,
    trials: ts.length,
    passAt1: passAt1(outcomes),
    passPow3: groups.every((g) => g.length >= 3)
      ? mean(
          groups.map((g) =>
            passPowK(
              g.map((t) => t.verification.passed),
              3,
            ),
          ),
        )
      : null,
    milestoneKpi: intervals.milestone!.mean,
    cvr: intervals.cvr!.mean,
    kvCacheHitRate: promptTokens ? cached / promptTokens : null,
    ...(mode === 'live' && {
      providerUsage: {
        uncachedInput: input,
        cacheRead: cached,
        cacheWrite: written,
        output: sum(ts.map((t) => t.metrics.outputTokens)),
        promptCacheReadShare: promptTokens ? cached / promptTokens : null,
      },
    }),
    tokensPerSolved: solved ? sum(ts.map((t) => t.metrics.totalTokens)) / solved : null,
    commF1: intervals.commF1?.mean ?? null,
    noiseRatio: intervals.noise!.mean,
    learningGain: intervals.learning?.mean ?? null,
    intervals,
    mast: {
      deniedToolCalls: total('deniedToolCalls'),
      staleInProgressTasks: total('staleInProgressTasks'),
      repeatedIdenticalToolCalls: total('repeatedIdenticalToolCalls'),
    },
  }
}
export function summarize(trials: TrialResult[]): ComparisonReport {
  if (!trials.length || new Set(trials.map((t) => t.mode)).size !== 1)
    throw new Error('Require nonempty, single-mode results')
  const report: ComparisonReport = { mode: trials[0].mode, arms: [], comparisons: [], trials }
  for (const group of Map.groupBy(trials, (t) => JSON.stringify([t.model, t.preset])).values()) {
    const indexed = Map.groupBy(group, (t) => t.arm)
    const pairKey = (t: TrialResult) => t.scenario + '#' + t.repeat
    for (const ts of indexed.values()) {
      if (new Set(ts.map(pairKey)).size !== ts.length) throw new Error('Duplicate trial pairing key')
      report.arms.push(armStats(ts))
    }
    const baseline = arms.find((a) => indexed.has(a))!
    const base = new Map(indexed.get(baseline)!.map((t) => [pairKey(t), t]))
    for (const [arm, ts] of indexed) {
      if (arm === baseline) continue
      const matched: [TrialResult, TrialResult][] = []
      for (const t of ts) {
        const b = base.get(pairKey(t))
        if (b) matched.push([b, t])
      }
      if (!matched.length) continue
      const continuous: ComparisonReport['comparisons'][number]['continuous'] = {}
      for (const [key, get] of Object.entries(metrics)) {
        if (key === 'pass' || key === 'cvr') continue
        const pairs: [number, number][] = []
        for (const [a, b] of matched) {
          const x = get(a),
            y = get(b)
          if (defined(x) && defined(y)) pairs.push([x, y])
        }
        continuous[key] = pairs.length
          ? {
              wilcoxon: wilcoxonSignedRank(pairs),
              cliffs: cliffsDelta(
                pairs.map((p) => p[1]),
                pairs.map((p) => p[0]),
              ),
              difference: bootstrapCI(pairs.map(([a, b]) => b - a)),
            }
          : null
      }
      report.comparisons.push({
        model: ts[0].model,
        preset: ts[0].preset,
        baseline,
        arm,
        pairs: matched.length,
        pass: mcnemarExact(matched.map(([a, b]) => [a.verification.passed, b.verification.passed])),
        cvr: mcnemarExact(
          matched.map(([a, b]) => [
            a.verification.constraintViolations > 0,
            b.verification.constraintViolations > 0,
          ]),
        ),
        continuous,
      })
    }
  }
  return report
}
function renderCacheAblation(report: ComparisonReport) {
  const lines: string[] = []
  if (report.mode === 'live' && report.trials.every((t) => t.scenario === 'S4')) {
    const prefix = report.trials.filter((t) => t.arm === 'v0.2.0-prefix-brief')
    const full = report.trials.filter((t) => t.arm === 'v0.2.0-full')
    if (prefix.length && full.length) {
      lines.push(
        '',
        '## S4 cache ablation',
        '',
        '| Model | Repeat | Suffix cache reads | Prefix cache reads | Suffix input | Prefix input | Suffix syncs | Prefix syncs |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
      )
      for (const a of full) {
        const b = prefix.find((t) => t.model === a.model && t.preset === a.preset && t.repeat === a.repeat)
        if (b)
          lines.push(
            '| ' +
              [
                a.model,
                a.repeat,
                a.metrics.cacheReadTokens,
                b.metrics.cacheReadTokens,
                a.metrics.inputTokens,
                b.metrics.inputTokens,
                a.metrics.briefSyncCount,
                b.metrics.briefSyncCount,
              ].join(' | ') +
              ' |',
          )
      }
      const suffixInput = sum(full.map((t) => t.metrics.inputTokens))
      const prefixInput = sum(prefix.map((t) => t.metrics.inputTokens))
      if (prefixInput) {
        const change = (100 * (suffixInput - prefixInput)) / prefixInput
        lines.push(
          '',
          `Across ${full.length} matched pairs the suffix arm used ${suffixInput} uncached input tokens and the prefix arm used ${prefixInput} (${Math.abs(change).toFixed(2)}% ${change < 0 ? 'lower' : 'higher'} with the suffix).`,
        )
      }
      lines.push(
        '',
        'Token counts aggregate all measured agents and steps. Differences in generated trajectories and request lengths can change the absolute number of cache reads.',
      )
    }
  }
  return lines.join('\n') + '\n'
}
export function render(report: ComparisonReport) {
  const fmt = (x: number | null | undefined) => (x == null ? '—' : Number(x.toFixed(4)).toString())
  const lines = [
    '# Team benchmark',
    '',
    'Mode: ' + report.mode,
    '',
    '| Model | Preset | Mode | Arm | Pass@1 | pass³ | Milestone KPI | CVR | KV Cache Hit Rate | Tokens per Solved | Comm F1 | Noise Ratio | McNemar p | Wilcoxon p | Cliff’s δ | MAST Failures |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const a of report.arms) {
    const c = report.comparisons.find((c) => c.arm === a.arm && c.model === a.model && c.preset === a.preset)
    const row = [
      a.model.replaceAll('|', '\\|'),
      a.preset,
      a.mode,
      a.arm,
      ...[
        a.passAt1,
        a.passPow3,
        a.milestoneKpi,
        a.cvr,
        a.kvCacheHitRate,
        a.tokensPerSolved,
        a.commF1,
        a.noiseRatio,
        c?.pass.pValue,
        c?.continuous.milestone?.wilcoxon.pValue,
        c?.continuous.milestone?.cliffs.delta,
      ].map(fmt),
      sum(Object.values(a.mast)),
    ]
    lines.push('| ' + row.join(' | ') + ' |')
  }
  if (report.mode === 'live') {
    lines.push(
      '',
      '## Measured provider usage',
      '',
      '| Model | Arm | Trials | Uncached input | Cache read | Cache write | Output | Cache reads / prompt tokens |',
      '|---|---|---:|---:|---:|---:|---:|---:|',
    )
    for (const arm of report.arms) {
      const u = arm.providerUsage
      if (u)
        lines.push(
          '| ' +
            [
              arm.model,
              arm.arm,
              arm.trials,
              u.uncachedInput,
              u.cacheRead,
              u.cacheWrite,
              u.output,
              fmt(u.promptCacheReadShare),
            ].join(' | ') +
            ' |',
        )
    }
    lines.push(
      '',
      'Counters come from assistant/message usage across the measured sessions. Auxiliary requests recorded separately, such as compaction summaries, are outside this total. DSH records uncached input, cache reads and cache writes as disjoint counts. The final column divides cache reads by the sum of these three counts.',
    )
    lines.push(
      '',
      '## Scenario results',
      '',
      '| Scenario | Arm | Passed / measured | Mean milestone KPI | Missed checks |',
      '|---|---|---:|---:|---|',
    )
    for (const group of Map.groupBy(report.trials, (t) => [t.model, t.scenario, t.arm].join('/')).values()) {
      const missed = new Map<string, number>()
      for (const trial of group) {
        for (const [name, ok] of Object.entries(trial.verification.details.checks ?? {})) {
          if (ok === false) missed.set(name, (missed.get(name) ?? 0) + 1)
        }
      }
      const counts = [...missed]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, n]) => name + ' × ' + n)
        .join(', ')
      lines.push(
        '| ' +
          [
            group[0].scenario,
            group[0].arm,
            group.filter((t) => t.verification.passed).length + ' / ' + group.length,
            fmt(mean(group.map((t) => t.verification.milestoneKpi))),
            counts || '—',
          ].join(' | ') +
          ' |',
      )
    }
    lines.push(
      '',
      'S1 grades exact top-level JSON fields. S2 grades specified decision phrases as well as the saved facts. Missing a rubric check can reflect output format or phrasing.',
    )
  }
  lines.push(
    '',
    'McNemar uses paired success. Wilcoxon and Cliff’s δ in the table use milestone KPI versus the first selected protocol arm in canonical order. Positive δ favors the comparison arm on KPI. A dash denotes unavailable data. See summary.json for paired counts, 95% intervals, individual scenarios, learning gains and MAST counts.',
    '',
    '## Threats to validity',
    '',
    '- Internal: provider nondeterminism and prompt sensitivity affect comparisons. Pair the same scenario, model, preset and replicate.',
    '- External: these six local text tasks do not establish performance on large teams or multimodal workloads.',
    '- Construct: character counts and scripted communication checks are proxies for human workload. Human NASA-TLX and blinded ratings require separate data.',
    '- Conclusion: three replicates have limited power. Exploratory p-values are unadjusted, with percentile intervals over observed trials. Correlated trials may narrow these intervals.',
  )
  if (report.mode === 'live') {
    for (const [model, trials] of Map.groupBy(report.trials, (t) => t.model)) {
      const efforts = [...new Set(trials.flatMap((t) => t.reasoningEfforts ?? []))]
      if (efforts.length) lines.push('', model + ' recorded reasoning effort: ' + efforts.join(', ') + '.')
    }
    if (report.trials.some((t) => t.arm === 'single-agent' && ['S4', 'S5', 'S6'].includes(t.scenario)))
      lines.push(
        '',
        'The single-agent arm performs the same workspace task. It has no child seat to replace in S4, no inter-agent handoff or shared board in S5, and no persisted role training in S6. Interpret those structural checks separately from artifact correctness.',
      )
    lines.push(
      '',
      'Cache share divides cache reads by all prompt tokens (uncached input + cache reads + cache writes). Raw counter totals are in the trial records.',
    )
  }
  if (report.mode !== 'live')
    lines.push(
      '',
      'Synthetic observations validate the harness only. They are not model performance or measured provider cache behavior.',
    )
  return lines.join('\n') + '\n'
}
async function trialFiles(out: string) {
  out = await safePath(out)
  const dirs = (await readdir(await safePath(join(out, 'trials')))).sort()
  const ts: TrialResult[] = []
  for (const dir of dirs)
    ts.push(JSON.parse(await readFile(await safePath(join(out, 'trials', dir, 'metrics.json')), 'utf8')))
  return ts
}
export async function analyze(out: string, s4Control?: string) {
  out = await safePath(out)
  const ts = await trialFiles(out)
  const report = summarize(ts)
  const versionTrials = ts.filter((t) => t.arm === 'v0.1.0' || t.arm === 'v0.2.0-full')
  const versionComparisons =
    report.mode === 'live' && new Set(versionTrials.map((t) => t.arm)).size === 2
      ? summarize(versionTrials).comparisons
      : []
  const versionNotes = versionComparisons.map(
    ({ model, pairs, pass }) =>
      `Across ${pairs} matched scenario/repeat pairs for ${model}, v0.1.0 alone passed ${pass.b} and v0.2.0-full alone passed ${pass.c}. Two-sided exact McNemar p = ${Number(pass.pValue.toFixed(4))}.`,
  )
  let cacheAblation: ComparisonReport | undefined
  if (s4Control) {
    const full = ts.filter((t) => t.scenario === 'S4' && t.arm === 'v0.2.0-full')
    const prefix = await trialFiles(s4Control)
    if (
      !full.length ||
      full.length !== prefix.length ||
      !prefix.every(
        (b) =>
          b.mode === 'live' &&
          b.scenario === 'S4' &&
          b.arm === 'v0.2.0-prefix-brief' &&
          full.some((a) => a.model === b.model && a.repeat === b.repeat && a.preset === b.preset),
      )
    )
      throw new Error('S4 control must contain exactly the matched live prefix trials')
    cacheAblation = summarize([...full, ...prefix])
  }
  let coverage: { measured: number; planned: number; complete: boolean } | undefined
  if (report.mode === 'live') {
    const protocol = await readFile(await safePath(join(out, 'protocol.json')), 'utf8').then(
      JSON.parse,
      (err) => {
        if (err.code === 'ENOENT') return undefined
        throw err
      },
    )
    if (protocol) {
      const planned = protocol.scenarios.length * protocol.arms.length * protocol.repeats
      coverage = { measured: ts.length, planned, complete: ts.length === planned }
    }
  }
  let environmentNote = ''
  let environment
  let interruptions = 0
  if (report.mode === 'live') {
    const attempts = await readFile(await safePath(join(out, 'interruptions.jsonl')), 'utf8').catch((err) => {
      if (err.code !== 'ENOENT') throw err
      return ''
    })
    interruptions = attempts.split('\n').filter((line) => line.trim()).length
    const metadata = await readFile(await safePath(join(out, 'environment.json')), 'utf8').catch((err) => {
      if (err.code !== 'ENOENT') throw err
      return ''
    })
    if (metadata) {
      environment = JSON.parse(metadata)
      environmentNote =
        '\n## Runtime\n\n' +
        environment.host +
        ' with Node ' +
        environment.node +
        '. Historical plugin ' +
        environment.baselineTag +
        ' (' +
        environment.baselineCommit +
        ').' +
        (environment.subscription ? ' Subscription adapter ' + environment.subscription + '.' : '') +
        ' The host package and plugin file digests are recorded in environment.json.\n'
      if (environment.host === 'DSH Desktop runtime 0.2.2-rc.5')
        environmentNote +=
          '\nThe driver creates a fresh DSH profile, workspace, role store and session tree for every trial. ' +
          'The single agent receives all stakeholder cards. Teams use one card per seat and communicate through native DSH tools. ' +
          'The tool guard admits top-level fixture file reads, writes and edits plus the listed team and training operations. Shell and external MCP calls are outside this protocol. ' +
          'All arms receive the same scenario fixtures. Live session events provide usage, message and task evidence. ' +
          'The verifier checks workspace files and event order. Smoke trials are recorded separately from the matrix.\n' +
          '\nTrials run in fixed scenario, repeat and arm order. Fresh local state does not reset a provider’s shared prompt cache. ' +
          'Cache carryover and time-of-day effects can therefore influence comparisons. The S4 prefix control is a later block.\n'
    }
  }
  for (const [name, body] of [
    [
      'summary.json',
      JSON.stringify(
        {
          ...report,
          ...(coverage ? { coverage } : {}),
          ...(report.mode === 'live' && { interruptedAttempts: interruptions }),
          ...(cacheAblation ? { cacheAblation } : {}),
          ...(versionComparisons.length ? { versionComparisons } : {}),
          ...(environment ? { environment } : {}),
        },
        null,
        2,
      ) + '\n',
    ],
    [
      'report.md',
      render(report) +
        (versionNotes.length
          ? '\n## Paired plugin version comparison\n\n' + versionNotes.join('\n\n') + '\n'
          : '') +
        environmentNote +
        (interruptions
          ? '\nInterrupted infrastructure attempts: ' +
            interruptions +
            '. Their usage and outcomes are excluded. See interruptions.jsonl for affected trial IDs.\n'
          : '') +
        (cacheAblation ? renderCacheAblation(cacheAblation) : '') +
        (coverage
          ? '\n' +
            (coverage.complete ? 'Completed' : 'Interim') +
            ' sample: ' +
            coverage.measured +
            ' / ' +
            coverage.planned +
            ' scheduled trials.\n'
          : ''),
    ],
  ]) {
    const stage = join(out, '.report-' + crypto.randomUUID())
    await writeFile(stage, body, { flag: 'wx' })
    await rename(stage, join(out, name))
  }
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--v2') {
    const { reanalyze } = await import('./v2/reanalyze.ts')
    if (!process.argv[3] || process.argv.length > 5)
      throw Error('Expected --v2 <directory> [blind-ratings.json]')
    await reanalyze(process.argv[3], process.argv[4])
  } else {
    if (![3, 4].includes(process.argv.length))
      throw new Error('Usage: node benchmarks/analyze.ts <result-directory> [S4-prefix-directory]')
    await analyze(process.argv[2], process.argv[3])
  }
}
