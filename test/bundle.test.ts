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
import { expect, it, vi } from 'vitest'
import type RoleTeam from '../src/host/index.js'
import { runtimeMethods } from '../src/shared/runtime.js'

const require = createRequire(import.meta.url)
it('loads the manifest-selected Host and renderer artifacts and disposes their resources', async () => {
  const manifest = require('dsh-role-team/package.json')
  const patch = parse(await readFile(join(process.cwd(), manifest.dsh.bundle.patch), 'utf8'))
  expect(patch).toContainEqual({ id: 'ui-sidebar-browser', disabled: false })
  const moduleId = patch[0].insert[0].name
  expect(patch[0].insert).toEqual([{ id: 'role-team', name: manifest.name }])
  const host = (await import(pathToFileURL(require.resolve(moduleId)).href)) as {
    default: typeof RoleTeam
  }
  const ctx = new Context()
  const updateFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
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
    ).toEqual(
      [
        'deleteDocument',
        'listMemories',
        'listRoles',
        'readDocument',
        'readSnapshot',
        'rescan',
        'saveDocument',
        ...Object.keys(runtimeMethods),
      ].sort(),
    )
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    const artifact = await import(pathToFileURL(require.resolve(moduleId + '/typert')).href)
    ctx.typert.register(validateTypertManifest(moduleId, artifact.TYPERT))
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    const call = (method: string, args: Record<string, unknown>) =>
      ctx.typertGateway.invoke({ namespace: 'roleTeam', method, args, peer })
    expect(updateFetch).not.toHaveBeenCalled()
    expect(await call('checkUpdate', { request: {} })).toMatchObject({ enabled: true, hasUpdate: false })
    expect(updateFetch).toHaveBeenCalledTimes(1)
    expect(await call('listRoles', {})).toEqual([])
    await expect(
      call('resetSeat', { request: { seatId: 'seat', generation: 0, handoff: '' } }),
    ).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    await expect(
      call('confirmProposal', { request: { trainingId: 't', proposalId: 'p', roleId: 'override' } }),
    ).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    await expect(call('readDocument', { ref: { roleId: '../invalid' } })).rejects.toMatchObject({
      code: 'gateway/input-invalid',
    })
    expect(
      await call('saveDocument', {
        request: {
          roleId: 'proof',
          expectedHash: null,
          text: '---\nid: proof\nname: Example\n---\nHello',
        },
      }),
    ).toMatchObject({ ok: true })
    expect((await service.readSnapshot('proof', 1)).role.body).toBe('Hello')
    await fiber.dispose()
    expect(ctx.get('roleTeam')).toBeUndefined()
    const disabled = await ctx.plugin(host.default, { roleStoreDir: join(temp, 'roles'), checkUpdates: false })
    expect(await call('checkUpdate', { request: { force: true } })).toMatchObject({ enabled: false, hasUpdate: false })
    expect(updateFetch).toHaveBeenCalledTimes(1)
    await disabled.dispose()

    const client = await readFile(require.resolve(moduleId + '/client'), 'utf8')
    let factory:
      | ((resolve: (id: string) => unknown) => { apply(ctx: unknown): Promise<void> })
      | undefined
    runInNewContext(client, {
      document: { createElement: () => ({ remove: () => {} }), head: { append: () => {} } },
      window: {
        __ModuleLoader__: {
          load(entry: { id: string; factory: NonNullable<typeof factory> }) {
            expect(entry.id).toBe(moduleId)
            factory = entry.factory
          },
        },
      },
    })
    const injected = new Set<string>()
    const plugin = factory!((id) => {
      expect(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react-dom', 'react/jsx-runtime', 'zod']).toContain(
        id,
      )
      injected.add(id)
      return id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id)
    })
    // Use the published renderer's SlotRegistry and Cordis lifecycle with the packaged browser factory.
    type Renderer = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
    let renderer!: Renderer
    runInNewContext(
      await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'),
      {
        window: {
          __ModuleLoader__: {
            load(entry: { factory(resolve: typeof require): Renderer }) {
              renderer = entry.factory(require)
            },
          },
        },
      },
    )
    const clientCtx = new Context()
    try {
      await clientCtx.plugin(renderer.SlotRegistry)
      clientCtx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
      clientCtx.provide('remote', {
        $mount: (r: { package: string }) => expect(r.package).toBe(moduleId),
      } as never)
      clientCtx.provide('sessions', {} as never)
      clientCtx.slots.register(
        {
          name: 'root',
          children: {
            'shell.overlay': { kind: 'list', scope: 'root' },
            main: { kind: 'keyed', scope: 'root' },
            'sidebar.panellist': { kind: 'list', scope: 'root' },
            'settings.section': { kind: 'list', scope: 'root' },
            'conversation.session.header': { kind: 'single', scope: 'session' },
          },
        },
        (
          _props: import('@deepseek-ai/dsh-client-ui-slots').PropsRenderSlots<
            'main' | 'sidebar.panellist' | 'settings.section' | 'conversation.session.header'
          >,
        ) => null,
      )
      const clientFiber = await clientCtx.plugin(plugin)
      expect(clientCtx.slots.entriesOfSlot('main')).toHaveLength(0)
      clientCtx.provide('remote.roleTeam', {} as never)
      const headerStore = {
        spec: { init: () => ({ view: 'chat' }), actions: {} },
        create() {
          throw new Error('No session mounted in registry test')
        },
      }
      clientCtx.slots.register(
        { name: 'conversation.session.header', store: headerStore, inject: () => ({}) },
        () => null,
      )
      for (const key of ['main', 'sidebar.panellist', 'roleTeam.chat'] as const)
        await vi.waitFor(() => expect(clientCtx.slots.entriesOfSlot(key)).toHaveLength(1))
      expect(clientCtx.slots.entriesOfSlot('roleTeam.chat')[0]?.store).toBe(headerStore)
      expect(clientCtx.slots.entriesOfSlot('settings.section')).toHaveLength(0)
      const settingsOwner = await clientCtx.plugin({
        apply(scope: Context) {
          scope.provide('remote.settings', {} as never)
        },
      })
      await vi.waitFor(() => expect(clientCtx.slots.entriesOfSlot('settings.section')).toHaveLength(1))
      await settingsOwner.dispose()
      await vi.waitFor(() => expect(clientCtx.slots.entriesOfSlot('settings.section')).toHaveLength(0))
      expect(clientCtx.slots.entriesOfSlot('main')).toHaveLength(1)
      expect([...injected].sort()).toEqual([
        '@deepseek-ai/dsh-client-ui-primitives',
        'react',
        'react-dom',
        'react/jsx-runtime',
        'zod',
      ])
      await clientFiber.dispose()
      expect(clientCtx.slots.entriesOfSlot('main')).toHaveLength(0)
    } finally {
    updateFetch.mockRestore()
      await clientCtx.fiber.dispose()
    }
    for (const lang of ['en', 'zh'])
      expect(require(moduleId + '/locale/' + lang + '.json').meta.title).toBeTruthy()
  } finally {
    await ctx.fiber.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})
