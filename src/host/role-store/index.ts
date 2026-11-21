import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  deleteRequest,
  editRequest,
  fileId,
  fileRef,
  memoryMeta,
  revision,
  roleMeta,
  snapshotSchema,
  type DeleteRequest,
  type EditRequest,
  type EditResult,
  type FileRef,
  type RoleStatus,
  type Snapshot,
} from '../../shared/index.js'
import { digest, DocumentError, parseMarkdown } from './markdown.js'
import { directory, readFileText, stageText } from './files.js'

export const defaultRoleDir = () => join(homedir(), '.dsh-role-team', 'roles')
const snapshotName = (rev: number) => 'rev-' + String(rev).padStart(4, '0') + '.json'

export class RoleStore {
  private watcher?: FSWatcher
  private interval?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private constructor(
    readonly root: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  static async open(
    path = defaultRoleDir(),
    options: { scanIntervalMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    if (!isAbsolute(path)) throw new Error('roleStoreDir must be an absolute path')
    const configured = resolve(path)
    await mkdir(dirname(configured), { recursive: true, mode: 0o700 })
    await directory(configured, true)
    const store = new RoleStore(
      await realpath(configured),
      options.onError ?? ((error) => console.error(error)),
    )
    try {
      await store.rescan()
      const schedule = () => {
        void store.rescan().catch(store.onError)
      }
      try {
        store.watcher = watch(store.root, { recursive: true, persistent: false }, (_event, name) => {
          if (name && name.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'snapshots'))
            return
          clearTimeout(store.debounce)
          store.debounce = setTimeout(schedule, 60).unref()
        })
        store.watcher.on('error', store.onError)
      } catch (error) {
        store.onError(error)
      }
      store.interval = setInterval(schedule, options.scanIntervalMs ?? 15_000).unref()
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }
  async close() {
    this.closed = true
    this.watcher?.close()
    clearTimeout(this.debounce)
    clearInterval(this.interval)
    await this.tail
  }

  /** Serialize publication in this process and between Web and Desktop hosts sharing a library. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Role library is closed'))
    const task = this.tail.then(async () => {
      if ((await realpath(this.root)) !== this.root) throw new Error('Role library path changed')
      const release = await lockfile.lock(this.root, {
        lockfilePath: join(this.root, '.publication.lock'),
        retries: { retries: 40, minTimeout: 10, maxTimeout: 200 },
      })
      try {
        return await work()
      } finally {
        await release()
      }
    })
    this.tail = task.then(
      () => {},
      () => {},
    )
    return task
  }

  private async rolePath(id: string, create = false) {
    const path = join(this.root, fileId.parse(id))
    await directory(path, create)
    return path
  }
  private async documentPath(ref: FileRef, create = false) {
    const role = await this.rolePath(ref.roleId, create)
    if (ref.memoryId === undefined) return join(role, 'role.md')
    if (create && !(await readFileText(join(role, 'role.md'))))
      throw new Error('Role not found: ' + ref.roleId)
    const memories = join(role, 'memories')
    await directory(memories, create)
    return join(memories, fileId.parse(ref.memoryId) + '.md')
  }
  private async memoryIds(role: string) {
    const dir = join(role, 'memories')
    if (!(await directory(dir))) return []
    return (await readdir(dir))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => fileId.parse(name.slice(0, -3)))
  }
  listMemories(roleId: string) {
    return this.locked(async () => this.memoryIds(await this.rolePath(roleId)))
  }
  async readDocument(input: FileRef) {
    const ref = fileRef.parse(input)
    return this.locked(async () => readFileText(await this.documentPath(ref)))
  }
  private async latest(role: string) {
    const dir = join(role, 'snapshots')
    if (!(await directory(dir))) return null
    const numbers = (await readdir(dir))
      .filter((n) => /^rev-\d+\.json$/.test(n))
      .map((n) => revision.parse(Number(n.slice(4, -5))))
    return numbers.reduce<number | null>(
      (highest, n) => (highest === null || n > highest ? n : highest),
      null,
    )
  }
  private async snapshot(role: string, id: string, rev: number) {
    const dir = join(role, 'snapshots')
    await directory(dir)
    const data = await readFileText(join(dir, snapshotName(revision.parse(rev))))
    if (!data) throw new Error('Snapshot not found: ' + id + ' @ ' + rev)
    const value = snapshotSchema.parse(JSON.parse(data.text))
    if (value.roleId !== id || value.role.meta.id !== id || value.publishedRevision !== rev)
      throw new Error('Snapshot identity mismatch')
    return value
  }
  readSnapshot(roleId: string, rev: number) {
    return this.locked(async () => {
      const archived = await this.retiredRole(roleId)
      return this.snapshot(archived ?? (await this.rolePath(roleId)), roleId, rev)
    })
  }
  private async retiredRole(roleId: string) {
    const dir = join(this.root, '.retired')
    if (!(await directory(dir))) return null
    const archived = join(dir, fileId.parse(roleId))
    return (await directory(archived)) ? archived : null
  }

  private async publish(roleId: string): Promise<RoleStatus> {
    const role = await this.rolePath(roleId)
    let previous: number | null = null
    let file = join(role, 'snapshots')
    try {
      if (await this.retiredRole(roleId)) throw new Error('Role ID is retired: ' + roleId)
      previous = await this.latest(role)
      file = join(role, 'role.md')
      const source = await readFileText(file)
      if (!source) throw new Error('role.md is missing')
      const card = parseMarkdown(source.text, roleMeta, roleId, file)
      const hashes = [['role.md', source.hash]]
      const memories: Snapshot['memories'] = []
      file = join(role, 'memories')
      for (const id of await this.memoryIds(role)) {
        file = join(role, 'memories', id + '.md')
        const entry = await readFileText(file)
        if (!entry) throw new Error('Memory changed during scan')
        const memory = parseMarkdown(entry.text, memoryMeta, id, file)
        hashes.push([id, entry.hash])
        if (memory.meta.status === 'published')
          memories.push({ meta: { ...memory.meta, status: 'published' }, body: memory.body })
      }
      const sourceHash = digest(JSON.stringify(hashes))
      if (previous !== null && (await this.snapshot(role, roleId, previous)).sourceHash === sourceHash)
        return { roleId, publishedRevision: previous, error: null }
      const next = (previous ?? 0) + 1
      const value: Snapshot = {
        roleId,
        publishedRevision: next,
        publishedAt: new Date().toISOString(),
        sourceHash,
        role: card,
        memories,
      }
      const dir = join(role, 'snapshots')
      await directory(dir, true)
      const staged = await stageText(
        join(dir, snapshotName(next)),
        JSON.stringify(value, null, 2) + '\n',
        true,
      )
      try {
        await staged.commit(true)
      } finally {
        await staged.discard()
      }
      return { roleId, publishedRevision: next, error: null }
    } catch (error) {
      return {
        roleId,
        publishedRevision: previous,
        error: error instanceof DocumentError ? error.detail : { file, line: 1, message: String(error) },
      }
    }
  }
  listRoles() {
    return this.rescan()
  }
  rescan(): Promise<RoleStatus[]> {
    return this.locked(async () => {
      const entries = await readdir(this.root, { withFileTypes: true })
      const result: RoleStatus[] = []
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!fileId.safeParse(entry.name).success || !entry.isDirectory()) continue
        result.push(await this.publish(entry.name))
      }
      return result
    })
  }
  async saveDocument(input: EditRequest) {
    const edit = editRequest.parse(input)
    return this.change(edit, edit.text)
  }
  async deleteDocument(input: DeleteRequest) {
    return this.change(deleteRequest.parse(input), null)
  }
  private change(
    ref: FileRef & { expectedHash: string | null },
    proposed: string | null,
  ): Promise<EditResult> {
    return this.locked(async () => {
      const create = ref.expectedHash === null
      const { roleId, memoryId } = ref
      const retired = join(this.root, '.retired')
      if (await this.retiredRole(roleId)) throw new Error('Role ID is retired: ' + roleId)
      const existingPath = await this.documentPath(ref)
      const check = async (): Promise<EditResult | null> => {
        const current = await readFileText(existingPath)
        return (current?.hash ?? null) === ref.expectedHash
          ? null
          : { ok: false, code: 'conflict', current, proposed }
      }
      const conflict = await check()
      if (conflict) return conflict
      if (proposed !== null) {
        try {
          if (memoryId === undefined) parseMarkdown(proposed, roleMeta, roleId, existingPath)
          else parseMarkdown(proposed, memoryMeta, memoryId, existingPath)
        } catch (error) {
          if (error instanceof DocumentError) return { ok: false, code: 'invalid', error: error.detail }
          throw error
        }
        if (memoryId !== undefined && !(await readFileText(join(this.root, roleId, 'role.md'))))
          throw new Error('Role not found: ' + roleId)
        const path = await this.documentPath(ref, create)
        const staged = await stageText(path, proposed)
        try {
          const raced = await check()
          if (raced) return raced
          try {
            await staged.commit(create)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            const concurrent = await check()
            if (concurrent) return concurrent
            throw error
          }
        } finally {
          await staged.discard()
        }
      } else if (memoryId === undefined) {
        await directory(retired, true)
        const raced = await check()
        if (raced) return raced
        await rename(await this.rolePath(roleId), join(retired, roleId))
        return { ok: true, status: { roleId, publishedRevision: null, error: null }, hash: null }
      } else {
        await unlink(existingPath)
      }
      return {
        ok: true,
        status: await this.publish(roleId),
        hash: proposed === null ? null : digest(proposed),
      }
    })
  }
}
