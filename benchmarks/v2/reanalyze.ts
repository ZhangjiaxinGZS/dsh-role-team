import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safePath, syntheticMode } from '../types.ts'
import { catalogue } from './scenarios.ts'
import { blocks } from './protocol.ts'
import { reportV2, renderV2, type Reviews } from './report.ts'
import type { Trial } from './driver.ts'

export async function reanalyze(out: string, reviewFile?: string) {
  out = await safePath(out)
  const json = async (name: string) => JSON.parse(await readFile(await safePath(name), 'utf8'))
  const manifest = await json(join(out, 'protocol.json'))
  if (manifest.mode !== syntheticMode) throw Error('Expected an offline v2 protocol')
  const expected = blocks(catalogue, manifest.repeats, manifest.seed)
  if (
    manifest.matrix.length !== expected.length ||
    new Set(manifest.matrix.map((j: { nonce: string }) => j.nonce)).size !== expected.length
  )
    throw Error('Incomplete or duplicate matrix')
  const ts: Trial[] = []
  for (const [i, j] of expected.entries()) {
    const saved = manifest.matrix[i]
    if (saved.scenario !== j.scenario.id || saved.arm !== j.arm || saved.repeat !== j.repeat)
      throw Error('Unexpected matrix order')
    const root = join(out, 'trials', j.scenario.split, j.scenario.id + '_' + j.arm + '_' + j.repeat)
    const metrics = await json(join(root, 'metrics.json')),
      audit = await json(join(root, 'audit.json'))
    if (
      metrics.nonce !== saved.nonce ||
      audit.nonce !== saved.nonce ||
      metrics.arm !== j.arm ||
      metrics.scenario !== j.scenario.id ||
      metrics.repeat !== j.repeat ||
      audit.mode !== manifest.mode
    )
      throw Error('Mismatched trial')
    ts.push({ ...metrics, events: audit.events, finalText: audit.finalText })
  }
  const reviews: Reviews = reviewFile ? await json(reviewFile) : {}
  const report = reportV2(ts, manifest.price, reviews)
  for (const [name, body] of [
    ['summary.json', JSON.stringify({ mode: manifest.mode, ...report }, null, 2) + '\n'],
    ['report.md', renderV2(report, manifest.price)],
  ]) {
    const stage = join(out, '.report-' + randomUUID())
    await writeFile(stage, body, { flag: 'wx', mode: 0o600 })
    await rename(stage, join(out, name))
  }
  return report
}
