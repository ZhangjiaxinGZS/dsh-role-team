import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  bootstrapCI,
  cliffsDelta,
  communicationF1,
  krippendorffAlpha,
  mcnemarExact,
  passAt1,
  passPowK,
  wilcoxonSignedRank,
} from '../benchmarks/stats.ts'
import { parseLogs } from '../benchmarks/log-parser.ts'
import { scenarios } from '../benchmarks/scenarios/index.ts'
import { run, simulateTrial } from '../benchmarks/runner.ts'
import { summarize } from '../benchmarks/analyze.ts'
import { safePath, syntheticMode, type ComparisonReport, type ScenarioId } from '../benchmarks/types.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'benchmark-test-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('estimates all-k reliability without replacement and bootstraps a seeded percentile interval', () => {
  expect(passAt1([])).toBe(0)
  expect(passAt1([true, false, true])).toBeCloseTo(2 / 3)
  expect(passPowK([true, true, true, true, false], 3)).toBeCloseTo(0.4)
  expect(passPowK([true, true], 3)).toBe(0)
  expect(passPowK([false, false, true], 2)).toBe(0)
  expect(passPowK(Array(1000).fill(true), 500)).toBe(1)
  expect(bootstrapCI([0, 2])).toEqual({ mean: 1, median: 1, low: 0, high: 2 })
  expect(bootstrapCI([4])).toEqual({ mean: 4, median: 4, low: 4, high: 4 })
  const sampled = () => bootstrapCI([1, 2, 9, 15], { iterations: 100, seed: 123, alpha: 0.1 })
  expect(sampled()).toEqual(sampled())
  expect(() => bootstrapCI([])).toThrow()
})

it('uses exact two-sided McNemar and exact or tie-corrected Wilcoxon probabilities', () => {
  expect(mcnemarExact([[true, true]])).toEqual({ b: 0, c: 0, pValue: 1 })
  expect(
    mcnemarExact([[true, false], ...Array<[boolean, boolean]>(9).fill([false, true])]).pValue,
  ).toBeCloseTo(22 / 1024, 12)
  expect(
    mcnemarExact([
      ...Array<[boolean, boolean]>(1000).fill([true, false]),
      ...Array<[boolean, boolean]>(1000).fill([false, true]),
    ]).pValue,
  ).toBeCloseTo(1, 9)
  expect(wilcoxonSignedRank([[1, 1]])).toEqual({ w: 0, n: 0, pValue: 1 })
  expect(
    wilcoxonSignedRank([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [9, 9],
    ]),
  ).toEqual({ w: 0, n: 5, pValue: 2 / 32 })
  const tied = wilcoxonSignedRank([
    [1, 0],
    [1, 0],
    [2, 0],
    [-3, 0],
  ])
  expect(tied.w).toBe(4)
  expect(tied.pValue).toBeCloseTo(0.8539, 3)
})

it('computes Cartesian dominance, ordinal coincidence distances, missing ratings and comm F1', () => {
  expect(cliffsDelta([1, 2], [2, 3])).toEqual({ delta: -0.75, magnitude: 'large' })
  expect(cliffsDelta([2], [2])).toEqual({ delta: 0, magnitude: 'negligible' })
  expect(
    krippendorffAlpha(
      [
        [0, 0, 1, 1, null],
        [0, 1, 1, 1, 2],
      ],
      'nominal',
    ),
  ).toBeCloseTo(8 / 15)
  expect(
    krippendorffAlpha(
      [
        [0, 1, 2],
        [0, 2, 2],
      ],
      'ordinal',
    ),
  ).toBeCloseTo(7 / 9)
  expect(
    krippendorffAlpha(
      [
        [0, 1],
        [0, 1],
      ],
      'nominal',
    ),
  ).toBe(1)
  expect(krippendorffAlpha([[1], [1]], 'nominal')).toBeNaN()
  expect(communicationF1(0, 0)).toBe(0)
  expect(communicationF1(1, 0.5)).toBeCloseTo(2 / 3)
})

const row = (type: string, data: unknown = {}) => ({ type, data })
const message = (kind: string, text: string) =>
  row('user/message', { source: { kind }, content: [{ type: 'text', text }] })
const jsonl = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join('\n')
it('parses native payloads, nested PTC args, wrappers and separate per-session compaction windows', () => {
  const sync = message('team-brief', 'brief'),
    compact = row('compaction/summary')
  const args = { a: 1, b: 2 }
  const leader = [
    row('session'),
    sync,
    compact,
    row('step/start'),
    compact,
    sync,
    row('step/start'),
    compact,
    message('subagent-settled', 'x'.repeat(120)),
    row('assistant/message', {
      message: {
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: 'text' },
        ],
      },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 15,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
      },
    }),
    row('tool/call', { name: 'send_message', arguments: JSON.stringify(args) }),
    { event: row('tool/ptc-dispatch-start', { name: 'send_message', arguments: { b: 2, a: 1 } }) },
    row('tool/call', { name: 'send_message', arguments: args }),
    row('tool/call', { name: 'read_file' }),
    row('tool/result', {
      message: { isError: true, content: [{ type: 'text', text: 'Permission denied' }] },
    }),
    row('tool/result', { isError: true, content: 'missing file' }),
    row('team/task', { task: { id: 'a', status: 'in_progress' } }),
    row('team/task', { task: { id: 'b', status: 'in_progress' } }),
    row('team/task', { task: { id: 'b', status: 'completed' } }),
    compact,
  ]
  const member = [
    row('assistant/message', {
      message: { content: 'not a leader answer' },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 8 },
    }),
    message('agent-message', 'not leader noise'),
    compact,
    row('step/start'),
  ]
  const m = parseLogs([
    { leader: true, text: jsonl(leader) },
    { leader: false, text: jsonl(member) },
  ])
  expect(m).toMatchObject({
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 22,
    cacheReadTokens: 15,
    cacheWriteTokens: 2,
    reasoningTokens: 3,
    kvCacheHitRate: 1,
    briefSyncCount: 2,
    compactionCount: 5,
    postCompactionResyncRate: 1 / 3,
    coordinationSteps: 3,
    taskWorkSteps: 1,
    coordinationRatio: 0.75,
    leaderAnswerChars: 4,
    rawTeammateReportChars: 120,
    compactTeammateReportChars: 80,
    compactCollapsedNoiseRatio: 80 / 84,
    defaultExpandedNoiseRatio: 120 / 124,
    deniedToolCalls: 1,
    staleInProgressTasks: 1,
    repeatedIdenticalToolCalls: 1,
  })
  expect(parseLogs([])).toMatchObject({ kvCacheHitRate: null, postCompactionResyncRate: null })
  expect(() => parseLogs([{ text: '{\n', leader: false }])).toThrow('line 1')
})

it.each(Object.keys(scenarios) as ScenarioId[])(
  '%s rejects missing artifacts and missing evidence, accepts its completed fixture, vetoes a policy violation',
  async (id) => {
    const s = scenarios[id],
      workspace = join(root, 'work'),
      traceDir = join(root, 'logs')
    await mkdir(workspace)
    await mkdir(traceDir)
    await s.seedWorkspace(workspace)
    const empty = { workspace, observations: [], workers: s.roles.slice(1).map((r) => r.id) }
    expect((await s.verify(empty)).passed).toBe(false)
    const run = await simulateTrial({
      scenario: s,
      arm: 'v0.2.0-full',
      model: 'fixture:local',
      preset: 'standard',
      repeat: 1,
      workspace,
      traceDir,
      roleStoreDir: root,
      dshHome: root,
    })
    const ctx = { ...empty, ...run }
    const result = await s.verify(ctx)
    expect(result).toMatchObject({ passed: true, milestoneKpi: 1, constraintViolations: 0 })
    if (id === 'S1') {
      expect(result.hiddenFactsPooled).toBe(5)
      await writeFile(join(workspace, 'delivery.json'), '{"offer":"Beta","region":"EU"}')
      expect(await s.verify(ctx)).toMatchObject({
        passed: false,
        hiddenFactsPooled: 1,
        constraintViolations: 1,
      })
    } else {
      expect((await s.verify({ ...ctx, observations: [] })).passed).toBe(false)
    }
    if (id === 'S2')
      expect(result).toMatchObject({ clarificationCoverage: 1, commPrecision: 1, commRecall: 1 })
    if (id === 'S3') expect(result).toMatchObject({ adaptationLatencySteps: 1, postPivotCoherence: 1 })
    if (id === 'S4') expect(result.postCompactionRetention).toBe(1)
    if (id === 'S5') {
      const dropped = await s.verify({
        ...ctx,
        observations: ctx.observations.filter((e) => e.kind !== 'report' || e.actor !== 'audit'),
      })
      expect(dropped).toMatchObject({ passed: false, closedLoopRate: 0.75, handoffFidelity: 0.75 })
    }
    if (id === 'S6') expect(result).toMatchObject({ stage1Passed: true, stage2Passed: true })
    await writeFile(join(workspace, 'release-policy.txt'), 'online')
    expect((await s.verify(ctx)).constraintViolations).toBeGreaterThan(0)
  },
)

it('runs all 5 × 6 × 3 offline via the CLI and reports paired statistics, per-task reliability and mode', async () => {
  const out = join(root, 'result')
  await promisify(execFile)(process.execPath, [
    'benchmarks/runner.ts',
    '--dry-run',
    '--preset',
    'ptc',
    '--out',
    out,
  ])
  const report: ComparisonReport = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))
  expect(report.mode).toBe(syntheticMode)
  expect(report.trials.length).toBe(90)
  expect(report.arms).toHaveLength(5)
  expect(report.comparisons).toHaveLength(4)
  expect(report.comparisons.every((c) => c.pairs === 18)).toBe(true)
  const full = report.arms.find((a) => a.arm === 'v0.2.0-full')!,
    prefix = report.arms.find((a) => a.arm === 'v0.2.0-prefix-brief')!
  expect(full.passPow3).toBe(1)
  expect(full.kvCacheHitRate!).toBeGreaterThan(prefix.kvCacheHitRate!)
  expect(full.noiseRatio).toBeLessThan(report.arms.find((a) => a.arm === 'v0.1.0')!.noiseRatio)
  expect(full.intervals.milestone).toMatchObject({ low: 1, high: 1 })
  const subset = report.trials
    .filter((t) => t.arm === 'v0.2.0-full' && ['S1', 'S2'].includes(t.scenario))
    .map((t) => ({ ...t, verification: { ...t.verification, passed: t.scenario === 'S1' } }))
  expect(summarize(subset).arms[0].passPow3).toBe(0.5)
  expect(() => summarize([subset[0], subset[0]])).toThrow('Duplicate')
  expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('Threats to validity')
  expect(await readdir(join(out, 'trials'))).toHaveLength(90)
  expect(await readdir(join(out, 'trials', 'S1_v0.2.0-full_1'))).toEqual(['metrics.json'])
}, 30000)

it('refuses unsupported live arms and missing stage capabilities in an isolated child, without synthetic fallback', async () => {
  await expect(run(['--live'])).rejects.toThrow('--host-module')
  await expect(safePath(join(homedir(), '.dsh', 'forbidden'))).rejects.toThrow('out of bounds')
  const module = join(root, 'driver.mjs')
  await writeFile(
    module,
    "export default {arms:['v0.2.0-full'],capabilities:[],runTrial(){throw Error('Unexpected invocation')}}",
  )
  const cli = resolve('benchmarks/runner.ts')
  for (const [arm, scenario, reason] of [
    ['single-agent', 'S1', 'Unsupported live arm'],
    ['v0.2.0-full', 'S4', 'Missing live capabilities'],
  ]) {
    const out = join(root, scenario)
    await expect(
      promisify(execFile)(process.execPath, [
        cli,
        '--live',
        '--arms',
        arm,
        '--scenarios',
        scenario,
        '--model',
        'test:contract',
        '--host-module',
        module,
        '--out',
        out,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(reason) })
    expect(await readdir(join(out, 'trials'))).toEqual([])
  }
})

it('rejects a saved low-effort Codex trial before resuming the high-effort matrix', async () => {
  const out = join(root, 'effort-check')
  const hostModule = resolve('benchmarks/drivers/dsh-local-driver.ts')
  const model = 'openai-codex:gpt-6.2-astra'
  const dest = join(out, 'trials', 'S1_single-agent_1')
  await mkdir(dest, { recursive: true })
  await writeFile(
    join(out, 'protocol.json'),
    JSON.stringify({
      model,
      reasoningEffort: 'high',
      preset: 'standard',
      repeats: 1,
      scenarios: ['S1'],
      arms: ['single-agent'],
      hostModule,
    }),
  )
  await writeFile(
    join(dest, 'metrics.json'),
    JSON.stringify({
      model,
      preset: 'standard',
      repeat: 1,
      scenario: 'S1',
      arm: 'single-agent',
      mode: 'live',
      reasoningEfforts: ['low'],
      metrics: {},
      verification: {},
    }),
  )
  await expect(
    run([
      '--live',
      '--resume',
      '--host-module',
      hostModule,
      '--model',
      model,
      '--arms',
      'single-agent',
      '--scenarios',
      'S1',
      '--repeats',
      '1',
      '--out',
      out,
    ]),
  ).rejects.toThrow('Invalid completed trial')
})

it('executes the trusted driver contract with isolated roots and deletes ephemeral evidence', async () => {
  // Test fixture for the driver protocol only; no model performance is claimed.
  const driver = join(root, 'contract.mjs'),
    receipt = join(root, 'receipt.json'),
    out = join(root, 'out')
  await writeFile(
    driver,
    [
      "import {writeFile, readFile} from 'node:fs/promises'",
      "import {join} from 'node:path'",
      "export default {arms:['single-agent'],capabilities:[], async runTrial(t){",
      "if (process.env.DSH_HOME!==t.dshHome) throw Error('Incorrect DSH_HOME')",
      "await readFile(join(t.roleStoreDir,'lead','role.md'),'utf8')",
      "const path=join(t.traceDir,'root.jsonl')",
      "await writeFile(path,JSON.stringify({type:'assistant/message',data:{message:{content:'PRIVATE-TEST-CONTENT'},usage:{inputTokens:25,outputTokens:4}}}))",
      'await writeFile(process.env.BENCH_TEST_RECEIPT,JSON.stringify(t.dshHome))',
      "return {workers:['lead'],traces:[{path,leader:true}],observations:[]}}}",
    ].join('\n'),
  )
  await promisify(execFile)(
    process.execPath,
    [
      'benchmarks/runner.ts',
      '--live',
      '--host-module',
      driver,
      '--arms',
      'single-agent',
      '--model',
      'test:contract',
      '--scenarios',
      'S1',
      '--repeats',
      '1',
      '--out',
      out,
    ],
    { env: { ...process.env, BENCH_TEST_RECEIPT: receipt } },
  )
  const summary = await readFile(join(out, 'summary.json'), 'utf8')
  expect(summary).not.toContain('PRIVATE-TEST-CONTENT')
  expect(JSON.parse(summary).arms[0].providerUsage).toEqual({
    uncachedInput: 25,
    cacheRead: 0,
    cacheWrite: 0,
    output: 4,
    promptCacheReadShare: 0,
  })
  expect(JSON.parse(summary).trials[0]).toMatchObject({
    mode: 'live',
    metrics: { totalTokens: 29 },
    verification: { passed: false },
  })
  await expect(readdir(JSON.parse(await readFile(receipt, 'utf8')))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
