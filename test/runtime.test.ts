import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
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
import type { SessionId } from '@deepseek-ai/dsh-session'
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
  requests: GenerateOptions[] = []
  pause?: (request: GenerateOptions) => Promise<void>
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    await this.pause?.(request)
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
  await ctx.plugin(AgentPreset, { id: 'ordinary', plugins: [] })
  const patch = parse(await readFile(join(process.cwd(), 'cordis.patch.yml'), 'utf8'))
  await ctx.plugin(AgentPreset, patch[0].insert[1].config)
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
it('admits only published memory, same-run notes and team tools at the model boundary', async () => {
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
  await service.addNote({ runId: a.run.runId, content: 'alpha temporary' })
  await prompt(a.run.rootSessionId, 'ALPHA-9527')
  await prompt(b.run.rootSessionId, 'Beta question')
  expect(JSON.stringify(request(a.run.rootSessionId).messages)).toContain('alpha temporary')
  const beta = request(b.run.rootSessionId)
  expect(JSON.stringify(beta.messages)).toContain('published-habit')
  expect(JSON.stringify(beta.messages)).not.toMatch(/ALPHA-9527|alpha temporary|private-draft/)
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
  expect(childContent).not.toMatch(/ALPHA-9527|alpha temporary|private-draft/)
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
it('pins each team until the next confirmed turn and restores adopted snapshots after restart', async () => {
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
      expect((await service.getTeam({ runId: a.run.runId })).seats[0].pendingRoleRev).toBe(2),
    )
    await service.versionDecision({ seatId: a.run.leaderSeatId, revision: 2, decision: 'next-turn' })
    await service.versionDecision({ seatId: b.run.leaderSeatId, revision: 2, decision: 'keep' })
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
  expect(c.seats[0].adoptedRoleRev).toBe(2)
  await ctx.fiber.dispose()
  await boot()
  await prompt(a.run.rootSessionId, 'next')
  await prompt(b.run.rootSessionId, 'next')
  expect(JSON.stringify(request(a.run.rootSessionId).messages[0])).toContain('rule-two')
  expect(JSON.stringify(request(b.run.rootSessionId).messages)).not.toContain('rule-two')
  expect((await service.getTeam({ runId: a.run.runId })).seats[0].adoptedRoleRev).toBe(2)
})
it('keeps training proposals reviewable and routes temporary requirements only to the linked run', async () => {
  const a = await newTeam('A'),
    b = await newTeam('B')
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
  ).toEqual(['propose_role_memory', 'propose_role_update', 'record_temporary_note'])
  expect(
    await tool(id, 'propose_role_update', { name: 'Editor', body: 'confirmed-rule' }),
  ).toMatchObject({ isError: false })
  expect(
    await tool(id, 'propose_role_memory', { title: 'Verify', body: 'confirmed-habit' }),
  ).toMatchObject({ isError: false })
  expect(await tool(id, 'record_temporary_note', { content: 'alpha task only' })).toMatchObject({
    isError: false,
  })
  const proposals = (await service.getTraining({ trainingId: training.trainingId })).proposals!
  expect(proposals[0].diff).toContain('+confirmed-rule')
  expect((await service.readDocument({ roleId }))?.text).not.toContain('confirmed-rule')
  expect((await service.readDocument({ roleId, memoryId: proposals[1].memoryId }))?.text).toContain(
    'status: draft',
  )
  for (const p of proposals)
    expect(
      await service.confirmProposal({ trainingId: training.trainingId, proposalId: p.id }),
    ).toMatchObject({ ok: true })
  await tool(id, 'propose_role_memory', { title: 'Rejected', body: 'unapproved-habit' })
  const last = (await service.getTraining({ trainingId: training.trainingId })).proposals!.at(-1)!
  const review = { trainingId: training.trainingId, proposalId: last.id }
  await service.rejectProposal(review)
  await expect(service.confirmProposal(review)).rejects.toThrow(/unavailable/)
  expect((await service.readDocument({ roleId, memoryId: last.memoryId }))?.text).toContain(
    'status: draft',
  )
  const fresh = await newTeam('C')
  await prompt(fresh.run.rootSessionId, 'test')
  const content = JSON.stringify(request(fresh.run.rootSessionId).messages)
  expect(content).toContain('confirmed-rule')
  expect(content).toContain('confirmed-habit')
  expect(content).not.toMatch(/private raw coaching|alpha task only|unapproved-habit/)
  expect(await service.listNotes({ runId: b.run.runId })).toEqual([])
  expect(await service.listNotes({ runId: a.run.runId })).toMatchObject([{ content: 'alpha task only' }])
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

it('creates a role and its first memory only after their separate confirmations', async () => {
  const newId = 'apprentice'
  const { sessionId, trainingId } = await service.createTraining({
    roleId: newId,
    mode: 'create',
    workspaceCwd: cwd,
  })
  await tool(sessionId, 'propose_role_update', { name: 'Apprentice', body: 'Observe carefully.' })
  await tool(sessionId, 'propose_role_memory', { title: 'Check', body: 'Ask for evidence.' })
  expect(await service.readDocument({ roleId: newId })).toBe(null)
  const [role, memory] = (await service.getTraining({ trainingId })).proposals!
  expect(memory.before).toContain('status: draft')
  await expect(service.confirmProposal({ trainingId, proposalId: memory.id })).rejects.toThrow(
    'Confirm the role',
  )
  expect(await service.confirmProposal({ trainingId, proposalId: role.id })).toMatchObject({ ok: true })
  expect((await service.readDocument({ roleId: newId, memoryId: memory.memoryId }))?.text).toContain(
    'status: draft',
  )
  expect(await service.confirmProposal({ trainingId, proposalId: memory.id })).toMatchObject({
    ok: true,
  })
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
  await service.addNote({ runId: a.run.runId, content: 'discard-this-note' })
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
  expect(JSON.stringify(request(updated.currentSessionId).messages)).not.toMatch(
    /discard-this-note|old-task-noise/,
  )
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
