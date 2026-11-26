import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { catalogue } from './scenarios.ts'
import { projects } from './engineering.ts'
export function holdoutFingerprints() {
  return Object.fromEntries(
    catalogue
      .filter((s) => s.split === 'holdout')
      .map((s) => [
        s.id,
        createHash('sha256')
          .update(JSON.stringify({ scenario: s, project: projects.find((p) => p.id === s.id) }))
          .digest('hex'),
      ]),
  )
}
export async function checkHoldout() {
  const { dev, ...frozen } = JSON.parse(
    await readFile(new URL('./holdout.lock.json', import.meta.url), 'utf8'),
  )
  const actual = holdoutFingerprints()
  if (
    JSON.stringify(dev) !==
      JSON.stringify(
        catalogue
          .filter((s) => s.split === 'dev')
          .map((s) => s.id)
          .sort(),
      ) ||
    Object.keys(frozen).length !== Object.keys(actual).length ||
    Object.entries(actual).some(([id, hash]) => frozen[id] !== hash)
  )
    throw Error('Frozen holdout has changed')
}
