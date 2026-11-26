import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { constants, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/host/index.ts'
import type { LiveTrial } from '../types.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
export const flagshipCodex = 'openai-codex:gpt-6.2-astra'
export async function withLocalHost<T>(t: LiveTrial, work: (ctx: Context) => Promise<T>, codexJudge = false): Promise<T> {
  const root = await realpath(dirname(t.dshHome))
  if (
    !process.send ||
    !basename(root).startsWith('dsh-benchmark-') ||
    (await realpath(process.cwd())) !== root ||
    process.env.DSH_HOME !== t.dshHome ||
    process.env.HOME !== join(root, 'home') ||
    ![t.dshHome, t.roleStoreDir, t.traceDir, t.workspace].every((p) => dirname(p) === root)
  )
    throw new Error('Live driver requires a fresh isolated benchmark worker')
  const cred = join(t.dshHome, '.credentials.yaml')
  const original = join(userInfo().homedir, '.dsh', '.credentials.yaml')
  if (!(await lstat(original)).isFile()) throw new Error('DSH credential file unavailable')
  process.umask(0o077)
  const checkout = resolve(process.env.BENCH_DSH_CHECKOUT ?? join(repo, '../deepseek-harness'))
  const anchor = process.env.BENCH_HOST_ANCHOR ?? join(checkout, 'apps/cli/package.json')
  const load = createRequire(anchor)
  const boot = load('@deepseek-ai/dsh-app-boot') as typeof import('@deepseek-ai/dsh-app-boot')
  const [provider, model] = t.model.split(':')
  const dir = join(t.dshHome, 'profiles', 'bench')
  let ctx: Context | undefined
  try {
    await copyFile(original, cred, constants.COPYFILE_EXCL)
    await chmod(cred, 0o600)
    if (provider === 'openai-codex' || codexJudge) {
      const { parseCredentialsDocument } = load('@deepseek-ai/dsh-credentials-local')
      const vault = parseCredentialsDocument(await readFile(cred, 'utf8'), cred)
      const account = vault.records.get('codex-subscription/accounts')?.payload
      const active = account?.accounts.find((a: { id: string }) => a.id === account.activeId)?.credential
      const legacy = vault.refs.get('OPENAI_CODEX_SUBSCRIPTION_OAUTH')
      const expiry = active?.expires ?? (legacy ? JSON.parse(legacy).expires : 0)
      // The outer worker deadline is 30 minutes. A refresh could rotate the user's live refresh token.
      if (!Number.isFinite(expiry) || expiry < Date.now() + 31 * 60_000)
        throw new Error('Model turn failed: READ_ONLY_LOGIN_RENEWAL_REQUIRED')
    }
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    boot.initProfile(dir, bundles)
    const dependencies: Record<string, string> = {}
    if (provider === 'openai-codex' || codexJudge) {
      const pkg = process.env.BENCH_CODEX_PACKAGE
      if (
        !pkg ||
        JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).name !== 'dsh-codex-subscription'
      )
        throw new Error('BENCH_CODEX_PACKAGE must point to a separately installed subscription plugin')
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await symlink(pkg, join(dir, 'node_modules/dsh-codex-subscription'), 'dir')
      bundles.push('dsh-codex-subscription')
      dependencies['dsh-codex-subscription'] = 'file:' + pkg
    }
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ private: true, dependencies, dsh: { profile: { bundles } } }),
    )
    const profile = boot.loadProfileDirectory('bench', dir, anchor, { userLayer: false })
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, home: t.dshHome, profile })
    const config = join(dir, 'cordis.yml')
    await writeFile(config, '[]\n')
    const disabled = [
      'webserver',
      'web-runtime',
      'hmr',
      'session-telemetry-otel',
      'desktop-product-telemetry',
      'product-analytics',
      'modules',
      'connection',
      'session-log-download',
      'open-in-app',
      'client-hmr',
      'directory-picker',
      'session-title-llm',
    ]
    const overrides = [
      ...disabled.map((id) => ({ id, disabled: true })),
      // Native compaction calls the adapter directly without an effort option.
      // Set its fallback as well as the conversation-level selection.
      ...(t.model === flagshipCodex
        ? [{ id: 'codex-subscription', config: { defaultReasoningEffort: 'high' } }]
        : []),
      { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] },
      { id: 'session-persistence-jsonl', config: { root: t.traceDir, compression: 'none' } },
      { id: 'storage-json', config: { root: join(t.dshHome, 'storages') } },
      { id: 'attachment-local', config: { dshHome: t.dshHome } },
      {
        id: 'agent-default-model',
        config: { provider, model, ...(t.model === flagshipCodex && { reasoningEffort: 'high' }) },
      },
      { id: 'agent-preset-registry', config: { default: t.preset } },
    ]
    await writeFile(profile.patchPath, JSON.stringify(overrides))
    const patches = [...profile.layers.flatMap((l) => l.patches), ...overrides]
    ctx = await boot.boot('bench', config, patches, async (host) => {
      host.provide('profileContext', {
        name: 'bench',
        dir,
        patchPath: profile.patchPath,
        installAnchor: anchor,
        cwd: t.workspace,
        home: t.dshHome,
        startedBundles: bundles,
        overlays: [],
        overlayPaths: [],
        telemetryDisabledEnv: '1',
      } as typeof host.profileContext)
      await host.plugin(boot.PluginPackages, { resolution })
      host.provide('connection', {
        fetch: { register: () => () => {} },
        rpc: { intercept: () => () => {} },
      } as never)
      load('@deepseek-ai/dsh-cmdline').provideCmdline(host, { args: [], exit: () => {} })
    })
    if (provider === 'openai-codex') {
      // Adapter registration can be replaced once during host startup.
      for (let attempt = 0; ; attempt++) {
        try {
          const models = await ctx.llm.listModels(provider)
          if (!models.some((m) => m.id === model))
            throw new Error('Requested Codex model absent from isolated catalogue')
          if (
            t.model === flagshipCodex &&
            (await ctx.llm.resolveModelInfo(provider, model)).reasoning?.defaultEffort !== 'high'
          )
            throw new Error('Model turn failed: AUXILIARY_REASONING_EFFORT_MISMATCH')
          break
        } catch (error) {
          if (
            attempt >= 5 ||
            !(error instanceof Error) ||
            !(error.name === 'AbortError' || /adapter|provider.*registered/i.test(error.message))
          )
            throw error
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }
    if (t.preset !== 'standard') throw new Error('This live driver is validated for standard mode only')
    const allowed = new Set([
      'send_message',
      'list_agents',
      'team_task_create',
      'team_task_list',
      'team_task_update',
      'read_team_brief',
      'update_team_brief',
      'todo_write',
      'remember_experience',
      'update_role',
      'revise_experience',
    ])
    ctx.tools.guard((exec) => {
      if (allowed.has(exec.name)) return
      if (['read', 'write', 'edit'].includes(exec.name)) {
        const path = (exec.arguments as { file_path?: unknown })?.file_path
        if (typeof path === 'string') {
          const dest = resolve(t.workspace, path)
          if (dirname(dest) === t.workspace && !path.split('/').includes('..')) {
            const existing = lstatSync(dest, { throwIfNoEntry: false })
            if (!existing || (existing.isFile() && existing.nlink === 1)) return
          }
        }
      }
      return 'Benchmark tools are confined to the top-level trial workspace and team operations.'
    })
    if (t.arm !== 'single-agent') {
      const plugin = t.arm === 'v0.1.0' ? process.env.BENCH_V010_PACKAGE : (process.env.BENCH_V020_PACKAGE ?? repo)
      if (!plugin) throw new Error('BENCH_V010_PACKAGE must point to the built v0.1.0 worktree')
      const metadata = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'))
      if (metadata.version !== (t.arm === 'v0.1.0' ? '0.1.0' : '0.2.0'))
        throw new Error('Unexpected plugin arm version')
      await ctx.plugin(createRequire(import.meta.url)(join(plugin, 'dist/host.js')).default, {
        roleStoreDir: t.roleStoreDir,
      })
      await ctx.roleTeam.rescan()
    }
    return await work(ctx)
  } finally {
    try {
      await ctx?.fiber.dispose()
    } finally {
      await rm(cred, { force: true })
    }
  }
}
