import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogue } from '../benchmarks/v2/scenarios.ts'
import { calibrate, kinds, fixture } from '../benchmarks/v2/calibration.ts'
import {
  blocks,
  defaultLimits,
  sponsorTurn,
  writable,
  systemHeader,
  auditDigest,
  type Limits,
} from '../benchmarks/v2/protocol.ts'
import { runProtocol, type Port } from '../benchmarks/v2/driver.ts'
import { fixtureSponsor, offlinePort } from '../benchmarks/v2/offline.ts'
import { factChecks, clarification, verify } from '../benchmarks/v2/verifier.ts'
import { parseLogs, splitWallClock } from '../benchmarks/log-parser.ts'
import { effectiveCost, holmBonferroni } from '../benchmarks/stats.ts'
import { lengthControlledWinRate, reviewAgreement, blindId, interpret } from '../benchmarks/v2/review.ts'
import { reportV2, renderV2 } from '../benchmarks/v2/report.ts'
import { projects, projectSources } from '../benchmarks/v2/engineering.ts'

for (const s of catalogue)
  describe('v2 verifier ' + s.id, () => {
    it.each(kinds)(
      '%s',
      async (kind) => {
        await calibrate(s, kind)
      },
      30_000,
    )
  })

it('freezes distinct identities, splits, shared inputs, equal aids and adjacent randomized arm blocks', () => {
  expect(catalogue.filter((s) => s.split === 'dev')).toHaveLength(14)
  expect(catalogue.filter((s) => s.split === 'holdout').map((s) => s.id)).toEqual([
    'E2',
    'E4',
    'G2',
    'G4',
    'C4',
    'S3',
    'L3',
  ])
  expect(new Set(catalogue.map((s) => s.archetype)).size).toBe(4)
  const a = blocks(catalogue, 3, 'seed'),
    b = blocks(catalogue, 3, 'seed'),
    c = blocks(catalogue, 3, 'changed')
  expect(a.length).toBe(204)
  expect(a.map((j) => j.arm)).toEqual(b.map((j) => j.arm))
  expect(a.map((j) => j.arm)).not.toEqual(c.map((j) => j.arm))
  expect(new Set([...a, ...b].map((j) => j.nonce)).size).toBe(408)
  for (const [key, group] of Map.groupBy(a, (j) => j.scenario.id + '-' + j.repeat)) {
    expect(a.slice(a.indexOf(group[0]), a.indexOf(group[0]) + group.length)).toEqual(group)
    const { scenario: s } = group[0]
    expect(group.some((j) => j.arm === 'v0.2.0-prefix-brief')).toBe(['C3', 'C4'].includes(s.id))
    expect(group.some((j) => j.arm === 'v0.2.0-brief-only')).toBe(['G1', 'G2', 'E1', 'E2'].includes(s.id))
    expect(group.some((j) => j.arm === 'single-agent')).toBe(!s.multiAgentOnly)
    expect(key).toContain(s.id)
    if (!s.multiAgentOnly) expect(s.roles.some((r) => r.privateContext)).toBe(false)
    for (const j of group) expect(systemHeader(j.nonce)).toContain('scratchpad.md')
  }
  const g = catalogue.find((s) => s.id === 'G1')!
  expect(writable(g, 'lead', 'scratchpad.md')).toBe(true)
  expect(writable(g, 'ops', 'delivery.json')).toBe(false)
  expect(writable(g, 'lead', 'request.md')).toBe(false)
  expect(projectSources(projects[0])['eligible.ts']).toContain('TODO')
})

it('normalizes full typed quantities and rejects conflicting or unrelated evidence', () => {
  const g = catalogue.find((s) => s.id === 'G2')!
  for (const value of ['80 credits', 80, '80 积分'])
    expect(factChecks(g.facts, { 交付物: { 预算: value } }).budget).toBe(true)
  for (const value of ['80 days', '180 credits', 'about 80 or 7', true])
    expect(factChecks(g.facts, { budget: value }).budget).toBe(false)
  expect(factChecks(g.facts, { budget: 80, another: { 预算: 10 } }).budget).toBe(false)
})
it('scores ordering independently even for a correct artifact and equal timestamps', async () => {
  const s = catalogue.find((s) => s.id === 'G1')!,
    e = fixture(s, 'reference')
  const events = e.events.map((x, i) => ({ ...x, seq: 2 - i })).reverse()
  const bad = await verify(s, { ...e, events }, true)
  expect(bad.artifactPass).toBe(true)
  expect(bad.order).toBe(0)
  expect(bad.milestone).toBeLessThan(1)
  expect(clarification(s.card, events, false).order).toBeNull()
})
it('sponsor discloses only solicited slots and requires independent zero-temperature structured output', async () => {
  const card = catalogue.find((s) => s.id === 'G2')!.card!,
    signal = new AbortController().signal
  const sponsor = {
    provider: 'independent',
    async classify(input: Parameters<typeof fixtureSponsor.classify>[0]) {
      expect(input.temperature).toBe(0)
      expect(JSON.stringify(input.slots)).not.toContain('Tuesday')
      return { state: 'NEED_ANSWER' as const, slots: ['budget'] }
    },
  }
  const d = await sponsorTurn('agent', sponsor, card, '经费上限如何安排', signal)
  expect(d.reply).toBe('budget = 80 credits')
  await expect(sponsorTurn('independent', sponsor, card, '?', signal)).rejects.toThrow('Independent')
  await expect(
    sponsorTurn(
      'agent',
      {
        ...sponsor,
        async classify() {
          return { state: 'TASK_DONE', slots: ['owner'] }
        },
      },
      card,
      'done',
      signal,
    ),
  ).rejects.toThrow('Invalid')
})
it('accounts for disjoint time, all actors, weighted costs and ordered cross-agent reads', () => {
  expect(
    splitWallClock(0, 100, [
      { kind: 'setupMs', start: 0, end: 15 },
      { kind: 'retryBackoffMs', start: 10, end: 30 },
      { kind: 'retryBackoffMs', start: 20, end: 40 },
      { kind: 'simUserMs', start: 60, end: 70 },
    ]),
  ).toEqual({ setupMs: 15, retryBackoffMs: 25, simUserMs: 10, agentWallMs: 50 })
  const trace = (times: number[]) => ({
    leader: false,
    text: times
      .map((time) =>
        JSON.stringify({
          time,
          type: 'tool/call',
          data: { name: 'read', arguments: { file_path: 'plan.md' } },
        }),
      )
      .join('\n'),
  })
  expect(parseLogs([trace([3, 4]), trace([1, 2, 5])])).toMatchObject({ readCalls: 5, redundantReads: 3 })
  expect(
    effectiveCost({ inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 4, outputTokens: 5 }, 2),
  ).toEqual({ units: 45, estimatedUsd: 0.00009 })
  expect(holmBonferroni([0.04, 0.001, 0.03])).toEqual([0.06, 0.003, 0.06])
})
async function execute(limits: Limits = defaultLimits, port: Port = offlinePort(), sponsor = fixtureSponsor) {
  const workspace = await mkdtemp(join(tmpdir(), 'v2-test-'))
  try {
    const job = blocks(
      catalogue.filter((s) => s.id === 'G1'),
      1,
      'test',
    ).find((j) => j.arm === 'v0.2.0-full')!
    return await runProtocol(job, workspace, port, sponsor, 'fixture-agent', limits)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
it.each(['maxWallMs', 'maxSteps', 'maxWeightedCostUnits'] as const)(
  'hard cap %s is a measured failure',
  async (cap) => {
    const port = offlinePort()
    if (cap === 'maxWallMs') port.ask = () => new Promise(() => {})
    const t = await execute({ ...defaultLimits, [cap]: cap === 'maxWallMs' ? 30 : 1 }, port)
    expect(t.status).toBe('budget_exceeded')
    expect(t.cap).toBe(cap)
    expect(t.verification.artifactPass).toBe(false)
  },
)
it('keeps blind scores unavailable pending ratings and handles paired length adjustment', async () => {
  const t = await execute()
  expect(t.status).toBe('finished')
  expect(reviewAgreement([t], {})).toMatchObject({ required: 1, alpha: null, accepted: false })
  expect(reviewAgreement([t], { [blindId(t)]: { judge: [0, 1], human: [0, 1] } })).toMatchObject({
    alpha: 1,
    accepted: true,
  })
  const coding = {
    atoms: [['audience'], ['budget'], ['deadline'], []],
    correctAssignments: ['ops', 'finance'],
    firstPass: ['ops'],
    retained: [],
  }
  expect(interpret(t, coding).f1).toBeCloseTo(6 / 7)
  expect(
    lengthControlledWinRate([
      { lengthDiff: -1, win: 0 },
      { lengthDiff: -1, win: 1 },
      { lengthDiff: 1, win: 0 },
      { lengthDiff: 1, win: 1 },
    ]),
  ).toBeCloseTo(0.5)
  const r = reportV2([t], 1)
  expect(r.summaries[0].metrics.f1).toBeNull()
  expect(r.summaries[0].metrics.stable).toBeNull()
})
it('exports allowlisted native data and removes local paths and secrets', () => {
  const event = {
    seq: 1,
    time: 1,
    type: 'assistant/message',
    actor: 'lead',
    text: 'count 7; /Users/private/log; Bearer fake-secret; token=secret-value',
    extra: 'private',
  }
  const json = JSON.stringify(auditDigest([event]))
  expect(json).toContain('count 7')
  expect(json).not.toMatch(/Users|fake-secret|secret-value|private/)
})

it('charges concurrent native settlements at exact cache weights and stops at the measured boundary', async () => {
  const { Budget, scenarioLimits } = await import('../benchmarks/v2/protocol.ts')
  expect(
    ['S1', 'E5', 'L3'].map((id) => scenarioLimits(catalogue.find((s) => s.id === id)!).maxSteps),
  ).toEqual([40, 100, 160])
  const b = new Budget(defaultLimits)
  const u = { inputTokens: 0, cacheReadTokens: 1_500_000, cacheWriteTokens: 0, outputTokens: 0 }
  try {
    for (let i = 0; i < 4; i++) b.charge(1, u)
    expect(b.weightedCostUnits).toBe(600_000)
    expect(() => b.charge(1, { ...u, cacheReadTokens: 0, outputTokens: 100_000 })).toThrow()
    expect(b.controller.signal.reason).toBe('maxWeightedCostUnits')
  } finally {
    b.close()
  }
})
it('preserves native event names during redaction and charges native auxiliary usage', () => {
  expect(
    auditDigest([{ actor: 'lead', type: 'request/header', route: 'adapter:model', seq: 1, time: 0 }])[0].type,
  ).toBe('request/header')
  expect(
    parseLogs([
      {
        leader: false,
        text: JSON.stringify({
          type: 'provider/usage',
          data: { usage: { inputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 30, outputTokens: 12 } },
        }),
      },
    ]),
  ).toMatchObject({ kvCacheHitRate: 0.6, totalTokens: 112 })
})

it('checks the frozen holdout manifest before evaluating trials', async () => {
  const { checkHoldout } = await import('../benchmarks/v2/freeze.ts')
  await expect(checkHoldout()).resolves.toBeUndefined()
})
it('prevents scripted brief or training help in the autonomous scenarios', async () => {
  for (const id of ['C1', 'C2', 'E6', 'C3', 'C4']) {
    const s = catalogue.find((s) => s.id === id)!
    const job = blocks([s], 1, 'actions').find((j) => j.arm === 'v0.2.0-full')!
    const port = offlinePort(),
      calls: string[] = []
    for (const key of ['fresh', 'compactReset', 'reviseBrief'] as const) {
      const method = port[key].bind(port) as (...args: unknown[]) => Promise<void>
      port[key] = async (...args: unknown[]) => {
        calls.push(key)
        await method(...args)
      }
    }
    const tmp = await mkdtemp(join(tmpdir(), 'v2-stage-test-'))
    try {
      await runProtocol(job, tmp, port, fixtureSponsor, 'fixture-agent', defaultLimits)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
    expect(calls).toEqual(
      id === 'E6'
        ? ['fresh']
        : ['C1', 'C2'].includes(id)
          ? ['compactReset']
          : s.stages.map(() => 'reviseBrief'),
    )
  }
}, 20000)

it('vetoes an otherwise correct artifact if a protected input changed', async () => {
  const port = offlinePort()
  const original = port.start
  port.start = async (o) => {
    await original(o)
    await writeFile(join(o.workspace, 'request.md'), 'altered fixture')
  }
  const result = await execute(defaultLimits, port)
  expect(result.modifiedInputs).toEqual(['request.md'])
  expect(result.verification.violation).toBe(true)
  expect(result.verification.artifactPass).toBe(false)
})

it('permits shared notes and protects the four-signoff input on all seats', () => {
  const s = catalogue.find((s) => s.id === 'G5')!
  for (const r of s.roles) {
    expect(writable(s, r.id, 'scratchpad.md')).toBe(true)
    expect(writable(s, r.id, 'review.md')).toBe(false)
  }
})

it('rebinds early session events by stable seat even after another seat joins or resets', async () => {
  const { SeatActors } = await import('../benchmarks/drivers/v2-host.ts')
  const seats = new SeatActors()
  const pending = seats.actor('session-finance')
  seats.bind('session-finance', 'finance')
  seats.bind('session-support', 'support')
  seats.bind('replacement', 'finance')
  expect(seats.resolve(pending)).toBe('finance')
  expect(seats.actor('session-support')).toBe('support')
  expect(seats.resolve(seats.actor('other'))).toBe('auxiliary')
  expect(() => seats.bind('session-finance', 'support')).toThrow()
})

it('recognizes equivalent facts while rejecting inconsistent dates, alternatives and measurements', () => {
  const check = (id: string, key: string, value: string) =>
    factChecks(catalogue.find((s) => s.id === id)!.facts, { [key]: value }, id)[key]
  for (const [id, key, value] of [
    ['C1', 'region', 'east depot'],
    ['C2', 'deadline', '2026-11-30'],
    ['C2', 'deadline', 'Monday, 2026-11-30'],
    ['G3', 'option', 'Harbor (70 credits, 20 ms)'],
    ['G3', 'alternative', 'Reef (95 credits, 8 ms, cap must rise to ≥95)'],
    ['G3', 'tradeoff', 'Reef costs 25 credits more and cuts latency by 12 ms'],
    ['G3', 'tradeoff', '多花25积分，节省12毫秒'],
    ['G3', 'tradeoff', '25 more credits buys 12 ms lower latency'],
  ])
    expect(check(id, key, value), value).toBe(true)
  for (const [id, key, value] of [
    ['C1', 'region', 'east depot or west'],
    ['C2', 'deadline', 'Monday, 2026-12-01'],
    ['C2', 'deadline', '2026-02-30'],
    ['G3', 'option', 'Harbor (95 credits)'],
    ['G3', 'alternative', 'Reef (95 credits, 80 ms)'],
    ['G3', 'tradeoff', 'Reef costs 25 credits more and cuts latency by 8 ms'],
    ['G3', 'tradeoff', 'Reef is faster and cheaper'],
  ])
    expect(check(id, key, value), value).toBe(false)
})

it('distinguishes repeated identical failed steps from independent retries and successful work', async () => {
  const { Budget } = await import('../benchmarks/v2/protocol.ts')
  const b = new Budget(defaultLimits)
  try {
    for (let step = 1; step <= 3; step++) {
      b.toolOutcome('one', 'same', 1, step)
      b.toolOutcome('two', 'different', 1, step)
    }
    b.toolOutcome('one', undefined, 1, 3)
    b.toolOutcome('one', 'same', 1, 4)
    b.toolOutcome('two', 'different', 1, 3)
    expect(b.controller.signal.aborted).toBe(false)
    b.toolOutcome('two', 'different', 1, 4)
    expect(b.controller.signal.reason).toBe('repeatedFailureLoop')
  } finally {
    b.close()
  }
})

it.each(['recover', 'invalid twice', 'unfinished'])(
  'audits and retries a blinded fixture ballot: %s',
  async (mode) => {
    const { independentCoding } = await import('../benchmarks/drivers/v2-judges.ts')
    const { blindPacket } = await import('../benchmarks/v2/review.ts')
    const packet = blindPacket(await execute()),
      accepted = {
        atoms: [['budget']],
        firstPass: ['ops'],
        correctAssignments: ['ops'],
        retained: ['budget'],
      }
    const rejected: import('../benchmarks/drivers/v2-judges.ts').RejectedBallot[] = []
    let calls = 0
    const ctx = {
      llm: {
        async *stream(options: { messages: unknown[] }) {
          calls++
          expect(JSON.stringify(options.messages)).toContain('additionalProperties')
          const valid = mode === 'recover' && calls === 2
          yield {
            type: 'text-delta',
            text: JSON.stringify(valid ? accepted : { ...accepted, retained: ['ops'] }),
          }
          yield { type: 'finish', reason: { kind: mode === 'unfinished' ? 'length' : 'stop' } }
        },
      },
    } as unknown as import('@deepseek-ai/cordis').Context
    const run = independentCoding(
      ctx,
      'agent',
      { provider: 'judge', model: 'fixture' },
      packet,
      new AbortController().signal,
      rejected,
    )
    if (mode === 'recover') await expect(run).resolves.toEqual(accepted)
    else await expect(run).rejects.toThrow('both')
    expect(calls).toBe(2)
    expect(rejected).toHaveLength(mode === 'recover' ? 1 : 2)
    expect(rejected[0].payload).toContain('"retained":["ops"]')
    expect(rejected[0].reason).toMatch(mode === 'unfinished' ? /length/ : /retained/)
  },
)

it('reports missing planned cells separately from inapplicable arms and preserves matched denominators', async () => {
  const { scorecard } = await import('../benchmarks/v2/scorecard.ts')
  const t = await execute()
  const board = scorecard(
    [t],
    catalogue.filter((s) => ['G1', 'G5'].includes(s.id)),
    1,
    'live',
  )
  expect(board.matrix.find((r) => r.scenario === 'G5')!.cells[0]).toBe('N/A')
  expect(board.matrix.find((r) => r.scenario === 'G1')!.cells[0]).toContain('ERR/MISSING')
  expect(board.matrix.find((r) => r.scenario === 'G1')!.cells[2]).toContain('🟢')
  expect(board.tiers[1].ranking).toHaveLength(0)
})

it('separates an S2 no-write instruction from prohibited input mutation', async () => {
  const s = catalogue.find((s) => s.id === 'S2')!
  const e = fixture(s, 'reference')
  expect((await verify(s, { ...e, artifact: { duration: 12 } }, true)).artifactPass).toBe(false)
  expect(
    (await verify(s, { ...e, artifact: { duration: 'The duration for item K03 is 12 minutes.' } }, true))
      .artifactPass,
  ).toBe(true)
  e.events.push({ seq: 3, time: 2, actor: 'ops', type: 'tool/call', tool: 'write' })
  expect(writable(s, 'ops', 'scratchpad.md')).toBe(true)
  expect(await verify(s, e, true)).toMatchObject({
    artifactPass: false,
    violation: false,
    stages: [{ duration: true, readOnly: false }],
  })
})

it('requires feasible rosters at both handoffs, including the early callout fee', async () => {
  const s = catalogue.find((s) => s.id === 'L3')!
  const e = fixture(s, 'reference')
  const overBudget = { lift: 'A2', audit: 'C1', seal: 'B3' }
  for (const record of [
    { ...e, decisions: [overBudget] },
    { ...e, artifact: overBudget },
  ]) {
    const v = await verify(s, record, true)
    expect(v.artifactPass).toBe(false)
    expect(v.stages).toContainEqual({ staffed: true, schedule: true, qualified: true, affordable: false })
  }
})

it('delivers the last G1 facts and confirmation together, then stops the sponsor before another classification', async () => {
  const port = offlinePort()
  const original = port.ask.bind(port)
  const prompts: string[] = []
  port.ask = async (text) => {
    prompts.push(text)
    return original(text)
  }
  const answers = [['budget'], ['audience', 'deadline']]
  let calls = 0
  const t = await execute(defaultLimits, port, {
    provider: 'fixture-sponsor',
    async classify() {
      if (calls === answers.length) throw Error('Extra sponsor turn')
      return { state: 'NEED_ANSWER', slots: answers[calls++], correction: true }
    },
  })
  expect(calls).toBe(2)
  expect(prompts).toHaveLength(3)
  expect(prompts[1]).toBe('budget = 40 credits')
  expect(prompts[2]).toMatch(/audience = operators; deadline = Friday\nThat completes/)
  expect(t.events.filter((e) => e.type === 'sponsor/done')).toHaveLength(1)
  expect(t.finalText).toContain('Friday')
})

it('G5 accepts the four reported facts without signatures and rejects withheld values', async () => {
  const s = catalogue.find((s) => s.id === 'G5')!
  const data = Object.fromEntries(s.roles.slice(1).map((r) => r.privateContext!.split(' = ')))
  const e = fixture(s, 'reference')
  expect(s.prompt).toContain('delivery.json')
  expect(s.files['review.md']).toContain('provide their fact directly')
  expect((await verify(s, { ...e, artifact: data }, true)).artifactPass).toBe(true)
  expect((await verify(s, { ...e, artifact: { ...data, 预算: 'WITHHELD' } }, true)).artifactPass).toBe(false)
})

it('distinguishes skipped offline judges, unavailable live ballots and inapplicable metrics', async () => {
  const t = await execute()
  const trials = [t, { ...t, nonce: 'other', arm: 'single-agent' as const }]
  const plan = { scenarios: catalogue.filter((s) => s.id === 'G1'), repeats: 1 }
  for (const mode of ['live', 'offline'] as const) {
    const report = reportV2(trials, 1, {}, { ...plan, mode })
    const expected = mode === 'live' ? 'ERR/MISSING' : 'SKIPPED (offline)'
    const md = renderV2(report, 1)
    expect(md).toContain('| 6 · Semantic communication F1 | ' + expected + ' | ' + expected + ' |')
    expect(md).toContain('| 8 · Appropriate delegation | ' + expected + ' | N/A |')
    expect(md).toContain('| 9 · Handoff fidelity | N/A | N/A |')
    expect(report.pairStatus).toBe('N/A')
    expect(report.summaries[0].missingBallots).toBe(Number(mode === 'live'))
    const pairTrials = trials.map((row) => ({ ...row, scenario: 'G3' as const }))
    expect(
      reportV2(pairTrials, 1, {}, { ...plan, scenarios: catalogue.filter((s) => s.id === 'G3'), mode })
        .pairStatus,
    ).toBe(expected)
  }
})
