import { once } from 'node:events'
import { spawn } from 'node:child_process'
import Schedule from '@deepseek-ai/dsh-schedule'
import * as ScheduleTools from '@deepseek-ai/dsh-tool-schedule'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Permissions from '@deepseek-ai/dsh-permission-presets'
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionReferences from '@deepseek-ai/dsh-session-reference'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  createUserMessage,
  type StreamChunk,
  type GenerateOptions,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query'
import Workspace from '@deepseek-ai/dsh-workspace'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Teams from '@deepseek-ai/dsh-agent-team'
import * as BoardTools from '@deepseek-ai/dsh-tool-agent-team'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type RoleTeam from '../src/host/index.js'
import { runtimeMethods } from '../src/shared/runtime.js'
import { serializeMarkdown } from '../src/host/role-store/markdown.js'

class Catalog extends Query {
  async searchSessions(): Promise<never> {
    throw new Error('Outside this fixture')
  }
  async searchEvents(): Promise<never> {
    throw new Error('Outside this fixture')
  }
}
// Text-only integration tests do not stage browser uploads.
class TextUploads extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileUploads')
  }
  registerAgentResolver() {
    return () => {}
  }
  bindPrompt() {
    return { commit() {}, [Symbol.dispose]() {} }
  }
}
class Adapter extends LlmAdapter {
  async listModels(provider: string) {
    return ['fixture', 'authoring'].map((id) => ({ id, name: id, provider }))
  }
  async resolveModel(provider: string, id: string) {
    return {
      id,
      provider,
      name: id,
      reasoning: {
        efforts: [
          {
            id: 'high' as import('@deepseek-ai/dsh-llm/types').LlmReasoningEffortInfo['id'],
            name: 'High',
          },
        ],
      },
    }
  }
  program?: string
  requests: GenerateOptions[] = []
  pause?: (request: GenerateOptions) => Promise<void>
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    await this.pause?.(request)
    if (this.program !== undefined) {
      const id = crypto.randomUUID() as ToolCallId
      const name = 'run_code'
      const args = JSON.stringify({ code: this.program, description: 'Test coaching bindings' })
      this.program = undefined
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let folder: string, cwd: string, ctx: Context, service: RoleTeam, model: Adapter
const roleId = 'reviewer'
const role = (body: string) => serializeMarkdown({ id: roleId, name: 'Reviewer' }, body)
const newTeam = (title: string) => service.createTeam({ title, roleId, workspaceCwd: cwd })
async function boot() {
  ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root: join(folder, 'tables') })
  await ctx.plugin(Domain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Persistence, { root: join(folder, 'logs') })
  await ctx.plugin(Catalog)
  await ctx.plugin(Workspace)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Teams)
  await ctx.plugin(BoardTools)
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(AgentPresets, { default: 'ordinary' })
  await ctx.plugin(AgentPreset, {
    id: 'ordinary',
    plugins: [
      { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        id: 'collaborate',
        name: '@deepseek-ai/dsh-tool-subagent-control',
        config: { interrupt: false },
      },
    ],
  })
  await ctx.plugin(DefaultModel, { provider: 'fixture', model: 'fixture' })
  await ctx.plugin(Attachments, { dshHome: folder })
  await ctx.plugin(TextUploads)
  await ctx.plugin(Registry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(SessionController)
  await ctx.plugin(SessionReferences)
  model = new Adapter()
  ctx.llm.registerAdapter(['fixture'], model)
  const pkg = await import('dsh-role-team')
  await ctx.plugin(pkg.default, { roleStoreDir: join(folder, 'roles') })
  service = ctx.roleTeam
  for (const name of [
    'mcp__chrome-devtools__list_pages',
    'mcp__gefei__get_guide',
    'bash',
    'web_search',
  ]) {
    ctx.tools.register({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => name + ' fixture result',
    })
  }
  ctx.systemPrompt.section({ name: 'mcp:fixture:tools', order: 30, text: 'On-demand tools: list_pages' })
  ctx.tools.register({
    name: 'session_search',
    description: 'Search transcripts',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'ALPHA-9527',
  })
}
beforeEach(async () => {
  folder = await mkdtemp(join(process.cwd(), 'node_modules', '.runtime-'))
  cwd = join(folder, 'project')
  await mkdir(cwd)
  await boot()
  await service.saveDocument({ roleId, text: role('rule-one'), expectedHash: null })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(folder, { recursive: true, force: true })
})
async function prompt(id: string, text: string) {
  const result = await ctx.sessionController.resolveAgent(id as SessionId)
  if ('error' in result) throw result.error
  result.agent.followup(
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
  )
  await result.agent.whenIdle()
}
function request(id: string) {
  const req = model.requests.filter((r) => r.sessionId === id).at(-1)
  expect(req, 'provider request from ' + id).toBeDefined()
  return req!
}
async function tool(id: string, name: string, args: Record<string, unknown>) {
  const agent = ctx.agents.get(id as SessionId)!
  expect(agent, 'live tool caller ' + id).toBeDefined()
  const batch = await ctx.tools.execute({
    agent,
    signal: new AbortController().signal,
    calls: [
      {
        type: 'tool-call',
        id: crypto.randomUUID() as ToolCallId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
  })
  return batch.results[0].result
}
it('shares saved experiences including legacy drafts and isolates team conversations at the model boundary', async () => {
  const ordinary = await ctx.sessionController.create({ cwd })
  await prompt(ordinary.sessionId, 'ordinary session')
  expect(request(ordinary.sessionId).tools?.map((t) => t.name)).toContain('session_search')
  const memory = (id: string, status: string, body: string) =>
    service.saveDocument({
      roleId,
      memoryId: id,
      expectedHash: null,
      text: serializeMarkdown(
        { id, title: id, status, scope: 'role_long_term', createdAt: new Date().toISOString() },
        body,
      ),
    })
  await memory('habit', 'published', 'published-habit')
  await memory('private', 'draft', 'private-draft')
  const a = await newTeam('A'),
    b = await newTeam('B')
  await prompt(a.run.rootSessionId, 'ALPHA-9527')
  await prompt(b.run.rootSessionId, 'Beta question')
  const beta = request(b.run.rootSessionId)
  expect(JSON.stringify(beta.messages)).toContain('published-habit')
  expect(JSON.stringify(beta.messages)).toContain('private-draft')
  expect(JSON.stringify(beta.messages)).not.toMatch(/ALPHA-9527/)
  expect(beta.tools?.map((t) => t.name)).toEqual(
    expect.arrayContaining(['team_task_list', 'send_message', 'list_agents']),
  )
  expect(beta.tools?.map((t) => t.name)).not.toContain('session_search')
  expect((await tool(b.run.rootSessionId, 'session_search', {})).isError).toBe(true)
  const one = await service.addMember({ runId: a.run.runId, roleId })
  const two = await service.addMember({ runId: b.run.runId, roleId })
  await service.promptSeat({
    seatId: one.seatId,
    generation: 1,
    delivery: 'queue',
    text: 'ALPHA-9527',
    requestId: crypto.randomUUID(),
  })
  await service.promptSeat({
    seatId: two.seatId,
    generation: 1,
    delivery: 'queue',
    text: 'beta-child',
    requestId: crypto.randomUUID(),
  })
  await vi.waitFor(() =>
    expect(JSON.stringify(request(two.currentSessionId).messages)).toContain('beta-child'),
  )
  const childContent = JSON.stringify(request(two.currentSessionId).messages)
  expect(childContent).toContain('published-habit')
  expect(childContent).not.toMatch(/ALPHA-9527/)
  expect(
    (
      await tool(b.run.rootSessionId, 'send_message', {
        agent: one.currentSessionId,
        message: 'unreachable',
      })
    ).isError,
  ).toBe(true)
  const betaRoot = ctx.agents.get(b.run.rootSessionId as SessionId)!
  await ctx.subagents.waitForTreeWork(betaRoot)
  await betaRoot.whenIdle()
  const count = model.requests.filter((r) => r.sessionId === b.run.rootSessionId).length
  const reference = Buffer.from(JSON.stringify(a.run.rootSessionId)).toString('base64url')
  await prompt(b.run.rootSessionId, '@[other](dsh-session:' + reference + ')')
  expect(model.requests.filter((r) => r.sessionId === b.run.rootSessionId)).toHaveLength(count)
  await expect(
    service.createTeam({ title: 'bad', roleId, workspaceCwd: join(folder, 'roles') }),
  ).rejects.toThrow(/separate/)
})
it('uses the latest published role and memory on the next turn across teams and cold starts', async () => {
  const a = await newTeam('A'),
    b = await newTeam('B')
  const opened = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  model.pause = async (req) => {
    if (req.sessionId === a.run.rootSessionId) {
      opened.resolve()
      await resume.promise
    }
  }
  const first = prompt(a.run.rootSessionId, 'start')
  await opened.promise
  try {
    await writeFile(join(folder, 'roles', roleId, 'role.md'), role('rule-two'))
    await vi.waitFor(async () =>
      expect((await service.readSnapshot(roleId, 2)).role.body).toBe('rule-two'),
    )
    await service.rememberExperience({ roleId, body: 'updated-lesson' })
    await prompt(b.run.rootSessionId, 'new team turn')
    expect(JSON.stringify(request(b.run.rootSessionId).messages)).toContain('updated-lesson')
    expect(JSON.stringify(request(b.run.rootSessionId).messages[0])).toContain('rule-two')
    expect(JSON.stringify(request(a.run.rootSessionId).messages)).not.toContain('rule-two')
    expect((await service.getTeam({ runId: a.run.runId })).seats[0].adoptedRoleRev).toBe(1)
    await service.promptSeat({
      seatId: a.run.leaderSeatId,
      generation: 1,
      delivery: 'steer',
      requestId: crypto.randomUUID(),
      text: 'same turn follow-up',
    })
  } finally {
    resume.resolve()
    await first
  }
  expect(JSON.stringify(request(a.run.rootSessionId).messages)).toContain('same turn follow-up')
  expect(JSON.stringify(request(a.run.rootSessionId).messages)).not.toContain('rule-two')
  const c = await newTeam('C')
  expect(c.seats[0].adoptedRoleRev).toBe(3)
  await ctx.fiber.dispose()
  await boot()
  await prompt(a.run.rootSessionId, 'next')
  await prompt(b.run.rootSessionId, 'next')
  expect(JSON.stringify(request(a.run.rootSessionId).messages[0])).toContain('rule-two')
  expect(JSON.stringify(request(b.run.rootSessionId).messages[0])).toContain('rule-two')
  expect((await service.getTeam({ runId: a.run.runId })).seats[0].adoptedRoleRev).toBe(3)
})
it('saves coaching changes and only shares the role profile across teams', async () => {
  const a = await newTeam('A')
  const training = await service.createTraining({
    roleId,
    workspaceCwd: cwd,
    mode: 'debrief',
    sourceRunId: a.run.runId,
  })
  const id = training.sessionId
  await prompt(id, 'private raw coaching')
  expect(
    request(id)
      .tools?.map((t) => t.name)
      .sort(),
  ).toEqual(expect.arrayContaining(['remember_experience', 'revise_experience', 'update_role']))
  expect(await tool(id, 'update_role', { name: 'Editor', body: 'confirmed-rule' })).toMatchObject({
    isError: false,
  })
  expect(await tool(id, 'remember_experience', { body: 'confirmed-habit' })).toMatchObject({
    isError: false,
  })
  expect((await service.readDocument({ roleId }))?.text).toContain('confirmed-rule')
  const [memoryId] = await service.listMemories(roleId)
  expect((await service.readDocument({ roleId, memoryId }))?.text).toContain('confirmed-habit')
  expect((await service.getTraining({ trainingId: training.trainingId })).proposals).toBeUndefined()
  const fresh = await newTeam('C')
  await prompt(fresh.run.rootSessionId, 'test')
  const content = JSON.stringify(request(fresh.run.rootSessionId).messages)
  expect(content).toContain('confirmed-rule')
  expect(content).toContain('confirmed-habit')
  expect(content).not.toMatch(/private raw coaching/)
})
it('keeps the coaching display name and rejects a new system name before saving', async () => {
  const ref = { roleId: 'seo' }
  await service.saveDocument({
    ...ref,
    expectedHash: null,
    text: serializeMarkdown({ id: 'seo', name: 'SEO大师' }, 'Initial'),
  })
  const training = await service.createTraining({ ...ref, mode: 'coach' })
  await prompt(training.sessionId, '今后先核对搜索意图')
  const update = (args: Record<string, string>) => tool(training.sessionId, 'update_role', args)
  expect(await update({ body: '先核对搜索意图' })).toMatchObject({ isError: false })
  const before = await service.readDocument(ref)
  expect(before?.text).toContain('name: SEO大师')
  for (const name of ['lead', 'ROOT'])
    expect(await update({ name, body: 'unexpected' })).toMatchObject({ isError: true })
  expect(await service.readDocument(ref)).toEqual(before)
  await prompt(training.sessionId, '把角色改名为搜索顾问')
  expect(await update({ name: '搜索顾问', body: '先核对搜索意图' })).toMatchObject({ isError: false })
  expect((await service.readDocument(ref))?.text).toContain('name: 搜索顾问')
})
it('creates a private empty workspace for each directory-free training session', async () => {
  const first = await service.createTraining({ roleId, mode: 'create' })
  const second = await service.createTraining({ roleId, mode: 'coach' })
  const sessionCwd = async (id: string) =>
    ctx.sessionQuery.inspectSession(id as SessionId, (session) => session.header.cwd!)
  const sandbox = await sessionCwd(first.sessionId),
    other = await sessionCwd(second.sessionId)
  const author = await service.createTraining({ roleId: 'author', mode: 'create' })
  const sandboxRoot = join(await realpath(folder), 'roles.training-sandboxes')
  expect(dirname(await sessionCwd(author.sessionId))).toBe(join(sandboxRoot, 'author'))
  expect(dirname(sandbox)).toBe(join(sandboxRoot, roleId))
  expect(dirname(other)).toBe(dirname(sandbox))
  expect(sandbox).not.toBe(other)
  for (const path of [sandbox, other]) {
    expect(await realpath(path)).toBe(path)
    expect(await readdir(path)).toEqual([])
  }
  await prompt(second.sessionId, 'Coach me')
  expect(request(second.sessionId).messages).toBeDefined()
  const explicit = await service.createTraining({ roleId, mode: 'coach', workspaceCwd: cwd })
  expect(await sessionCwd(explicit.sessionId)).toBe(await realpath(cwd))
})

it('refuses an automatic sandbox redirected into the role library', async () => {
  await symlink(join(folder, 'roles'), join(folder, 'roles.training-sandboxes'), 'dir')
  await expect(service.createTraining({ roleId, mode: 'coach' })).rejects.toThrow(/refusing link/)
  expect(await service.listTrainings({ roleId })).toEqual([])
})

it('rejects traversal and a role sandbox linked to another role', async () => {
  await expect(service.createTraining({ roleId: '../escape', mode: 'create' })).rejects.toThrow()
  const root = join(folder, 'roles.training-sandboxes')
  await service.createTraining({ roleId, mode: 'coach' })
  await symlink(join(root, roleId), join(root, 'author'), 'dir')
  await expect(service.createTraining({ roleId: 'author', mode: 'create' })).rejects.toThrow(
    /refusing link/,
  )
  expect(await service.listTrainings({ roleId: 'author' })).toEqual([])
})

it('replaces only the selected role chat and carries its self-authored profile into a fresh context', async () => {
  const other = await service.createTraining({ roleId, mode: 'coach' })
  const apprentice = 'apprentice'
  const first = await service.createTraining({ roleId: apprentice, mode: 'create' })
  await prompt(first.sessionId, 'discard-old-dialog-9527')
  expect(
    await tool(first.sessionId, 'update_role', { name: 'Apprentice', body: 'Observe carefully.' }),
  ).toMatchObject({ isError: false })
  expect(
    await tool(first.sessionId, 'remember_experience', { body: 'Ask for evidence.' }),
  ).toMatchObject({ isError: false })
  await service.rememberExperience({ roleId: apprentice, body: 'Ask for evidence.' })
  const ids = await service.listMemories(apprentice)
  expect(ids).toHaveLength(1)
  expect(
    await tool(first.sessionId, 'revise_experience', {
      memoryId: ids[0],
      title: 'Sources',
      body: 'Ask for primary evidence.',
    }),
  ).toMatchObject({ isError: false })
  expect(await service.listMemories(apprentice)).toEqual(ids)
  const second = await service.createTraining({ roleId: apprentice, mode: 'coach' })
  expect(second.sessionId).not.toBe(first.sessionId)
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(first.sessionId)
  expect(await service.listTrainings({ roleId: apprentice })).toMatchObject([
    { trainingId: second.trainingId },
  ])
  await expect(service.getTraining({ trainingId: first.trainingId })).rejects.toThrow()
  expect(await service.getTraining({ trainingId: other.trainingId })).toMatchObject(other)
  await prompt(second.sessionId, 'Hello')
  const messages = JSON.stringify(request(second.sessionId).messages)
  expect(messages).toContain('Observe carefully.')
  expect(messages).toContain('Ask for primary evidence.')
  expect(messages).not.toContain('Ask for evidence.')
  expect(messages).not.toContain('discard-old-dialog-9527')
})
it('reuses the current training across concurrent opens, cold start and an explicit replacement', async () => {
  const [a, b] = await Promise.all([service.openTraining({ roleId }), service.openTraining({ roleId })])
  expect(a.sessionId).toBe(b.sessionId)
  expect(await service.listTrainings({ roleId })).toHaveLength(1)
  await ctx.fiber.dispose()
  await boot()
  expect((await service.openTraining({ roleId })).sessionId).toBe(a.sessionId)
  const next = await service.createTraining({ roleId, mode: 'coach' })
  expect(next.sessionId).not.toBe(a.sessionId)
  expect((await service.openTraining({ roleId })).sessionId).toBe(next.sessionId)
  expect(await service.listTrainings({ roleId })).toHaveLength(1)
})
async function permissions() {
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  ctx.provide('approval', { config: { policy: 'ask' } } as never)
  await ctx.plugin(Permissions, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  return ctx.permissionPresets
}
it('starts coaching with full access and carries the native selection across restarts and replacements', async () => {
  const presets = await permissions()
  const first = await service.openTraining({ roleId })
  const session = ctx.agents.get(first.sessionId as SessionId)!.session
  expect(presets.current(session)).toBe('danger-full-access')
  presets.set(session, 'workspace-write')
  await ctx.fiber.dispose()
  await boot()
  const restored = await permissions()
  const second = await service.createTraining({ roleId, mode: 'coach', expectedTrainingId: first.trainingId })
  const next = ctx.agents.get(second.sessionId as SessionId)!.session
  expect(restored.current(next)).toBe('workspace-write')
  await expect(service.createTraining({ roleId, mode: 'coach', expectedTrainingId: first.trainingId })).rejects.toThrow(/already been replaced/)
  expect((await service.openTraining({ roleId })).trainingId).toBe(second.trainingId)
  restored.set(next, 'danger-full-access')
  const third = await service.createTraining({ roleId, mode: 'coach', expectedTrainingId: second.trainingId })
  expect(restored.current(ctx.agents.get(third.sessionId as SessionId)!.session)).toBe('danger-full-access')
})
it('finishes retiring an interrupted chat replacement on cold start', async () => {
  const first = await service.createTraining({ roleId, mode: 'coach' })
  const second = await service.createTraining({ roleId, mode: 'coach' })
  await service.index.training.put(first)
  await service.index.training.update(second.trainingId, (row) => ({
    ...row,
    replaces: [first.trainingId],
  }))
  await ctx.fiber.dispose()
  await boot()
  expect(await service.listTrainings({ roleId })).toMatchObject([{ trainingId: second.trainingId }])
  await expect(service.getTraining({ trainingId: first.trainingId })).rejects.toThrow()
  await vi.waitFor(() => {
    expect(service.index.training.get(first.trainingId)).toBeUndefined()
    expect(service.index.training.get(second.trainingId)?.replaces).toBeUndefined()
  })
})
it('only deletes archived team indexes and resumes interrupted deletion without touching shared roles', async () => {
  const a = await newTeam('Discard'), b = await newTeam('Keep')
  const runId = a.run.runId
  const child = await service.addMember({ runId, roleId })
  await service.resetSeat({ seatId: child.seatId, generation: 1, handoff: '' })
  const file = await service.readDocument({ roleId })
  const remaining = await service.getTeam({ runId: b.run.runId })
  await expect(service.deleteTeam({ runId })).rejects.toThrow(/Only archived teams/)
  expect(await service.listGenerations({ seatId: child.seatId })).toHaveLength(2)
  await service.archiveTeam({ runId })
  expect(await service.listTeams({ includeMemberCounts: true })).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId, memberCount: 2 }),
    expect.objectContaining({ runId: b.run.runId, memberCount: 1 }),
  ]))
  const interrupted = vi.spyOn(service.index.seats, 'delete').mockRejectedValueOnce(new Error('disk offline'))
  await expect(service.deleteTeam({ runId })).rejects.toThrow('disk offline')
  interrupted.mockRestore()
  await ctx.fiber.dispose()
  await boot()
  await vi.waitFor(() => expect(service.index.runs.get(runId)).toBeUndefined())
  expect(await service.deleteTeam({ runId })).toBe(false)
  expect(service.index.seats.list().map(s => s.runId)).toEqual([b.run.runId])
  expect(service.index.generations.list().map(g => g.seatId)).toEqual([b.run.leaderSeatId])
  expect(await service.getTeam({ runId: b.run.runId })).toEqual(remaining)
  expect(await service.readDocument({ roleId })).toEqual(file)
})
it('archives a child, transfers open tasks, preserves audit history and serializes resets', async () => {
  const a = await newTeam('A')
  const child = await service.addMember({ runId: a.run.runId, roleId })
  const oldId = child.currentSessionId as SessionId,
    root = ctx.agents.get(a.run.rootSessionId as SessionId)!
  const task = async (subject: string) => {
    const created = await ctx.agentTeams.createTask(root, { subject, description: subject })
    return ctx.agentTeams.updateTask(root, {
      taskId: created.id,
      expectedRevision: created.revision,
      action: 'reassign',
      owner: oldId,
    })
  }
  const open = await task('open'),
    done = await task('done')
  await ctx.agentTeams.updateTask(root, {
    taskId: done.id,
    expectedRevision: done.revision,
    action: 'complete',
  })
  let oldStopped = false
  model.pause = async (req) => {
    if (req.sessionId !== oldId || !JSON.stringify(req.messages).includes('old-task-noise')) return
    await new Promise<void>((resolve) =>
      req.signal!.addEventListener(
        'abort',
        () => {
          oldStopped = true
          resolve()
        },
        { once: true },
      ),
    )
  }
  await service.promptSeat({
    seatId: child.seatId,
    generation: 1,
    text: 'old-task-noise',
    delivery: 'queue',
    requestId: crypto.randomUUID(),
  })
  await vi.waitFor(() => expect(JSON.stringify(request(oldId).messages)).toContain('old-task-noise'))
  const reset = { seatId: child.seatId, generation: 1, handoff: 'only-handoff' }
  const results = await Promise.allSettled([service.resetSeat(reset), service.resetSeat(reset)])
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  const updated = (await service.getTeam({ runId: a.run.runId })).seats.find(
    (s) => s.seatId === child.seatId,
  )!
  expect(updated.currentGeneration).toBe(2)
  expect(oldStopped).toBe(true)
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(oldId)
  expect(ctx.agentTeams.listTasks(root)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: open.id, ownerId: updated.currentSessionId }),
      expect.objectContaining({ id: done.id, ownerId: oldId }),
    ]),
  )
  await vi.waitFor(() =>
    expect(JSON.stringify(request(updated.currentSessionId).messages)).toContain('only-handoff'),
  )
  expect(JSON.stringify(request(updated.currentSessionId).messages)).not.toMatch(/old-task-noise/)
  expect(await service.listGenerations({ seatId: child.seatId })).toHaveLength(2)
  const nested = await service.addMember({ runId: a.run.runId, parentSeatId: child.seatId, roleId })
  expect(nested.parentSeatId).toBe(child.seatId)
  await expect(service.resetSeat({ ...reset, generation: 2 })).rejects.toThrow(/descendants/)
})
it('resumes a partially committed replacement after a host restart without spawning a third child', async () => {
  const { run } = await newTeam('recover')
  const seat = await service.addMember({ runId: run.runId, roleId })
  const root = ctx.agents.get(run.rootSessionId as SessionId)!
  const task = await ctx.agentTeams.createTask(root, { subject: 'handover', description: 'work' })
  await ctx.agentTeams.updateTask(root, {
    action: 'reassign',
    taskId: task.id,
    expectedRevision: task.revision,
    owner: seat.currentSessionId as SessionId,
  })
  const reset = { seatId: seat.seatId, generation: 1, handoff: 'durable handoff' }
  const fault = vi.spyOn(Teams.prototype, 'updateTask').mockRejectedValueOnce(new Error('board offline'))
  try {
    await expect(service.resetSeat(reset)).rejects.toThrow('board offline')
  } finally {
    fault.mockRestore()
  }
  const locked = (await service.getTeam({ runId: run.runId })).seats.find(
    (s) => s.seatId === seat.seatId,
  )!
  expect(locked.status).toBe('resetting')
  await expect(
    service.promptSeat({
      seatId: seat.seatId,
      generation: 1,
      text: 'late',
      requestId: crypto.randomUUID(),
      delivery: 'queue',
    }),
  ).rejects.toThrow('unavailable')
  await ctx.fiber.dispose()
  await boot()
  const restored = await service.resetSeat(reset)
  expect(restored.currentSessionId).toBe(locked.reset!.sessionId)
  expect(await ctx.subagents.listDescendants(run.rootSessionId as SessionId)).toHaveLength(2)
  expect(ctx.agentTeams.listTasks(ctx.agents.get(root.id)!)[0].ownerId).toBe(restored.currentSessionId)
})

it('uses the published coaching defaults without persisting temporary picker or request selections', async () => {
  const presets = await permissions()
  const defaultModel = { provider: 'fixture', model: 'authoring', reasoningEffort: 'high' }
  const temporary = { provider: 'fixture', model: 'fixture' }
  const created = await service.createRole({ name: 'Coach', defaultModel, defaultPermission: 'read-only' })
  if (!created.ok) throw new Error('Expected a published role')
  const { roleId } = created.status
  const coach = await service.openTraining({ roleId })
  const live = ctx.agents.get(coach.sessionId as SessionId)!
  expect(live.model.current()).toEqual(defaultModel)
  expect(presets.current(live.session)).toBe('read-only')
  await ctx.sessionController.selectModel({ sessionId: live.id, ...temporary })
  presets.set(live.session, 'workspace-write')
  await prompt(live.id, 'Use the temporary selection')
  expect(request(live.id).model).toBe('fixture')
  expect(service.index.models.get(roleId)).toBeUndefined()
  const next = await service.createTraining({ roleId, mode: 'coach' })
  const nextAgent = ctx.agents.get(next.sessionId as SessionId)!
  expect(nextAgent.model.current()).toEqual(defaultModel)
  expect(presets.current(nextAgent.session)).toBe('read-only')
})
it('clears a stale remembered model when a role default is removed without changing the live chat', async () => {
  const defaultModel = { provider: 'fixture', model: 'authoring', reasoningEffort: 'high' }
  const created = await service.createRole({ name: 'Coach', defaultModel })
  if (!created.ok || !created.hash) throw new Error('Expected a published role')
  const { roleId } = created.status
  await service.index.models.put({ roleId, selection: { provider: 'fixture', model: 'authoring' } })
  const coach = await service.openTraining({ roleId })
  const live = ctx.agents.get(coach.sessionId as SessionId)!
  expect(live.model.current()).toEqual(defaultModel)
  expect(await service.saveDocument({ roleId, expectedHash: created.hash, text: serializeMarkdown({ id: roleId, name: 'Coach' }, '') })).toMatchObject({ ok: true })
  expect(live.model.current()).toEqual(defaultModel)
  expect(service.index.models.get(roleId)).toBeUndefined()
  const next = await service.createTraining({ roleId, mode: 'coach' })
  expect(ctx.agents.get(next.sessionId as SessionId)!.model.current()?.model).toBe('fixture')
})
it('carries a role model and effort across training, team admission and restart', async () => {
  const first = await service.createTraining({ roleId, mode: 'coach' })
  const choice = { provider: 'fixture', model: 'authoring', reasoningEffort: 'high' }
  await ctx.sessionController.selectModel({ sessionId: first.sessionId as SessionId, ...choice })
  await vi.waitFor(() => expect(service.index.models.get(roleId)?.selection).toEqual(choice))
  const a = await newTeam('甲')
  const child = await service.addMember({ runId: a.run.runId, roleId })
  await vi.waitFor(() => expect(request(child.currentSessionId).model).toBe('authoring'))
  expect(ctx.agents.get(child.currentSessionId as SessionId)?.model.current()).toEqual(choice)
  // Both providers publish the same model ID and caption. Persist the exact route.
  ctx.llm.registerAdapter(['second-fixture'], model)
  const next = { provider: 'second-fixture', model: choice.model, reasoningEffort: 'high' }
  await service.selectSeatModel({ seatId: child.seatId, generation: 1, selection: next })
  expect(service.index.models.get(roleId)?.selection).toEqual(next)
  await expect(
    service.selectSeatModel({ seatId: child.seatId, generation: 2, selection: choice }),
  ).rejects.toThrow()
  await ctx.fiber.dispose()
  await boot()
  ctx.llm.registerAdapter(['second-fixture'], model)
  const later = await service.createTraining({ roleId, mode: 'coach' })
  expect(ctx.agents.get(later.sessionId as SessionId)?.model.current()).toEqual(next)
})
it('applies the leader permission but not a member permission, and restores the explicit seat model on reset', async () => {
  const presets = await permissions()
  const lead = await service.createRole({ name: 'Lead fixture', defaultPermission: 'read-only' })
  const defaultModel = { provider: 'fixture', model: 'authoring', reasoningEffort: 'high' }
  const editor = await service.createRole({ name: 'Editor fixture', defaultModel, defaultPermission: 'danger-full-access' })
  if (!lead.ok || !editor.ok) throw new Error('Expected published roles')
  const { run } = await service.createTeam({ title: 'Team', workspaceCwd: cwd, roleId: lead.status.roleId })
  const root = ctx.agents.get(run.rootSessionId as SessionId)!
  expect(presets.current(root.session)).toBe('read-only')
  expect(run.permissionPreset).toBe('read-only')
  const child = await service.addMember({ runId: run.runId, roleId: editor.status.roleId })
  const live = ctx.agents.get(child.currentSessionId as SessionId)!
  expect(presets.current(live.session)).toBe('read-only')
  expect(live.model.current()).toEqual(defaultModel)
  await ctx.subagents.waitForTreeWork(root)
  const selected = { provider: 'fixture', model: 'fixture' }
  await service.selectSeatModel({ seatId: child.seatId, generation: 1, selection: selected })
  expect(service.index.models.get(editor.status.roleId)).toBeUndefined()
  const replacement = await service.resetSeat({ seatId: child.seatId, generation: 1, handoff: '' })
  const next = ctx.agents.get(replacement.currentSessionId as SessionId)!
  expect(next.model.current()).toEqual(selected)
  expect(presets.current(next.session)).toBe('read-only')
  await ctx.subagents.waitForTreeWork(root)
})
it('includes the joining child in its first system message and makes it public before notifying the lead', async () => {
  const { run } = await newTeam('Admission order')
  const firstSystem = Promise.withResolvers<string>()
  let noticeRoster: ReturnType<typeof service.teamMentionRoster> | undefined
  ctx.on('session/event', (session, event) => {
    if (session.id.startsWith('rt-child-') && event.type === 'system/message' && event.data.turn === 1) {
      const text = event.data.message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n')
      firstSystem.resolve(text)
    }
    if (session.id === run.rootSessionId && !noticeRoster &&
        (event.type === 'user/message' || event.type === 'agent/inbox/spliced') &&
        JSON.stringify(event.data).includes('已加入团队并就绪')) {
      noticeRoster = service.teamMentionRoster({ sessionId: run.rootSessionId })
    }
  })
  // Hold admission open until the child's actual first system/message has been recorded.
  const start = ctx.subagents.startActivation.bind(ctx.subagents)
  let pendingRoster: Awaited<ReturnType<typeof service.teamMentionRoster>> | undefined
  vi.spyOn(ctx.subagents, 'startActivation').mockImplementation(async spec => {
    const activation = await start(spec)
    await firstSystem.promise
    pendingRoster = await service.teamMentionRoster({ sessionId: run.rootSessionId })
    return activation
  })
  const child = await service.addMember({ runId: run.runId, roleId })
  const rosterLine = (await firstSystem.promise).split('\n').find(line => line.startsWith('{"runId":'))
  expect(rosterLine).toBeDefined()
  expect(JSON.parse(rosterLine!)).toMatchObject({ runId: run.runId, selfSeatId: child.seatId,
    members: expect.arrayContaining([expect.objectContaining({ seatId: child.seatId, address: child.nativeAgentName })]) })
  expect(pendingRoster?.members.map(s => s.seatId)).toEqual([run.leaderSeatId])
  await vi.waitFor(() => expect(noticeRoster).toBeDefined())
  expect((await noticeRoster)?.members.map(s => s.seatId)).toContain(child.seatId)
})

it('keeps an admitted child ready after a notification failure and recovers a legacy joining flag', async () => {
  const { run } = await newTeam('Recover admission')
  const offline = new Error('Join notice delivery unavailable')
  const send = vi.spyOn(ctx.subagents, 'sendMessage').mockRejectedValue(offline)
  const fallback = vi.spyOn(ctx.sessionController, 'prompt').mockRejectedValue(offline)
  const child = await service.addMember({ runId: run.runId, roleId })
  expect(send.mock.calls.length + fallback.mock.calls.length).toBeGreaterThan(0)
  expect(child.joining).toBeUndefined()
  expect(service.index.seats.get(child.seatId)?.status).toBe('active')
  send.mockRestore()
  fallback.mockRestore()
  await ctx.subagents.waitForTreeWork(ctx.agents.get(run.rootSessionId as SessionId)!)
  await service.index.seats.update(child.seatId, s => ({ ...s, joining: true }))
  await ctx.fiber.dispose()
  await boot()
  expect(service.index.seats.get(child.seatId)).toMatchObject({ status: 'active',
    currentSessionId: child.currentSessionId, currentGeneration: 1 })
  expect(service.index.seats.get(child.seatId)?.joining).toBeUndefined()
  expect((await ctx.subagents.listDescendants(run.rootSessionId as SessionId)).map(s => s.id))
    .toEqual([child.currentSessionId])
  expect((await service.teamMentionRoster({ sessionId: run.rootSessionId }))?.members.map(s => s.seatId))
    .toContain(child.seatId)
})

it('delivers a localized membership notice and mirrors the lead permission to live and new children', async () => {
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  ctx.provide('approval', { config: { policy: 'ask' } } as never)
  await ctx.plugin(Permissions, {})
  const team = await newTeam('甲')
  const root = ctx.agents.get(team.run.rootSessionId as SessionId)!
  const memberId = 'new-editor'
  await service.saveDocument({
    roleId: memberId,
    expectedHash: null,
    text: serializeMarkdown(
      { id: memberId, name: 'Editor', summary: '核对引文' },
      'UNSHARED_EDITOR_DETAILS',
    ),
  })
  const first = await service.addMember({ runId: team.run.runId, roleId: memberId, displayName: '审稿' })
  await ctx.subagents.waitForTreeWork(root)
  await root.whenIdle()
  expect(JSON.stringify(request(root.id).messages)).toContain('成员「审稿」已加入团队并就绪')
  expect(first.nativeAgentName).toBe('new-editor')
  expect(JSON.stringify(request(root.id).messages)).toContain('核对引文')
  expect(JSON.stringify(request(root.id).messages)).not.toContain('UNSHARED_EDITOR_DETAILS')
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  model.pause = async (req) => {
    if (req.sessionId === first.currentSessionId) {
      started.resolve()
      await finish.promise
    }
  }
  await service.promptSeat({
    seatId: first.seatId,
    generation: 1,
    requestId: crypto.randomUUID(),
    delivery: 'queue',
    text: 'hold',
  })
  await started.promise
  const live = ctx.agents.get(first.currentSessionId as SessionId)!
  try {
    ctx.permissionPresets.set(root.session, 'danger-full-access')
    await vi.waitFor(() =>
      expect(ctx.permissionPresets.current(live.session)).toBe('danger-full-access'),
    )
    const second = await service.addMember({
      runId: team.run.runId,
      roleId: memberId,
      displayName: '审稿',
    })
    expect(second.nativeAgentName).toBe('new-editor-2')
    expect(
      ctx.permissionPresets.current(ctx.agents.get(second.currentSessionId as SessionId)!.session),
    ).toBe('danger-full-access')
    ctx.permissionPresets.set(root.session, 'workspace-write')
    await vi.waitFor(() => expect(ctx.permissionPresets.current(live.session)).toBe('workspace-write'))
  } finally {
    finish.resolve()
    await ctx.subagents.waitForTreeWork(root)
    await root.whenIdle()
  }
})
it('admits MCP and host capabilities in training, team roots and child turns while fencing session lookup', async () => {
  const a = await newTeam('Tools')
  const child = await service.addMember({ runId: a.run.runId, roleId })
  const training = await service.openTraining({ roleId })
  const finish = Promise.withResolvers<void>()
  await ctx.subagents.waitForTreeWork(ctx.agents.get(a.run.rootSessionId as SessionId)!)
  model.pause = async (req) => {
    if (req.sessionId === child.currentSessionId) await finish.promise
  }
  try {
    for (const id of [training.sessionId, a.run.rootSessionId, child.currentSessionId]) {
      if (id === child.currentSessionId) {
        await service.promptSeat({
          seatId: child.seatId,
          generation: 1,
          requestId: crypto.randomUUID(),
          text: 'Check available tools',
          delivery: 'queue',
        })
        await vi.waitFor(() =>
          expect(JSON.stringify(request(id).messages)).toContain('Check available tools'),
        )
      } else await prompt(id, 'Check available tools')
      const req = request(id),
        names = req.tools?.map((t) => t.name)
      expect(JSON.stringify(req.messages)).toContain('On-demand tools: list_pages')
      for (const name of [
        'mcp__chrome-devtools__list_pages',
        'mcp__gefei__get_guide',
        'bash',
        'web_search',
        'read',
      ]) {
        expect(names).toContain(name)
        if (name !== 'read') expect((await tool(id, name, {})).isError).toBeFalsy()
      }
      expect(names).not.toContain('session_search')
      expect((await tool(id, 'session_search', {})).isError).toBe(true)
      expect(
        (await tool(id, 'read', { file_path: join(folder, 'roles', roleId, 'role.md') })).isError,
      ).toBe(true)
    }
  } finally {
    finish.resolve()
    await ctx.subagents.waitForTreeWork(ctx.agents.get(a.run.rootSessionId as SessionId)!)
  }
})
it('permits ordinary file edits and protects the role library through direct and linked paths', async () => {
  const a = await newTeam('Files')
  const id = a.run.rootSessionId
  const path = join(cwd, 'result.md')
  expect((await tool(id, 'write', { file_path: path, content: 'local' })).isError).toBeFalsy()
  expect(await readFile(path, 'utf8')).toBe('local')
  expect(
    (await tool(id, 'edit', { file_path: path, old_string: 'local', new_string: 'done' })).isError,
  ).toBeFalsy()
  const extra = join(folder, 'outside.md')
  await writeFile(extra, 'ordinary host file')
  expect((await tool(id, 'read', { file_path: extra })).isError).toBeFalsy()
  const roleFile = join(folder, 'roles', roleId, 'role.md')
  await symlink(roleFile, join(cwd, 'linked.md'))
  for (const file_path of [roleFile, join(cwd, 'linked.md')]) {
    expect((await tool(id, 'read', { file_path })).isError).toBe(true)
    expect((await tool(id, 'write', { file_path, content: 'outside' })).isError).toBe(true)
  }
  expect(await readFile(roleFile, 'utf8')).toContain('rule-one')
})
it('deletes a role and its coaching entry while existing seats can run and reset from their snapshots', async () => {
  const { run } = await newTeam('Keep team')
  const child = await service.addMember({ runId: run.runId, roleId })
  const training = await service.createTraining({ roleId, mode: 'coach' })
  const original = await service.readDocument({ roleId })
  await service.saveDocument({
    roleId,
    expectedHash: original!.hash,
    text: serializeMarkdown({ id: roleId, name: 'Reviewer', defaultModel: { provider: 'fixture', model: 'authoring' } }, 'last adopted instructions'),
  })
  async function send(seat: typeof child, text: string) {
    await service.promptSeat({
      seatId: seat.seatId,
      generation: seat.currentGeneration,
      text,
      delivery: 'queue',
      requestId: crypto.randomUUID(),
    })
    await vi.waitFor(() =>
      expect(JSON.stringify(request(seat.currentSessionId).messages)).toContain(text),
    )
  }
  await send(child, 'adopt-latest')
  expect(await service.deleteRole({ roleId, expectedHash: original!.hash })).toMatchObject({
    ok: false,
    code: 'conflict',
  })
  expect(await service.listTrainings({ roleId })).toHaveLength(1)
  const expectedHash = (await service.readDocument({ roleId }))!.hash
  expect(await service.deleteRole({ roleId, expectedHash })).toMatchObject({ ok: true })
  expect(await service.deleteRole({ roleId, expectedHash })).toMatchObject({ ok: true })
  expect(await service.listRoles()).toEqual([])
  expect(await service.listTrainings({})).toEqual([])
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(training.sessionId)
  await expect(newTeam('Unavailable')).rejects.toThrow()
  await send(child, 'still here')
  expect(JSON.stringify(request(child.currentSessionId).messages[0])).toContain(
    'last adopted instructions',
  )
  await ctx.fiber.dispose()
  await boot()
  const reset = await service.resetSeat({ seatId: child.seatId, generation: 1, handoff: 'continue' })
  await send(reset, 'after deletion')
  expect(request(reset.currentSessionId).model).toBe('authoring')
  expect(JSON.stringify(request(reset.currentSessionId).messages[0])).toContain(
    'last adopted instructions',
  )
  expect(await service.listRoles()).toEqual([])
})
it('deletes a legacy coaching-only role without creating a profile or reviving the role at restart', async () => {
  const id = 'unsaved-role'
  const training = await service.createTraining({ roleId: id, mode: 'create' })
  expect(await service.deleteRole({ roleId: id, expectedHash: null })).toMatchObject({ ok: true })
  await expect(service.createTraining({ roleId: id, mode: 'create' })).rejects.toThrow(/retired/)
  // A different profile or an interrupted cleanup can still own an old training row.
  await service.index.training.put(training)
  expect(await service.listTrainings({ roleId: id })).toEqual([])
  await ctx.fiber.dispose()
  await boot()
  await vi.waitFor(() => expect(service.index.training.get(training.trainingId)).toBeUndefined())
  expect(await service.listRoles()).toMatchObject([{ roleId }])
})

it('resumes legacy managed roots, children and coaching with the host default and preserves the prior log', async () => {
  await ctx.plugin(AgentPreset, { id: 'role-team', plugins: [] })
  const original = ctx.sessionController.create.bind(ctx.sessionController)
  const create = vi
    .spyOn(ctx.sessionController, 'create')
    .mockImplementation((request) => original({ ...request, agentPreset: 'role-team' }))
  const { run } = await newTeam('legacy')
  const child = await service.addMember({ runId: run.runId, roleId })
  const training = await service.createTraining({ roleId, mode: 'coach' })
  create.mockRestore()
  await prompt(training.sessionId, 'legacy-coach')
  await ctx.agents.get(child.currentSessionId as SessionId)?.whenIdle()
  await ctx.agents.get(run.rootSessionId as SessionId)!.whenIdle()
  await ctx.fiber.dispose()
  await boot()
  for (const id of [run.rootSessionId, child.currentSessionId, training.sessionId]) {
    const read = await ctx.sessionPersistence.open(id as SessionId, 'read')
    try {
      expect(read.header.agentPreset).toBe('role-team')
      expect(
        (await read.read()).events.filter((e) => e.type === 'agent-preset/selected').at(-1)?.data
          .agentPreset,
      ).toBe('ordinary')
    } finally {
      await read.close()
    }
  }
  expect((await ctx.agentPresets.list()).map((p) => p.id)).not.toContain('role-team')
  await prompt(training.sessionId, 'resumed coaching')
  expect(JSON.stringify(request(training.sessionId).messages)).toContain('legacy-coach')
  expect(request(training.sessionId).tools?.map((t) => t.name)).toContain('update_role')
  await prompt(run.rootSessionId, 'resumed team')
  expect(request(run.rootSessionId).tools?.map((t) => t.name)).toContain('send_message')
  await service.promptSeat({
    seatId: child.seatId,
    generation: child.currentGeneration,
    requestId: crypto.randomUUID(),
    text: 'resume legacy child',
    delivery: 'queue',
  })
  await vi.waitFor(() =>
    expect(
      model.requests.some(
        (r) =>
          r.sessionId === child.currentSessionId &&
          JSON.stringify(r.messages).includes('resume legacy child'),
      ),
    ).toBe(true),
  )
})

it('applies the chosen native team preset to the root and its fresh child, and locks coaching after its first turn', async () => {
  await ctx.plugin(AgentPreset, { id: 'minimal', plugins: [] })
  const team = await service.createTeam({
    title: 'Selected',
    roleId,
    workspaceCwd: cwd,
    agentPreset: 'minimal',
  })
  const child = await service.addMember({ runId: team.run.runId, roleId })
  expect(team.run.agentPreset).toBe('minimal')
  for (const id of [team.run.rootSessionId, child.currentSessionId]) {
    expect((await ctx.sessionPersistence.stat(id as SessionId))?.header.agentPreset).toBe('minimal')
  }
  const coach = await service.createTraining({ roleId, mode: 'coach' })
  const result = await ctx.sessionController.resolveAgent(coach.sessionId as SessionId)
  if ('error' in result) throw result.error
  await ctx.agentPresets.select(result.agent, 'minimal')
  await prompt(coach.sessionId, 'apply the new mode')
  expect(JSON.stringify(request(coach.sessionId).messages)).toContain('rule-one')
  expect(request(coach.sessionId).tools?.map((t) => t.name)).toContain('update_role')
  await expect(ctx.agentPresets.select(result.agent, 'ordinary')).rejects.toThrow(/already started/)
})

it('asks once for the Chinese report when a coaching turn would close without it', async () => {
  const coach = await service.createTraining({ roleId, mode: 'coach', locale: 'zh' })
  let invoked = false
  model.pause = async (req) => {
    if (req.sessionId !== coach.sessionId || invoked) return
    invoked = true
    const saved = await tool(coach.sessionId, 'remember_experience', { body: '先确认来源。' })
    expect(JSON.stringify(saved)).toContain('必须在本轮最终回复正文中用中文')
  }
  await prompt(coach.sessionId, '请记住经验')
  const requests = model.requests.filter((r) => r.sessionId === coach.sessionId)
  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('已记住经验「先确认来源。」')
  expect(await service.listMemories(roleId)).toHaveLength(1)
})

it('executes all coaching tools in the native PTC Node runtime and records successful and failed nested calls', async () => {
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(SandboxLocal)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  await ctx.plugin(NodePtcRuntime, { executionMode: 'per-call' })
  await ctx.plugin(AgentPreset, {
    id: 'ptc',
    plugins: [{ id: 'ptc-executor', name: '@deepseek-ai/dsh-tool-executor-ptc' }],
  })
  const coach = await service.createTraining({ roleId, mode: 'coach' })
  const id = coach.sessionId as SessionId
  const result = await ctx.sessionController.resolveAgent(id)
  if ('error' in result) throw result.error
  await ctx.agentPresets.select(result.agent, 'ptc')
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === id) events.push(event)
  })
  model.program = `
    await tools.update_role({ body: "Check the evidence." })
    await tools.remember_experience({ body: "Verify every source." })
  `
  await prompt(id, 'Save the role and lesson')
  const [memoryId] = await service.listMemories(roleId)
  expect(memoryId).toBeDefined()
  model.program = `
    await tools.revise_experience({
      memoryId: ${JSON.stringify(memoryId)}, title: "Sources", body: "Prefer original sources."
    })
    await tools["mcp__chrome-devtools__list_pages"]({})
  `
  await prompt(id, 'Revise the lesson and list pages')
  model.program = 'await tools.update_role({name:"lead",body:"Do not apply."})'
  await prompt(id, 'Exercise the protected rename')
  expect(JSON.stringify(await service.readDocument({ roleId, memoryId }))).toContain(
    'Prefer original sources.',
  )
  expect(request(id).tools?.map((t) => t.name)).toEqual(['run_code'])
  const calls = events.filter((e) => e.type === 'tool/ptc-dispatch').map((e) => e.data)
  expect(calls.map((call) => [call.name, call.isError])).toEqual([
    ['update_role', false],
    ['remember_experience', false],
    ['revise_experience', false],
    ['mcp__chrome-devtools__list_pages', false],
    ['update_role', true],
  ])
  expect(calls.at(-1)?.arguments).toMatchObject({ name: 'lead' })
  expect(JSON.stringify(calls.at(-1)?.content)).toContain('系统名称')
})

it('shows a published rename immediately and falls back to the stored seat name after deletion', async () => {
  const { run, seats: [leader] } = await newTeam('Name history')
  const original = await service.readDocument({ roleId })
  const edited = await service.saveDocument({ roleId, expectedHash: original!.hash,
    text: serializeMarkdown({ id: roleId, name: '复核员' }, 'Review the draft') })
  expect(edited.ok).toBe(true)
  async function check(name: string) {
    const team = await service.getTeam({ runId: run.runId })
    expect(team.seats).toEqual([{ ...leader, displayName: name }])
    expect(await service.teamMentionRoster({ sessionId: run.rootSessionId })).toMatchObject({
      members: [{ name, seatId: leader.seatId, address: 'lead' }],
    })
    expect(await service.teamMessageSender({ sessionId: run.rootSessionId, senderId: run.rootSessionId }))
      .toMatchObject({ name })
  }
  await check('复核员')
  const expectedHash = (await service.readDocument({ roleId }))!.hash
  expect(await service.deleteRole({ roleId, expectedHash })).toMatchObject({ ok: true })
  await check('Reviewer')
  await ctx.fiber.dispose()
  await boot()
  await check('Reviewer')
})

it('numbers renamed seats per team and preserves native addresses and numbered role names', async () => {
  const { run, seats: [leader] } = await newTeam('Rename duplicate seats')
  const other = await newTeam('Same role in another team')
  const child = await service.addMember({ runId: run.runId, roleId })
  async function rename(name: string) {
    const expectedHash = (await service.readDocument({ roleId }))!.hash
    expect(await service.saveDocument({ roleId, expectedHash,
      text: serializeMarkdown({ id: roleId, name }, 'Review') })).toMatchObject({ ok: true })
  }
  await rename('复核员')
  const labels = async () => (await service.getTeam({ runId: run.runId })).seats.map(s => [s.seatId, s.displayName])
  expect(await labels()).toEqual([[leader.seatId, '复核员'], [child.seatId, '复核员 2']])
  expect((await service.getTeam({ runId: other.run.runId })).seats[0].displayName).toBe('复核员')
  const numbered = await service.createRole({ name: '编辑 2' })
  if (!numbered.ok) throw new Error('Fixture role was not created')
  const editor = await service.addMember({ runId: run.runId, roleId: numbered.status.roleId })
  await rename('编辑')
  expect(await labels()).toEqual([[leader.seatId, '编辑'], [child.seatId, '编辑 3'], [editor.seatId, '编辑 2']])
  expect(await service.teamMentionRoster({ sessionId: run.rootSessionId })).toMatchObject({
    members: [{ name: '编辑', address: 'lead' }, { name: '编辑 3', seatId: child.seatId, address: child.nativeAgentName },
      { name: '编辑 2', address: editor.nativeAgentName }],
  })
  expect(await service.teamMessageSender({ sessionId: run.rootSessionId, senderId: child.currentSessionId }))
    .toMatchObject({ name: '编辑 3' })
  const longName = '编'.repeat(160)
  await rename(longName)
  const sender = await service.teamMessageSender({ sessionId: run.rootSessionId, senderId: child.currentSessionId })
  expect(runtimeMethods.teamMessageSender[1].parse(sender)?.name).toBe(longName + ' 2')
})

it('resolves team message senders across seat generations and scopes aliases to the receiving team', async () => {
  const { run } = await newTeam('message roster')
  const programmer = 'fixture-programmer'
  await service.saveDocument({ roleId: programmer, expectedHash: null,
    text: serializeMarkdown({ id: programmer, name: '程序员' }, '开发') })
  const member = await service.addMember({ runId: run.runId, roleId: programmer, displayName: 'dev' })
  const who = (sender: { senderId?: string; senderName?: string }) =>
    service.teamMessageSender({ sessionId: run.rootSessionId, ...sender })
  expect(await who({ senderId: member.currentSessionId })).toEqual({ name: '程序员', fromParent: false })
  expect(await who({ senderName: member.nativeAgentName })).toEqual({ name: '程序员', fromParent: false })
  await service.resetSeat({ seatId: member.seatId, generation: 1, handoff: '' })
  expect(await who({ senderId: member.currentSessionId })).toEqual({ name: '程序员', fromParent: false })
  const other = await newTeam('separate roster')
  expect(await who({ senderId: other.run.rootSessionId })).toEqual({ name: null, fromParent: false })
  expect(await service.teamMessageSender({ sessionId: 'ordinary' })).toBeNull()
})

it('keeps a resumed intermediate parent live until its child is admitted', async () => {
  const { run } = await newTeam('Nested seats')
  const parent = await service.addMember({ runId: run.runId, roleId })
  const parentId = parent.currentSessionId as SessionId
  await vi.waitFor(() => expect(ctx.agents.get(parentId)).toBeUndefined())
  const stopping = Promise.withResolvers<void>()
  const detach = ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent.id === parentId) stopping.resolve()
  })
  const provider = ctx.subagents.getProvider('spawn')!
  const prepare = provider.prepareContinuable!.bind(provider)
  const spy = vi.spyOn(provider, 'prepareContinuable').mockImplementation(async (request) => {
    await stopping.promise
    return prepare(request)
  })
  try {
    const child = await service.addMember({ runId: run.runId, roleId, parentSeatId: parent.seatId })
    expect(child.parentSeatId).toBe(parent.seatId)
    await vi.waitFor(() => expect(ctx.agents.get(parentId)).toBeUndefined())
  } finally {
    stopping.resolve()
    spy.mockRestore()
    detach()
  }
})

it('routes team mentions by stable seat through the current native tree and isolates rosters', async () => {
  const { run, seats: [lead] } = await newTeam('Mention routing')
  const other = await newTeam('Other team')
  const child = await service.addMember({ runId: run.runId, roleId, displayName: 'dev' })
  const leaf = await service.addMember({ runId: run.runId, roleId, displayName: 'qa', parentSeatId: child.seatId })
  for (const ancestor of [run.rootSessionId, child.currentSessionId])
    expect(await service.teamMessageSender({ sessionId:leaf.currentSessionId,senderId:ancestor })).toMatchObject({fromParent:true})
  expect(await service.teamMessageSender({ sessionId:child.currentSessionId,senderId:leaf.currentSessionId })).toMatchObject({fromParent:false})
  const roster = await service.teamMentionRoster({ sessionId: leaf.currentSessionId })
  expect(roster?.members.map(m => [m.seatId, m.address, m.leader])).toEqual(expect.arrayContaining([
    [lead.seatId, 'lead', true], [child.seatId, 'dev', false], [leaf.seatId, 'dev/qa', false],
  ]))
  expect(await service.teamMentionRoster({ sessionId: 'ordinary' })).toBeNull()
  expect((await service.teamMentionRoster({ sessionId: other.run.rootSessionId }))?.members).toHaveLength(1)
  const reference = `@[Reviewer](role-team:${run.runId}/${leaf.seatId})`
  await prompt(run.rootSessionId, reference)
  expect(JSON.stringify(request(run.rootSessionId))).toContain(reference)
  expect(JSON.stringify(request(run.rootSessionId).messages.filter(m => m.role === "system"))).toContain(leaf.seatId)
  // Native background members unload after a turn. Reply while the delivery has them awake.
  model.pause = async (req) => {
    if (req.sessionId !== leaf.currentSessionId || !JSON.stringify(req.messages).includes('Review the temporary brief')) return
    model.pause = undefined
    const reply = await tool(leaf.currentSessionId, 'send_message', { agent: 'lead', message: 'Temporary brief reviewed' })
    expect(reply.isError).not.toBe(true)
  }
  const sent = await tool(run.rootSessionId, 'send_message', { agent: 'dev/qa', message: 'Review the temporary brief' })
  expect(sent.isError).not.toBe(true)
  await vi.waitFor(() => expect(JSON.stringify(request(run.rootSessionId).messages)).toContain('Temporary brief reviewed'))
  expect(JSON.stringify(request(leaf.currentSessionId).messages.filter(m => m.role === 'system'))).toContain('dev/qa')
  for (const id of [run.rootSessionId, leaf.currentSessionId]) {
    const system = JSON.stringify(request(id).messages.filter(m => m.role === 'system'))
    expect(system).toContain('todo_write')
    expect(system).toContain('release')
    expect(system).toMatch(/latest member reports|最新成员汇报/)
  }
  await service.archiveTeam({ runId: run.runId })
  expect(await service.teamMentionRoster({ sessionId: leaf.currentSessionId })).toBeNull()
})

it('scopes native schedules, delivers to the lead, synchronizes edits and stops active tasks on archive', async () => {
  await ctx.plugin(Schedule)
  await ctx.plugin(ScheduleTools)
  const a = (await newTeam('Timers A')).run,
    b = (await newTeam('Timers B')).run
  const child = await service.addMember({ runId: a.runId, roleId })
  const make = (title: string, seconds: number) =>
    service.createTeamSchedule({
      runId: a.runId,
      title,
      prompt: title,
      timing: { kind: 'after', after_seconds: seconds },
    })
  const timer = await make('Scheduled briefing', 3600)
  expect(service.index.schedules.get(timer.id)?.runId).toBe(a.runId)
  expect((await ctx.schedule.catalog())[0].target).toEqual({
    kind: 'session',
    sessionId: a.rootSessionId,
  })
  expect(await service.teamSchedules({ runId: b.runId })).toEqual([])
  expect(await service.teamArchiveImpact({ runId: a.runId })).toBe(1)
  for (const action of ['pause', 'delete', 'run'] as const)
    await expect(
      service.changeTeamSchedule({
        runId: b.runId,
        id: timer.id,
        expectedUpdatedAt: timer.updatedAt,
        action,
      }),
    ).rejects.toThrow('not found')
  await expect(service.teamScheduleHistory({ runId: b.runId, id: timer.id })).rejects.toThrow(
    'not found',
  )
  await expect(
    service.archiveTeam({ runId: a.runId, expectedActiveSchedules: 0 }),
  ).rejects.toThrow()
  await service.changeTeamSchedule({
    runId: a.runId,
    id: timer.id,
    expectedUpdatedAt: timer.updatedAt,
    action: 'pause',
  })
  expect(await service.teamArchiveImpact({ runId: a.runId })).toBe(0)
  await expect(
    service.changeTeamSchedule({
      runId: a.runId,
      id: timer.id,
      expectedUpdatedAt: timer.updatedAt,
      action: 'delete',
    }),
  ).rejects.toThrow('schedule_conflict')
  const [native] = await ctx.schedule.catalog()
  await ctx.schedule.edit({
    id: native.id,
    action: 'update',
    patch: { title: 'Updated natively', active: true },
  })
  const [current] = await service.teamSchedules({ runId: a.runId })
  expect(current).toMatchObject({ title: 'Updated natively', status: 'active' })
  await service.changeTeamSchedule({
    runId: a.runId,
    id: timer.id,
    expectedUpdatedAt: current.updatedAt,
    action: 'run',
  })
  await vi.waitFor(async () =>
    expect(
      (await service.teamScheduleHistory({ runId: a.runId, id: timer.id })).records,
    ).toHaveLength(1),
  )
  const alarm = await make('Scheduled handoff fixture', 1)
  let sent = false
  model.pause = async (req) => {
    if (
      req.sessionId !== a.rootSessionId ||
      sent ||
      !JSON.stringify(req.messages).includes('Scheduled handoff fixture')
    )
      return
    sent = true
    await tool(a.rootSessionId, 'send_message', {
      agent: child.nativeAgentName,
      message: 'Check the scheduled handoff',
    })
  }
  await vi.waitFor(
    () =>
      expect(JSON.stringify(request(child.currentSessionId).messages)).toContain(
        'Check the scheduled handoff',
      ),
    { timeout: 6000 },
  )
  expect(
    request(child.currentSessionId).tools?.some((t) => /^(team_)?schedule_/.test(t.name)),
  ).toBe(false)
  await vi.waitFor(
    async () =>
      expect(
        (await service.teamScheduleHistory({ runId: a.runId, id: alarm.id })).records[0]?.prompt,
      ).toBe('Scheduled handoff fixture'),
    { timeout: 6000 },
  )
  for (const task of await service.teamSchedules({ runId: a.runId }))
    await service.changeTeamSchedule({
      runId: a.runId,
      id: task.id,
      expectedUpdatedAt: task.updatedAt,
      action: 'delete',
    })
  const bTimer = await service.createTeamSchedule({
    runId: b.runId,
    title: 'B private',
    prompt: 'Secret B',
    timing: { kind: 'daily', daily: { time: '09:00', time_zone: 'UTC' } },
  })
  // A globally retargeted task carries its previous team's prompt and receipts.
  const moved = await ctx.schedule.create({
    title: 'Retargeted',
    prompt: 'private',
    timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'session', sessionId: b.rootSessionId as SessionId },
  })
  await ctx.schedule.edit({
    id: moved.id,
    action: 'update',
    patch: { target: { kind: 'session', sessionId: a.rootSessionId as SessionId } },
  })
  expect((await service.teamSchedules({ runId: a.runId })).map((t) => t.id)).not.toContain(moved.id)
  await expect(service.teamScheduleHistory({ runId: a.runId, id: moved.id })).rejects.toThrow(
    'not found',
  )
  await ctx.schedule.edit({ id: moved.id, action: 'delete' })
  await make('Stop on archive', 600)
  await service.archiveTeam({ runId: a.runId, expectedActiveSchedules: 1 })
  expect(await service.teamArchiveImpact({ runId: a.runId })).toBe(0)
  expect((await service.teamSchedules({ runId: b.runId }))[0].id).toBe(bTimer.id)
})

it('limits native PTC schedule access to the calling team and its confirmed lead workflow', async () => {
  await ctx.plugin(Schedule)
  await ctx.plugin(ScheduleTools)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(SandboxLocal)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  await ctx.plugin(NodePtcRuntime, { executionMode: 'per-call' })
  await ctx.plugin(AgentPreset, {
    id: 'ptc',
    plugins: [{ id: 'ptc-executor', name: '@deepseek-ai/dsh-tool-executor-ptc' }],
  })
  const { run: a } = await newTeam('PTC A')
  await ctx.agentPresets.select(ctx.agents.get(a.rootSessionId as SessionId)!, 'ptc')
  const { run: b } = await newTeam('PTC B')
  const foreign = await service.createTeamSchedule({
    runId: b.runId,
    title: 'Foreign timer',
    prompt: 'foreign text',
    timing: { kind: 'after', after_seconds: 600 },
  })
  const events: SessionEvent[] = []
  ctx.on('session/event', (s, e) => {
    if (s.id === a.rootSessionId) events.push(e)
  })
  const lead = ctx.agents.get(a.rootSessionId as SessionId)!
  const pluginTools = lead.ctx.tools.definitions(lead).filter(t => ['read_team_brief','update_team_brief'].includes(t.name) || t.name.startsWith('team_schedule_'))
  expect(pluginTools).toHaveLength(5)
  for (const def of pluginTools) {
    const schema = def.parameters as { type:string; properties:Record<string,{type:string}> }
    expect(schema.type).toBe('object')
    expect(Reflect.ownKeys(schema)).not.toContain('~standard')
    expect(JSON.stringify(schema)).not.toMatch(/"(?:anyOf|oneOf|nullable|~standard)"/)
    for (const field of Object.values(schema.properties)) expect(['string','number','boolean','array']).toContain(field.type)
  }
  model.program = 'await tools.read_team_brief({}); await tools.update_team_brief({text:"PTC plan"}); ' +
    'await tools.team_schedule_create({title:"Confirmed",prompt:"Inspect fixture",kind:"after",after_seconds:600})'
  await prompt(a.rootSessionId, '确认，十分钟后检查测试数据。')
  expect((await service.teamSchedules({ runId: a.runId })).map((t) => t.title)).toEqual([
    'Confirmed',
  ])
  expect((await service.getTeamBrief({runId:a.runId}))?.text).toBe('PTC plan')
  expect(JSON.stringify(request(a.rootSessionId).messages.filter(m=>m.role==='system'))).toContain('团队简报')
  const foreignDelete = { id: foreign.id, action: 'delete', expectedUpdatedAt: foreign.updatedAt ?? undefined }
  model.program = `await tools.team_schedule_change(${JSON.stringify(foreignDelete)})`
  await prompt(a.rootSessionId, 'Try a foreign id')
  expect(
    events.filter((e) => e.type === 'tool/ptc-dispatch').map((e) => [e.data.name, e.data.isError]),
  ).toEqual([
    ['read_team_brief', false],
    ['update_team_brief', false],
    ['team_schedule_create', false],
    ['team_schedule_change', true],
  ])
  expect((await tool(a.rootSessionId, 'schedule_list', {})).isError).toBe(true)
  expect((await service.teamSchedules({ runId: b.runId }))[0].id).toBe(foreign.id)
})

it('allows a native temporary child under an active seat while retaining team isolation', async () => {
  const { run } = await newTeam('Temporary children')
  const member = await service.addMember({ runId: run.runId, roleId })
  const root = ctx.agents.get(run.rootSessionId as SessionId)!
  await ctx.subagents.waitForTreeWork(root)
  const hold = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  model.pause = async req => {
    if (req.sessionId === member.currentSessionId) {
      started.resolve()
      await hold.promise
    }
  }
  const id = crypto.randomUUID() as SessionId
  try {
    await service.promptSeat({ seatId: member.seatId, generation: 1, delivery: 'queue',
      requestId: crypto.randomUUID(), text: 'Oversee research' })
    await started.promise
    const parent = ctx.agents.get(member.currentSessionId as SessionId)!
    const child = await ctx.subagents.startActivation({ parent, childId: id, name: 'researcher', label: 'Research',
      provider: 'spawn', delivery: 'parent', maxDepth: 8, prompt: [{ type: 'text', text: 'Report the result' }],
      signal: new AbortController().signal })
    await child.result
    expect(await ctx.subagents.listDescendants(root.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, parentId: parent.id, kind: 'child' }),
    ]))
    const team = await service.getTeam({runId:run.runId})
    expect(team.formalSessionIds).toContain(member.currentSessionId)
    expect(team.formalSessionIds).not.toContain(id)
    expect(request(id).tools?.some(t => t.name === 'session_search' || t.name === 'team_schedule_create')).toBe(false)
  } finally {
    hold.resolve()
    await ctx.subagents.waitForTreeWork(root)
  }
})

it('stores isolated team briefs atomically and enforces CAS, file boundaries and archival', async () => {
  const { run } = await newTeam('Brief storage')
  const runId = run.runId
  expect((await service.getTeam({ runId })).capabilities).toEqual({ schedules: false })
  const save = (text: string, expectedHash: string | null) => service.saveTeamBrief({ runId, text, expectedHash })
  expect(await service.getTeamBrief({ runId })).toBeNull()
  const path = join(folder, 'teams', runId, 'brief.md')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  const results = await Promise.all([save('first', null), save('second', null)])
  const current = (await service.getTeamBrief({ runId }))!
  expect(results).toContainEqual({ ok: false, code: 'conflict', current })
  const { createHash } = await import('node:crypto')
  expect(current.hash).toBe(createHash('sha256').update(await readFile(path)).digest('hex'))
  const { TeamBriefs } = await import('../src/host/team-runtime/briefs.js')
  const store = new TeamBriefs({ roles: { root: join(folder, 'roles') } } as never)
  for (const invalid of ['../roles', 'a/b', '', 'a'.repeat(129)]) await expect(store.read(invalid)).rejects.toThrow(/identifier/)
  for (const target of [folder, join(folder, 'teams'), dirname(path)]) {
    await expect(service.createTeam({ roleId, title: 'bad', workspaceCwd: target })).rejects.toThrow(/separate/)
  }
  const member = await service.addMember({ runId, roleId })
  // Use registered tools so a failure cannot be mistaken for "unknown tool".
  for (const name of ['glob', 'grep', 'apply_patch']) {
    if (ctx.agents.get(member.currentSessionId as SessionId)!.ctx.tools.definitions(ctx.agents.get(member.currentSessionId as SessionId)!).some(t => t.name === name)) continue
    ctx.tools.register({ name, description: name, parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'unexpected' })
  }
  for (const [name, args] of [
    ['read', { file_path: path }], ['write', { file_path: path, content: 'bad' }],
    ['edit', { file_path: path, old_string: current.text, new_string: 'bad' }],
    ['apply_patch', { input: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` }],
    ['glob', { path: dirname(path), pattern: '*' }], ['grep', { path: path, pattern: 'first' }],
  ] as const) {
    const result = await tool(member.currentSessionId, name, args)
    expect(result.isError, name).toBe(true)
    expect(JSON.stringify(result.content), name).toMatch(/受保护|private role/)
  }
  expect(await service.getTeamBrief({ runId })).toEqual(current)
  expect(await save('   ', current.hash)).toEqual({ ok: true, brief: null })
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(save('x'.repeat(4001), null)).rejects.toThrow(/4000/)
  await save('x'.repeat(4000), null)
  await service.archiveTeam({ runId })
  const retained = (await service.getTeamBrief({ runId }))!
  await expect(save('denied', retained.hash)).rejects.toThrow(/not active/)
  await service.deleteTeam({ runId })
  await expect(readdir(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await service.readDocument({ roleId })).not.toBeNull()
})

it('places actual brief revisions in the benchmark prefix only', async () => {
  const { installPrefixBrief } = await import('../benchmarks/drivers/prefix-brief.ts')
  let runId = ''
  installPrefixBrief(ctx, () => runId)
  const {run} = await newTeam('prefix control')
  runId = run.runId
  let hash: string | null = null
  const suffixes: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === run.rootSessionId && event.type === 'user/message' && event.data.source.kind === 'team-brief')
      suffixes.push(event)
  })
  for (const text of ['prefix revision one','prefix revision two']) {
    const saved = await service.saveTeamBrief({runId, text, expectedHash:hash})
    if (!saved.ok || !saved.brief) throw new Error('fixture brief save failed')
    hash = saved.brief.hash
    await prompt(run.rootSessionId, 'Continue.')
    const messages = request(run.rootSessionId).messages
    expect(JSON.stringify(messages.filter(m => m.role === 'system').at(-1))).toContain(text)
    expect(suffixes).toHaveLength(0)
  }
})

it('synchronizes one brief suffix per generation, restores after compaction, and persists across restart', async () => {
  const { run } = await newTeam('Brief sync')
  const runId = run.runId, id = run.rootSessionId
  const events: SessionEvent[] = []
  const observe = () => ctx.on('session/event', (s, e) => { if (s.id === id) events.push(e) })
  const notices = () => events.filter(e => e.type === 'user/message' && e.data.source.kind === 'team-brief')
  observe()
  await prompt(id, 'baseline')
  const system = request(id).messages.filter(m => m.role === 'system').map(m => m.content)
  expect(JSON.stringify(system)).toContain('团队简报')
  await service.saveTeamBrief({ runId, text: 'unique-brief-one', expectedHash: null })
  await prompt(id, 'first'); await prompt(id, 'second')
  expect(notices()).toHaveLength(1)
  expect(request(id).messages.filter(m => m.role === 'system').map(m => m.content)).toEqual(system)
  expect((await tool(id, 'update_team_brief', { text: 'x'.repeat(1501) })).content).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: expect.stringMatching(/1500.*1501.*file paths/) }),
  ]))
  expect((await tool(id, 'update_team_brief', { text: 'unique-brief-two' })).isError).toBeFalsy()
  await prompt(id, 'no echo')
  expect(notices()).toHaveLength(1)
  const session = ctx.agents.get(id as SessionId)!.session
  const seq = notices()[0].seq
  const compactionId = crypto.randomUUID() as import('@deepseek-ai/dsh-compaction/types').CompactionId
  session.append('compaction/start', { compactionId, turn: null })
  session.append('compaction/summary', { compactionId, summary:[{ type:'text', text:'summary' }],
    shadowedRange:{ start:seq, end:seq }, shadowedSeqs:[seq], shadowedTokenCount:1, provider:'fixture', model:'fixture' })
  session.append('compaction/end', { compactionId, turn: null })
  const leaderGeneration = () => service.index.generations.list().find(g => g.sessionId === id)
  await vi.waitFor(() => expect(leaderGeneration()?.seenBriefHash).toBeNull())
  await prompt(id, 'after compaction'); await prompt(id, 'and again')
  expect(notices()).toHaveLength(2)
  expect(JSON.stringify(notices()[1])).toContain('unique-brief-two')
  const member = await service.addMember({ runId, roleId })
  await ctx.subagents.waitForTreeWork(ctx.agents.get(id as SessionId)!)
  const childRequest = request(member.currentSessionId)
  expect(JSON.stringify(childRequest.messages)).toContain('unique-brief-two')
  expect(childRequest.tools?.map(t => t.name)).toContain('read_team_brief')
  expect(childRequest.tools?.map(t => t.name)).not.toContain('update_team_brief')
  let denied = false
  model.pause = async req => {
    if (req.sessionId === member.currentSessionId)
      denied = Boolean((await tool(member.currentSessionId, 'update_team_brief', { text:'forbidden' })).isError)
  }
  await service.promptSeat({ seatId:member.seatId, generation:1, requestId:crypto.randomUUID(), delivery:'queue',text:'test member scope' })
  await ctx.subagents.waitForTreeWork(ctx.agents.get(id as SessionId)!)
  model.pause = undefined
  expect(denied).toBe(true)
  expect((await service.getTeamBrief({ runId }))?.text).toBe('unique-brief-two')
  const next = await service.resetSeat({ seatId:member.seatId, generation:1, handoff:'' })
  await ctx.subagents.waitForTreeWork(ctx.agents.get(id as SessionId)!)
  expect(JSON.stringify(model.requests.find(r => r.sessionId === next.currentSessionId)?.messages)).toContain('unique-brief-two')
  await ctx.subagents.waitForTreeWork(ctx.agents.get(id as SessionId)!)
  await ctx.fiber.dispose(); await boot(); observe()
  await prompt(id, 'after restart')
  expect(notices()).toHaveLength(2)
  const previous = (await service.getTeamBrief({ runId }))!
  await service.saveTeamBrief({ runId, expectedHash:previous.hash, text:'third version' })
  await prompt(id, 'new version'); await prompt(id, 'same')
  expect(notices()).toHaveLength(3)
})

it('uses the effective prompt on first entry and after recomposing a managed agent', async () => {
  for (const id of ['standard', 'minimal', 'custom']) await ctx.plugin(AgentPreset, { id, plugins: [] })
  const ordinary = await newTeam('Standard first entry')
  const first = ctx.agents.get(ordinary.run.rootSessionId as SessionId)!
  await ctx.agentPresets.select(first, 'standard')
  await prompt(first.id, 'first standard request')
  const standard = request(first.id).messages
  expect(JSON.stringify(standard.filter(m => m.role === 'system'))).toContain('rule-one')
  expect(JSON.stringify(standard.filter(m => m.role === 'user'))).not.toContain('rule-one')
  const { run } = await newTeam('Custom first entry')
  const id = run.rootSessionId, agent = ctx.agents.get(id as SessionId)!
  await ctx.agentPresets.select(agent, 'custom')
  const complete = agent.ctx.systemPrompt.section({ name:'fixture-complete', order:0, complete:true, text:'custom static prefix' })
  await prompt(id, 'custom first')
  const surface = request(id).messages
  expect(JSON.stringify(surface.filter(m => m.role === 'system'))).not.toContain('rule-one')
  expect(JSON.stringify(surface.filter(m => m.role === 'user'))).toMatch(/rule-one[\s\S]*read_team_brief/)
  complete()
  await ctx.agentPresets.recompose(agent.ctx, 'standard')
  agent.session.append('agent-preset/selected', { agentPreset:'standard' })
  await prompt(id, 'back to standard')
  expect(JSON.stringify(request(id).messages.filter(m => m.role === 'system'))).toContain('rule-one')
  expect(request(id).tools?.map(t => t.name)).not.toContain('session_search')
  const min = await newTeam('Minimal first entry')
  const minimal = ctx.agents.get(min.run.rootSessionId as SessionId)!
  await ctx.agentPresets.select(minimal, 'minimal')
  minimal.ctx.systemPrompt.section({ name:'minimal-body', order:0, complete:true, text:'minimal' })
  await prompt(min.run.rootSessionId, 'minimal first')
  expect(JSON.stringify(request(min.run.rootSessionId).messages.filter(m => m.role === 'user'))).toContain('read_team_brief')
})

it('rechecks the brief revision after a different host releases its filesystem lock', async () => {
  const { run: { runId } } = await newTeam('Shared directory')
  const seed = await service.saveTeamBrief({ runId, text:'initial', expectedHash:null })
  if (!seed.ok || !seed.brief) throw Error('No seed brief')
  const dir = join(folder, 'teams', runId)
  // A separate Node process follows the same on-disk writer contract as a second profile.
  const writer = spawn(process.execPath, ['--input-type=module','-e', `
    import lockfile from 'proper-lockfile'
    import { readFile, writeFile, rename } from 'node:fs/promises'
    import { join } from 'node:path'
    const dir = process.argv[1], path = join(dir, 'brief.md')
    const release = await lockfile.lock(dir)
    try {
      const next = (await readFile(path, 'utf8')).replace(/initial$/, 'other profile')
      process.send('locked')
      await new Promise(resolve => process.once('message', resolve))
      await writeFile(path + '.stage', next)
      await rename(path + '.stage', path)
    } finally { await release(); process.disconnect() }
  `, dir], { stdio:['ignore','ignore','inherit','ipc'] })
  const exit = once(writer, 'exit')
  try {
    await Promise.race([once(writer,'message'), exit.then(() => { throw Error('Writer exited before locking') })])
    const pending = service.saveTeamBrief({ runId, expectedHash:seed.brief.hash, text:'stale' })
    const early = await Promise.race([pending.then(() => 'committed'), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))])
    writer.send('commit')
    expect(early).toBe('waiting')
    expect(await pending).toMatchObject({ ok:false,code:'conflict',current:{text:'other profile'} })
    expect(await exit).toEqual([0,null])
    expect(await readdir(dirname(dir))).toEqual([runId])
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill()
    await exit
  }
})

it('delivers changed leader policies as committed suffixes only to team seats with collaborators', async () => {
  const { run } = await newTeam('Policy sync')
  const { runId, rootSessionId: id } = run
  const root = ctx.agents.get(id as SessionId)!
  const finish = async () => {
    await ctx.subagents.waitForTreeWork(root)
    await root.whenIdle() // Child settlement can wake the parent for one last turn.
  }
  const events: { id: string; mode: string; seq: SessionEvent['seq']; text: string }[] = []
  const observe = () => ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source.kind === 'team-policy')
      events.push({ id: session.id, seq: event.seq, mode: event.data.source.mode, text: JSON.stringify(event.data.content) })
  })
  const from = (sessionId: string) => events.filter(e => e.id === sessionId)
  observe()
  await prompt(id, 'solo')
  expect(events).toEqual([])
  expect(run.leaderPolicy).toBeUndefined()
  const deputy = await service.addMember({ runId, roleId, displayName: 'Deputy' })
  await finish()
  expect(from(deputy.currentSessionId)).toEqual([])
  const leaf = await service.addMember({ runId, roleId, displayName: 'Leaf', parentSeatId: deputy.seatId })
  await finish()
  const delegate = async () => {
    await service.promptSeat({ seatId: deputy.seatId, generation: 1, delivery: 'queue', text: 'review', requestId: crypto.randomUUID() })
    await finish()
  }
  await delegate()
  await prompt(id, 'baseline')
  expect(from(id).map(e => e.mode)).toEqual(['delegate'])
  expect(from(id)[0]?.text).toContain('必须先向用户一次性澄清对齐，获得确认后再派发给成员。需求明确后，动手前先核对')
  expect(from(deputy.currentSessionId).map(e => e.mode)).toEqual(['delegate'])
  expect(from(leaf.currentSessionId)).toEqual([])
  const system = () => Buffer.from(JSON.stringify(request(id).messages.filter(m => m.role === 'system')))
  const before = system()
  expect(before.toString()).not.toContain('动手前先核对')
  for (const customText of [undefined, '  ', 'x'.repeat(1201)]) {
    await expect(service.updateLeaderPolicy({ runId, policy: { mode: 'custom', customText } })).rejects.toThrow()
  }
  await service.updateLeaderPolicy({ runId, policy: { mode: 'balanced' } })
  await prompt(id, 'changed'); await prompt(id, 'unchanged')
  expect(from(id).map(e => e.mode)).toEqual(['delegate', 'balanced'])
  expect(system().equals(before)).toBe(true)
  const customText = 'unique-consultation-rule'
  const policy = { mode: 'custom' as const, customText }
  expect((await service.updateLeaderPolicy({ runId, policy })).leaderPolicy).toEqual(policy)
  await service.saveTeamBrief({ runId, text:'concurrent brief', expectedHash:null })
  await prompt(id, 'sync both')
  expect(JSON.stringify(request(id).messages)).toContain('concurrent brief')
  expect(from(id).at(-1)?.text).toContain(customText)
  expect(system().equals(before)).toBe(true)
  await delegate()
  expect(from(deputy.currentSessionId).map(e => e.mode)).toEqual(['delegate', 'custom'])
  expect(from(leaf.currentSessionId)).toEqual([])
  const seq = from(id).at(-1)!.seq
  const compactionId = crypto.randomUUID() as import('@deepseek-ai/dsh-compaction/types').CompactionId
  root.session.append('compaction/start', { compactionId, turn: null })
  root.session.append('compaction/summary', { compactionId, summary:[{ type:'text', text:'summary' }],
    shadowedRange:{ start:seq, end:seq }, shadowedSeqs:[seq], shadowedTokenCount:1, provider:'fixture', model:'fixture' })
  root.session.append('compaction/end', { compactionId, turn:null })
  await prompt(id, 'after compaction'); await prompt(id, 'again')
  expect(from(id).map(e => e.mode)).toEqual(['delegate', 'balanced', 'custom', 'custom'])
  await ctx.fiber.dispose(); await boot(); observe()
  await prompt(id, 'after restart')
  expect(from(id)).toHaveLength(4)
  await service.archiveTeam({ runId })
  await expect(service.updateLeaderPolicy({ runId, policy: { mode: 'balanced' } })).rejects.toThrow(/not active/)
})
