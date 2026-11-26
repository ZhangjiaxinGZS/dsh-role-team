import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { memoryMeta, roleMeta } from '../src/shared/index.js'
import { RoleStore } from '../src/host/role-store/index.js'
import { digest, parseMarkdown, serializeMarkdown } from '../src/host/role-store/markdown.js'

const roleId = 'reviewer'
const role = { id: roleId, name: '审稿人', version: 1, skills: ['review'], tools: { deny: ['search'] } }
const card = serializeMarkdown(role, '\n## 职责\n中文正文\n---\n保留分隔线\n')
const mem = {
  id: 'budget',
  title: '复核',
  scope: 'role_long_term',
  status: 'draft',
  createdAt: '2026-11-22T00:00:00Z',
}
const memory = (status: string) => serializeMarkdown({ ...mem, status }, '\n只复核已证实的结论\n')
let folder: string
let root: string
let store: RoleStore
const save = (text: string, expectedHash: string | null = null, memoryId?: string) =>
  store.saveDocument({ roleId, memoryId, text, expectedHash })
beforeEach(async () => {
  folder = await mkdtemp(join(process.cwd(), 'node_modules', '.role-team-test-'))
  root = join(folder, 'roles')
  store = await RoleStore.open(root)
})
afterEach(async () => {
  await store.close()
  await rm(folder, { recursive: true, force: true })
})

it('round-trips YAML metadata and preserves all Markdown including CRLF', () => {
  const parsed = parseMarkdown(card, roleMeta, roleId, 'role.md')
  expect(parsed.meta).toEqual(role)
  expect(serializeMarkdown(parsed.meta, parsed.body)).toBe(card)
  expect(parseMarkdown(card.replaceAll('\n', '\r\n'), roleMeta, roleId, 'role.md').body).toBe(
    parsed.body.replaceAll('\n', '\r\n'),
  )
  expect(parseMarkdown(memory('draft'), memoryMeta, 'budget', 'budget.md').meta).toEqual(mem)
})
it('creates role defaults in YAML and restores both values from a historical snapshot', async () => {
  const defaults = { defaultModel: { provider: 'p', model: 'm', reasoningEffort: 'high' }, defaultPermission: 'read-only' } as const
  const created = await store.createRole('Writer', undefined, defaults)
  if (!created.ok || !created.hash) throw new Error('Expected a published role')
  const roleId = created.status.roleId
  const first = (await store.readDocument({ roleId }))!
  const parsed = parseMarkdown(first.text, roleMeta, roleId, 'role.md')
  expect(parsed.meta).toEqual({ id: roleId, name: 'Writer', ...defaults })
  expect(serializeMarkdown(parsed.meta, parsed.body)).toBe(first.text)
  const plain = serializeMarkdown({ id: roleId, name: 'Writer' }, '')
  expect(await store.saveDocument({ roleId, expectedHash: first.hash, text: plain })).toMatchObject({ ok: true })
  expect(await store.restoreRole(roleId, 1, digest(plain))).toMatchObject({ ok: true, status: { publishedRevision: 3 } })
  expect((await store.readSnapshot(roleId, 3)).role.meta).toEqual(parsed.meta)
  expect(await store.readDocument({ roleId })).toEqual(first)
})
it('validates file ownership, memory scope and frontmatter before modifying disk', async () => {
  expect(await save(card.replace('id: reviewer', 'id: other'))).toMatchObject({
    code: 'invalid',
    error: { line: 2 },
  })
  expect(await save(card)).toMatchObject({ ok: true })
  expect(
    await save(memory('draft').replace('role_long_term', 'team_private'), null, 'budget'),
  ).toMatchObject({ code: 'invalid' })
  expect(await store.listMemories(roleId)).toEqual([])
  await expect(store.readDocument({ roleId: '../other' })).rejects.toThrow()
})
it('creates complete read-only snapshots and includes every saved experience regardless of legacy status', async () => {
  await save(card)
  await save(memory('draft'), null, 'budget')
  const first = await store.readSnapshot(roleId, 1)
  expect(first.role.meta).toEqual(role)
  expect((await store.readSnapshot(roleId, 2)).memories[0].meta.id).toBe('budget')
  await save(memory('published'), digest(memory('draft')), 'budget')
  expect((await store.readSnapshot(roleId, 3)).memories[0].meta.id).toBe('budget')
  await save(memory('archived'), digest(memory('published')), 'budget')
  expect((await store.readSnapshot(roleId, 4)).memories[0].meta.id).toBe('budget')
  expect(await store.readSnapshot(roleId, 1)).toEqual(first)
  expect((await stat(join(root, roleId, 'snapshots/rev-0001.json'))).mode & 0o222).toBe(0)
  expect(await store.listMemories(roleId)).toEqual(['budget'])
  expect(await readdir(join(root, roleId, 'memories'))).toEqual(['budget.md'])
})
it('republishes old snapshots that omitted saved drafts on upgrade, exactly once', async () => {
  await save(card)
  await save(memory('draft'), null, 'budget')
  const old = { ...(await store.readSnapshot(roleId, 2)), memories: [] }
  await store.close()
  const file = join(root, roleId, 'snapshots', 'rev-0002.json')
  await rename(file, file + '.backup')
  await writeFile(file, JSON.stringify(old))
  store = await RoleStore.open(root)
  expect((await store.readSnapshot(roleId, 3)).memories[0].meta.id).toBe('budget')
  expect((await store.rescan())[0].publishedRevision).toBe(3)
  expect(await store.readSnapshot(roleId, 2)).toEqual(old)
})
it('returns both texts when a manual edit races a UI save or deletion', async () => {
  await save(card)
  const changed = card + '外部编辑\n'
  await writeFile(join(root, roleId, 'role.md'), changed)
  const current = { text: changed, hash: digest(changed) }
  expect(await save(card + 'UI', digest(card))).toEqual({
    ok: false,
    code: 'conflict',
    current,
    proposed: card + 'UI',
  })
  expect(await store.deleteDocument({ roleId, expectedHash: digest(card) })).toEqual({
    ok: false,
    code: 'conflict',
    current,
    proposed: null,
  })
  expect(await store.readDocument({ roleId })).toEqual(current)
})
it('acknowledges an identical retry without creating a conflict or a new revision', async () => {
  await save(card)
  const note = memory('published')
  await save(note, null, 'budget')
  expect(await save(note, null, 'budget')).toMatchObject({ ok: true, hash: digest(note) })
  const next = card + 'new rule'
  await save(next, digest(card))
  expect(await save(next, digest(card))).toMatchObject({
    ok: true,
    hash: digest(next),
    status: { publishedRevision: 3 },
  })
})
it('serializes competing hosts, publishes once and atomically replaces the inode', async () => {
  await save(card)
  const before = await stat(join(root, roleId, 'role.md'))
  const second = await RoleStore.open(root)
  try {
    const changes = ['one', 'two'].map((suffix, index) =>
      (index ? second : store).saveDocument({ roleId, text: card + suffix, expectedHash: digest(card) }),
    )
    const results = await Promise.all(changes)
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.code === 'conflict')).toHaveLength(1)
    await Promise.all([store.rescan(), second.rescan()])
    expect(await readdir(join(root, roleId, 'snapshots'))).toHaveLength(2)
    expect((await stat(join(root, roleId, 'role.md'))).ino).not.toBe(before.ino)
  } finally {
    await second.close()
  }
})
it('publishes a manual atomic editor save through the watcher without explicit scanning', async () => {
  await save(card)
  const dir = join(root, roleId)
  await writeFile(join(dir, '.editor'), card + '外部修改')
  await rename(join(dir, '.editor'), join(dir, 'role.md'))
  await vi.waitFor(
    async () =>
      expect(
        JSON.parse(await readFile(join(dir, 'snapshots/rev-0002.json'), 'utf8')).role.body,
      ).toContain('外部修改'),
    { timeout: 5000 },
  )
  expect((await store.rescan())[0].publishedRevision).toBe(2)
})
it('reports the invalid file and YAML line; the last valid snapshot survives restart', async () => {
  await save(card)
  const invalid = '---\nid: reviewer\nname: [broken\n---\n'
  await writeFile(join(root, roleId, 'role.md'), invalid)
  await store.close()
  store = await RoleStore.open(root)
  const [status] = await store.listRoles()
  expect(status.publishedRevision).toBe(1)
  expect(status.error?.file).toBe(join(root, roleId, 'role.md'))
  expect(status.error!.line).toBeGreaterThanOrEqual(3)
  expect((await store.readSnapshot(roleId, 1)).role.meta.name).toBe(role.name)
  expect(await save(card + 'fixed', digest(invalid))).toMatchObject({
    ok: true,
    status: { publishedRevision: 2, error: null },
  })
})
it('removes memories and retires roles while retaining pinned snapshots', async () => {
  await save(card)
  await save(memory('published'), null, 'budget')
  expect(
    await store.deleteDocument({
      roleId,
      memoryId: 'budget',
      expectedHash: digest(memory('published')),
    }),
  ).toMatchObject({ ok: true })
  expect(await store.listMemories(roleId)).toEqual([])
  expect(await store.deleteDocument({ roleId, expectedHash: digest(card) })).toMatchObject({ ok: true })
  expect(await store.listRoles()).toEqual([])
  expect((await store.readSnapshot(roleId, 2)).memories).toHaveLength(1)
  await expect(save(card)).rejects.toThrow(/retired/)
})
it('rejects links at the role, memory directory, document and snapshot boundaries', async () => {
  const outside = join(folder, 'outside')
  await mkdir(outside)
  await symlink(outside, join(root, roleId), 'dir')
  await expect(save(card)).rejects.toThrow()
  await rm(join(root, roleId))
  await save(card)
  await symlink(outside, join(root, roleId, 'memories'), 'dir')
  await expect(save(memory('draft'), null, 'budget')).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
  await rm(join(root, roleId, 'memories'))
  await mkdir(join(root, roleId, 'memories'))
  await writeFile(join(outside, 'secret'), 'secret')
  await symlink(join(outside, 'secret'), join(root, roleId, 'memories', 'budget.md'))
  await expect(store.readDocument({ roleId, memoryId: 'budget' })).rejects.toThrow()
  await rm(join(root, roleId, 'snapshots'), { recursive: true })
  await symlink(outside, join(root, roleId, 'snapshots'), 'dir')
  await expect(store.readSnapshot(roleId, 1)).rejects.toThrow()
})

it('restores a recent distinct role setting as a new revision, preserving experience and checking for conflicts', async () => {
  let hash: string | null = null
  for (let i = 1; i <= 13; i++) {
    const result = await save(serializeMarkdown({ ...role, summary: 'Duty ' + i }, 'Details ' + i), hash)
    if (!result.ok) throw Error('Fixture write failed')
    hash = result.hash
  }
  await save(memory('published'), null, 'budget')
  const history = await store.roleHistory(roleId)
  expect(history.map((s) => s.publishedRevision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
  expect(await store.restoreRole(roleId, 4, digest('stale'))).toMatchObject({
    ok: false,
    code: 'conflict',
  })
  await expect(store.restoreRole(roleId, 1, hash!)).rejects.toThrow()
  expect(await store.restoreRole(roleId, 4, hash!)).toMatchObject({
    ok: true,
    status: { publishedRevision: 15 },
  })
  const restored = await store.readSnapshot(roleId, 15)
  expect(restored.role).toMatchObject({ meta: { summary: 'Duty 4' }, body: 'Details 4' })
  expect(restored.memories).toHaveLength(1)
})

it('allocates fresh role IDs and reserves active display names across simultaneous hosts', async () => {
  const other = await RoleStore.open(root)
  try {
    const results = await Promise.all([store.createRole(' Writer '), other.createRole('wRiTeR')])
    const first = results.find((r) => r.ok)
    if (!first?.ok || !first.hash) throw new Error('Expected a published role')
    expect(first.status.roleId).toMatch(/^role-[a-f0-9-]{36}$/)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'invalid', error: { message: '已存在同名角色，请重新输入' } })
    const second = await store.createRole('Editor')
    if (!second.ok || !second.hash) throw new Error('Expected a second published role')
    expect(second.status.roleId).not.toBe(first.status.roleId)
    const rename = await other.saveDocument({
      roleId: second.status.roleId,
      expectedHash: second.hash,
      text: serializeMarkdown({ id: second.status.roleId, name: ' writer ' }, ''),
    })
    expect(rename).toMatchObject({ code: 'invalid' })
    expect((await store.readDocument({ roleId: second.status.roleId }))?.hash).toBe(second.hash)
    await store.retireRole({ roleId: first.status.roleId, expectedHash: first.hash })
    const reused = await other.createRole('Writer')
    if (!reused.ok) throw new Error('Expected released name to be reusable')
    expect(reused.status.roleId).not.toBe(first.status.roleId)
  } finally {
    await other.close()
  }
})
