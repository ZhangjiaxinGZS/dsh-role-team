import { createRequire } from 'node:module'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import type RoleTeam from '../src/host/index.js'

const require = createRequire(import.meta.url)
it('loads the manifest-selected Host and renderer artifacts and disposes their resources', async () => {
  const manifest = require('dsh-role-team/package.json')
  const patch = parse(await readFile(join(process.cwd(), manifest.dsh.bundle.patch), 'utf8'))
  const moduleId = patch[0].insert[0].name
  expect(moduleId).toBe(manifest.name)
  const host = (await import(pathToFileURL(require.resolve(moduleId)).href)) as { default: typeof RoleTeam }
  const ctx = new Context()
  const temp = await mkdtemp(join(process.cwd(), 'node_modules/.role-bundle-'))
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(Json, { root: join(temp, 'index') })
    await ctx.plugin(Domains, { backend: 'json' })
    const fiber = await ctx.plugin(host.default, { roleStoreDir: join(temp, 'roles') })
    const service = ctx.roleTeam
    expect(
      remoteMethods(service)
        .map((m) => m.method)
        .sort(),
    ).toEqual([
      'deleteDocument',
      'listMemories',
      'listRoles',
      'readDocument',
      'readSnapshot',
      'rescan',
      'saveDocument',
    ])
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    const artifact = await import(pathToFileURL(require.resolve(moduleId + '/typert')).href)
    ctx.typert.register(validateTypertManifest(moduleId, artifact.TYPERT))
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    const call = (method: string, args: Record<string, unknown>) =>
      ctx.typertGateway.invoke({ namespace: 'roleTeam', method, args, peer })
    expect(await call('listRoles', {})).toEqual([])
    await expect(call('readDocument', { ref: { roleId: '../invalid' } })).rejects.toMatchObject({
      code: 'gateway/input-invalid',
    })
    expect(
      await call('saveDocument', {
        request: { roleId: 'proof', expectedHash: null, text: '---\nid: proof\nname: Example\n---\nHello' },
      }),
    ).toMatchObject({ ok: true })
    expect((await service.readSnapshot('proof', 1)).role.body).toBe('Hello')
    await fiber.dispose()
    expect(ctx.get('roleTeam')).toBeUndefined()

    const client = await readFile(require.resolve(moduleId + '/client'), 'utf8')
    let activated = false
    runInNewContext(client, {
      window: {
        __ModuleLoader__: {
          load(entry: { id: string; factory(): { apply(): void } }) {
            expect(entry.id).toBe(moduleId)
            entry.factory().apply()
            activated = true
          },
        },
      },
    })
    expect(activated).toBe(true)
    for (const lang of ['en', 'zh'])
      expect(require(moduleId + '/locale/' + lang + '.json').meta.title).toBeTruthy()
  } finally {
    await ctx.fiber.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})
