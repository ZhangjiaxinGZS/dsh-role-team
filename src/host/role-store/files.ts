import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { digest } from './markdown.js'

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
export async function directory(path: string, create = false): Promise<boolean> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const stat = await lstat(path).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!stat) return false
  if (!stat.isDirectory()) throw new Error('Expected a directory, refusing link or special file: ' + path)
  return true
}
export async function readFileText(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error) => {
      if (missing(error)) return null
      throw error
    },
  )
  if (!handle) return null
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a regular, unshared file: ' + path)
    const bytes = await handle.readFile()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { text, hash: digest(text) }
  } finally {
    await handle.close()
  }
}

/** Place the complete file in the destination directory before making its name visible. */
export async function stageText(path: string, text: string, readonly = false) {
  const temp = join(dirname(path), '.' + randomUUID() + '.tmp')
  const handle = await open(temp, 'wx', readonly ? 0o444 : 0o600)
  try {
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(temp)
    throw error
  }
  return {
    // Link for a new file makes create-if-absent atomic even against an external writer.
    async commit(create: boolean) {
      if (create) await link(temp, path)
      else await rename(temp, path)
    },
    async discard() {
      await unlink(temp).catch((error) => {
        if (!missing(error)) throw error
      })
    },
  }
}
