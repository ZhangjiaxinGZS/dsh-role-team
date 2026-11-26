import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { safePath, syntheticMode } from '../types.ts'
import { catalogue } from './scenarios.ts'
import { auditDigest, blocks, defaultLimits, redact } from './protocol.ts'
import { checkHoldout } from './freeze.ts'
import { preflight } from './calibration.ts'
import { fixtureSponsor, offlinePort } from './offline.ts'
import { runProtocol, type Trial } from './driver.ts'
import { renderV2, reportV2 } from './report.ts'
import { blindPacket, blindSample, preferencePackets } from './review.ts'

export async function runOfflineV2(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      out: { type: 'string' },
      seed: { type: 'string', default: 'v2-protocol-1' },
      repeats: { type: 'string', default: '3' },
      'usd-per-million': { type: 'string', default: '1' },
      'max-wall-ms': { type: 'string' },
      'max-steps': { type: 'string' },
      'max-total-tokens': { type: 'string' },
    },
  })
  if (!v['dry-run']) throw Error('Benchmark v2 is in offline review. Use --dry-run.')
  const schedule = blocks(catalogue, Number(v.repeats), v.seed!)
  const price = Number(v['usd-per-million'])
  if (!Number.isFinite(price) || price < 0) throw Error('Invalid USD conversion')
  const limits = {
    maxWallMs: Number(v['max-wall-ms'] ?? defaultLimits.maxWallMs),
    maxSteps: Number(v['max-steps'] ?? defaultLimits.maxSteps),
    maxTotalTokens: Number(v['max-total-tokens'] ?? defaultLimits.maxTotalTokens),
  }
  const out = await safePath(v.out ?? 'benchmarks/results/v2-offline')
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out, { mode: 0o700 })
  const write = (path: string, value: unknown) =>
    writeFile(join(out, path), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await checkHoldout()
  const calibration = await preflight()
  await write('calibration.json', calibration)
  await write('protocol.json', {
    mode: syntheticMode,
    repeats: Number(v.repeats),
    limits,
    seed: v.seed,
    price,
    weights: [1, 0.1, 1.25, 4],
    catalogueSha256: createHash('sha256').update(JSON.stringify(catalogue)).digest('hex'),
    matrix: schedule.map((j) => ({ ...j, scenario: j.scenario.id })),
  })
  const trials: Trial[] = []
  for (const job of schedule) {
    const workspace = await mkdtemp(join(tmpdir(), 'role-team-v2-'))
    try {
      const t = await runProtocol(job, workspace, offlinePort(), fixtureSponsor, 'fixture-agent', limits)
      trials.push(t)
      const path = join('trials', t.split, t.scenario + '_' + t.arm + '_' + t.repeat)
      await mkdir(join(out, path), { recursive: true, mode: 0o700 })
      const { events, finalText, ...metrics } = t
      await write(join(path, 'metrics.json'), metrics)
      await write(join(path, 'audit.json'), {
        mode: syntheticMode,
        nonce: t.nonce,
        events: auditDigest(events),
        finalText: redact(finalText),
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
  const summary = reportV2(trials, price)
  await write('summary.json', { mode: syntheticMode, ...summary })
  const sample = blindSample(trials)
  for (const split of ['dev', 'holdout']) {
    const subset = trials.filter((t) => t.split === split)
    const packets = subset.map(blindPacket)
    const path = join('reviews', split)
    await mkdir(join(out, path), { recursive: true, mode: 0o700 })
    await write(join(path, 'judge.json'), packets)
    await write(
      join(path, 'human.json'),
      packets.filter((p) => sample.includes(p.id)),
    )
    await write(join(path, 'pairs.json'), preferencePackets(subset))
  }
  await writeFile(join(out, 'report.md'), renderV2(summary, price), { flag: 'wx' })
  return { trials: trials.length, calibration: calibration.length, out }
}
