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
import { reportV2 } from '../benchmarks/v2/report.ts'
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
  expect(catalogue.filter((s) => s.split === 'dev')).toHaveLength(10)
  expect(catalogue.filter((s) => s.split === 'holdout').map((s) => s.id)).toEqual([
    'E2',
    'E4',
    'G2',
    'G4',
    'C4',
  ])
  expect(new Set(catalogue.map((s) => s.archetype)).size).toBe(4)
  const a = blocks(catalogue, 3, 'seed'),
    b = blocks(catalogue, 3, 'seed'),
    c = blocks(catalogue, 3, 'changed')
  expect(a.length).toBe(150)
  expect(a.map((j) => j.arm)).toEqual(b.map((j) => j.arm))
  expect(a.map((j) => j.arm)).not.toEqual(c.map((j) => j.arm))
  expect(new Set([...a, ...b].map((j) => j.nonce)).size).toBe(300)
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
async function execute(limits: Limits = defaultLimits, port: Port = offlinePort()) {
  const workspace = await mkdtemp(join(tmpdir(), 'v2-test-'))
  try {
    const job = blocks(
      catalogue.filter((s) => s.id === 'G1'),
      1,
      'test',
    ).find((j) => j.arm === 'v0.2.0-full')!
    return await runProtocol(job, workspace, port, fixtureSponsor, 'fixture-agent', limits)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
it.each(['maxWallMs', 'maxSteps', 'maxTotalTokens'] as const)(
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

it('reserves concurrent provider calls against a single hard token cap and settles native usage once', async () => {
  const { Budget } = await import('../benchmarks/v2/protocol.ts')
  const meter = new Budget({ ...defaultLimits, maxTotalTokens: 100 })
  try {
    const finish = meter.reserve(60)
    finish(15)
    expect(meter.tokens).toBe(15)
    expect(() => finish(15)).toThrow()
    const first = meter.reserve(70)
    const second = meter.reserve(16)
    first(69)
    expect(() => second(16)).toThrow()
    expect(meter.controller.signal.reason).toBe('maxTotalTokens')
  } finally {
    meter.close()
  }
})
it('admits three concurrent 256k-output Flash requests after 700k settled and aborts on measured overrun', async () => {
  const { Budget, requestReservation } = await import('../benchmarks/v2/protocol.ts')
  const meter = new Budget({ ...defaultLimits, maxTotalTokens: 1_500_000 })
  try {
    meter.charge(0, 700_000)
    const estimate = requestReservation({ messages: [{ content: 'small' }], maxTokens: 256_000 }, 1_048_576)
    expect(estimate).toBeLessThan(100)
    const requests = Array.from({ length: 3 }, () => meter.reserve(estimate))
    expect(meter.controller.signal.aborted).toBe(false)
    requests[0](400_000)
    expect(() => requests[1](400_001)).toThrow()
    expect(meter.controller.signal.aborted).toBe(true)
    expect(() => requests[2](0)).toThrow()
    expect(meter.tokens).toBe(1_500_001)
    expect(meter.reserved).toBe(0)
    expect(meter.controller.signal.reason).toBe('maxTotalTokens')
    expect(() => meter.reserve(estimate)).toThrow()
  } finally {
    meter.close()
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
