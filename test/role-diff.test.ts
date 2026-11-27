import { expect, it } from 'vitest'
import { roleDiff } from '../src/shared/role-diff.js'

const meta = { id: 'editor', name: 'Editor' }

it('reports sections, compact disjoint hunks and independent line counts in both languages', () => {
  const base = '## Existing\nold\n' + 'keep\n'.repeat(12)
  const after = base.replace('old', 'new') + '## New heading\nnew details\n'
  const result = roleDiff({ meta, body: base }, { meta, body: after })
  expect(result).toMatchObject({ added: 3, removed: 1, changedSections: ['Existing'], addedSections: ['New heading'] })
  expect(result.changes[0].hunks).toHaveLength(2)
  expect(result.summary.zh).toContain('正文新增「New heading」')
  expect(result.summary.en).toContain('Added section')
  expect(result.summary.en).toContain('+3/-1')
})
it('summarizes profile fields independently, initial versions and unchanged snapshots', () => {
  const role = { meta, body: '' }
  expect(roleDiff(undefined, role).summary.zh).toBe('初始版本')
  expect(roleDiff(role, role).changes).toEqual([])
  const result = roleDiff(role, { ...role, meta: { ...meta, name: 'Writer', summary: 'Review',
    defaultModel: { provider: 'host', model: 'main' }, defaultPermission: 'read-only' } })
  expect(result.changes.map(c => c.field)).toEqual(['name', 'summary', 'defaultModel', 'defaultPermission'])
  expect(result.summary.zh).toContain('更新职责简介')
  expect(result.summary.en).toContain('default permissions')
})

it('recognizes setext headings and skips headings inside fenced examples', () => {
  const role = { meta, body: 'Before' }
  const after = { meta, body: 'Before\n\nGuidelines\n==========\n~~~md\n## Example only\n~~~' }
  expect(roleDiff(role, after).addedSections).toEqual(['Guidelines'])
})
