import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Port, Event } from '../v2/driver.ts'
import { writable } from '../v2/protocol.ts'
import { installPrefixBrief } from './prefix-brief.ts'
import type {} from '../../src/host/index.ts'

// An event may precede addMember/resetSeat returning the authoritative session ID.
export class SeatActors {
  private readonly seats = new Map<string, string>()
  bind(session: string, role: string) {
    const old = this.seats.get(session)
    if (old && old !== role) throw Error('Conflicting seat for one session')
    this.seats.set(session, role)
  }
  actor(session: string) {
    return this.seats.get(session) ?? 'session:' + session
  }
  resolve(key: string) {
    return key.startsWith('session:') ? (this.seats.get(key.slice(8)) ?? 'auxiliary') : key
  }
}
// Mount only inside the dedicated withLocalHost worker. The outer driver owns
// boot, denial of ambient tools/paths, the isolated identity and final disposal.
export function hostPort(ctx: Context, roleStore: string, route: { provider: string; model: string }): Port {
  let options: Parameters<Port['start']>[0],
    runId = '',
    lead: Agent,
    last = '',
    failure: Error | undefined
  const agents = new Map<string, Agent>(),
    roles = new SeatActors()
  const pending = new Map<string, string>()
  const scratchpadCalls = new Map<string, string>()
  const deny = (code: string, reason: string) => ({ reason, info: { name: 'BenchmarkPolicy', code } })
  const abort = () => {
    for (const agent of agents.values()) agent.cancel({ kind: 'hook', reason: 'benchmark trial stopped' })
  }
  let fault: PromiseWithResolvers<never>
  const send = (event: Event) => {
    try {
      options.emit(event)
    } catch (error) {
      if (!options.signal.aborted) throw error
    }
  }
  const resolveAgent = async (id: string) => {
    const result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result) throw Error('Cannot resolve isolated benchmark agent')
    return result.agent
  }
  async function create() {
    const { job, workspace } = options
    const team = job.arm !== 'single-agent'
    const root = team
      ? (
          await ctx.roleTeam.createTeam({
            workspaceCwd: workspace,
            title: job.scenario.title,
            roleId: 'lead',
            locale: 'en',
            agentPreset: 'standard',
          })
        ).run
      : {
          rootSessionId: (await ctx.sessionController.create({ cwd: workspace, agentPreset: 'standard' }))
            .sessionId,
          runId: '',
        }
    runId = root.runId
    lead = await resolveAgent(root.rootSessionId)
    roles.bind(lead.id, 'lead')
    ctx.permissionPresets.set(lead.session, 'danger-full-access')
    if (team)
      for (const r of job.scenario.roles.slice(1)) {
        const seat = await ctx.roleTeam.addMember({ runId, roleId: r.id })
        roles.bind(seat.currentSessionId, r.id)
      }
  }
  return {
    resolveActor: (key) => roles.resolve(key),
    async start(o) {
      options = o
      if (
        !process.send ||
        (await realpath(o.workspace)) !== o.workspace ||
        (await realpath(roleStore)) !== roleStore ||
        !basename(process.cwd()).startsWith('dsh-benchmark-') ||
        dirname(o.workspace) !== process.cwd() ||
        dirname(roleStore) !== process.cwd() ||
        process.env.DSH_HOME !== join(process.cwd(), 'dsh')
      )
        throw Error('Isolated host worker required')
      fault = Promise.withResolvers<never>()
      void fault.promise.catch(() => {})
      o.signal.addEventListener('abort', abort, { once: true })
      if (o.job.arm === 'v0.2.0-prefix-brief') installPrefixBrief(ctx, () => runId)
      ctx.on(
        'system-prompt/assemble',
        async (_a, _c, next) => {
          const base = await next()
          return {
            ...base,
            sections: [
              { name: 'benchmark-static-head', text: o.header, interpolate: false },
              ...base.sections,
            ],
          }
        },
        { prepend: true },
      )
      if (o.job.arm === 'v0.2.0-brief-only')
        ctx.on(
          'agent/pre-step',
          async (_p, next) => {
            const d = await next()
            return d.kind === 'enter'
              ? { ...d, messages: d.messages.filter((m) => m.source.kind !== 'team-policy') }
              : d
          },
          { prepend: true },
        )
      ctx.on('agent/created', ({ agent }) => {
        agents.set(agent.id, agent)
        agent.model.select({ ...route, reasoningEffort: ReasoningEffortId('high') })
        return undefined
      })
      ctx.on(
        'llm/stream',
        async function* (req, next) {
          if (req.provider !== route.provider) {
            yield* next()
            return
          }
          o.signal.throwIfAborted()
          for await (const chunk of next()) {
            if (chunk.type === 'usage') {
              const u = chunk.usage
              send({
                actor: req.sessionId ? 'session:' + req.sessionId : 'auxiliary',
                type: 'provider/usage',
                metered: true,
                usage: {
                  inputTokens: u.inputTokens,
                  cacheReadTokens: u.cacheReadTokens ?? 0,
                  cacheWriteTokens: u.cacheWriteTokens ?? 0,
                  outputTokens: u.outputTokens,
                  ...(u.totalTokens !== undefined && { totalTokens: u.totalTokens }),
                  ...(u.reasoningTokens !== undefined && { reasoningTokens: u.reasoningTokens }),
                },
              })
              o.signal.throwIfAborted()
            }
            yield chunk
          }
        },
        { global: true, prepend: true },
      )
      ctx.tools.guard((exec) => {
        if (o.signal.aborted) return 'Trial budget exhausted'
        if (exec.name === 'update_team_brief' && ['C3', 'C4'].includes(o.job.scenario.id))
          return 'The sponsor controls the brief revisions in this ablation.'
        const teamTools = [
          'send_message',
          'list_agents',
          'team_task_create',
          'team_task_list',
          'team_task_update',
          'todo_write',
          'read_team_brief',
          'update_team_brief',
          'remember_experience',
        ]
        if (teamTools.includes(exec.name)) return
        if (!['read', 'edit', 'write'].includes(exec.name))
          return deny('TOOL', 'Benchmark policy denied ambient tool')
        const value = (exec.arguments as { file_path?: unknown })?.file_path
        if (
          typeof value !== 'string' ||
          dirname(resolve(o.workspace, value)) !== o.workspace ||
          value.split(/[\\/]/).includes('..')
        )
          return deny('PATH', 'Benchmark policy denied path')
        const stat = lstatSync(resolve(o.workspace, value), { throwIfNoEntry: false })
        if (stat && (!stat.isFile() || stat.nlink !== 1))
          return deny('LINK', 'Benchmark policy denied file link')
        if (['edit', 'write'].includes(exec.name)) {
          const file = (exec.arguments as { file_path?: string })?.file_path
          if (
            !file ||
            dirname(resolve(o.workspace, file)) !== o.workspace ||
            !writable(o.job.scenario, roles.actor(exec.agent?.id ?? ''), basename(file))
          ) {
            return deny('PROTECTED_WRITE', 'Benchmark policy denied write to a protected file')
          }
        }
      })
      ctx.on('session/event', (session, event) => {
        const native = (e: Event) => send({ ...e, nativeSeq: event.seq, nativeTime: event.time })
        const actor = roles.actor(session.id)
        const text = (c: readonly { type: string; text?: string }[]) =>
          c
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
          const f = event.data.reason.error
          failure = Error(
            'Model turn failed: ' +
              (/^[A-Z_0-9]+$/.test(f.code) ? f.code : 'UNKNOWN') +
              ('status' in f && typeof f.status === 'number' ? ' HTTP ' + f.status : ''),
          )
          fault.reject(failure)
        }
        if (event.type === 'request/header') {
          const cfg = event.data.header.config
          if (cfg.provider !== route.provider || cfg.model !== route.model)
            fault.reject(Error('Unexpected model route'))
          native({
            actor,
            type: event.type,
            route: cfg.provider + ':' + cfg.model,
            effort: cfg.reasoningEffort,
          })
        }
        if (event.type === 'system/message')
          native({ actor, type: event.type, text: text(event.data.message.content) })
        if (event.type === 'step/start' || event.type === 'compaction/summary')
          native({ actor, type: event.type })
        if (event.type === 'assistant/message') {
          const msg = text(event.data.message.content)
          if (actor === 'lead' && msg) last = msg
          native({ actor, type: event.type, text: msg, metered: true })
        }
        if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
          const d = event.data
          if (event.type === 'tool/call')
            pending.set(
              session.id + ':' + event.data.callId,
              createHash('sha256')
                .update(JSON.stringify([d.name, d.arguments]))
                .digest('hex'),
            )
          let args = d.arguments
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              /* Preserve malformed calls. */
            }
          }
          if (event.type === 'tool/call' && ['read', 'write', 'edit'].includes(d.name)) {
            const file = args && typeof args === 'object' && Reflect.get(args, 'file_path')
            if (typeof file === 'string' && resolve(o.workspace, file) === join(o.workspace, 'scratchpad.md')) {
              scratchpadCalls.set(session.id + ':' + event.data.callId, d.name)
            }
          }
          native({
            actor,
            type: event.type,
            tool: d.name,
            args,
            ...(args !== null &&
              typeof args === 'object' && {
                target: String(Reflect.get(args, 'agent') ?? ''),
                text: String(Reflect.get(args, 'message') ?? ''),
              }),
          })
        }
        if (event.type === 'tool/result') {
          const { message, error, turn, step } = event.data
          const id = session.id + ':' + message.toolCallId
          const signature = pending.get(id)
          pending.delete(id)
          const scratchpadTool = scratchpadCalls.get(id)
          if (scratchpadTool) {
            scratchpadCalls.delete(id)
            native({actor, type:'scratchpad/result', tool:scratchpadTool, target:message.toolCallId, text:message.isError?'error':'ok'})
          }
          const key =
            message.isError && signature
              ? createHash('sha256')
                  .update(signature + text(message.content))
                  .digest('hex')
              : undefined
          if (
            error?.name === 'BenchmarkPolicy' ||
            (message.isError && /denied|forbidden|权限|拒绝/i.test(text(message.content)))
          )
            native({
              actor,
              type: 'tool/denied',
              target: message.toolCallId,
              text: error?.code ?? 'HOST_DENIAL',
            })
          o.toolOutcome(session.id, key, turn, step)
        }
        if (event.type === 'team/task' && event.data.task)
          native({ actor, type: 'team/task', target: event.data.task.id, text: event.data.task.status })
        if (String(event.type) === 'llm/retry') {
          const delay = Reflect.get(event.data, 'delayMs')
          if (typeof delay === 'number') native({ actor, type: 'llm/retry', retryMs: delay })
        }
        if (event.type === 'user/message') {
          const source = event.data.source
          if (source.kind === 'team-policy' && o.job.arm === 'v0.2.0-brief-only')
            fault.reject(Error('Policy leaked into brief-only treatment'))
          if (source.kind === 'team-brief' && o.job.arm === 'v0.2.0-prefix-brief')
            fault.reject(Error('Suffix leaked into prefix treatment'))
          if (source.kind === 'team-brief' || source.kind === 'team-policy')
            native({ actor, type: source.kind, text: text(event.data.content) })
          if (
            actor === 'lead' &&
            ['team-message', 'agent-message', 'subagent-settled'].includes(source.kind)
          ) {
            const id = Reflect.get(source, 'senderSessionId') ?? Reflect.get(source, 'senderId')
            native({
              actor: typeof id === 'string' ? roles.actor(id) : 'member',
              type: 'team/report',
              text: text(event.data.content),
            })
          }
        }
      })
      if (o.job.arm !== 'single-agent') {
        for (const r of o.job.scenario.roles) {
          const dir = join(roleStore, r.id)
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'role.md'),
            '---\nid: ' +
              r.id +
              '\nname: ' +
              JSON.stringify(r.name) +
              '\nsummary: ' +
              JSON.stringify(r.duty) +
              '\n---\n' +
              [r.duty, r.privateContext].filter(Boolean).join('\n'),
            { flag: 'wx' },
          )
        }
        await ctx.roleTeam.rescan()
      }
      await create()
    },
    async ask(prompt) {
      last = ''
      lead.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }),
      )
      await Promise.race([
        fault.promise,
        (async () => {
          for (;;) {
            options.signal.throwIfAborted()
            await lead.whenIdle()
            const seq = lead.session.seq
            if (
              !(await ctx.subagents.waitForTreeWork(lead)) &&
              lead.status === 'idle' &&
              lead.session.seq === seq
            )
              break
          }
        })(),
      ])
      if (failure) throw failure
      return last
    },
    async compactReset(team) {
      const compact = await ctx.commands.execute(lead, '/compact', [], options.signal)
      if (!compact || compact.result.kind !== 'success' || compact.result.sourceEventSeq === undefined)
        throw Error('Native compaction not committed')
      if (team) {
        const role = options.job.scenario.roles[1].id
        const seat = (await ctx.roleTeam.getTeam({ runId })).seats.find((s) => s.roleId === role)!
        const next = await ctx.roleTeam.resetSeat({
          seatId: seat.seatId,
          generation: seat.currentGeneration,
          handoff: 'Resume from the durable team record.',
        })
        roles.bind(next.currentSessionId, role)
        send({ actor: role, type: 'seat/reset' })
      }
    },
    async fresh() {
      await create()
    },
    async reviseBrief(text) {
      const old = await ctx.roleTeam.getTeamBrief({ runId })
      const result = await ctx.roleTeam.saveTeamBrief({ runId, text, expectedHash: old?.hash ?? null })
      if (!result.ok) throw Error('Controlled brief revision failed')
    },
    async close() {
      options.signal.removeEventListener('abort', abort)
      abort()
    },
  }
}

// Injection point for a separately provisioned host. The offline CLI never
// initializes a provider, selects credentials or boots this worker.
export async function runIsolatedV2(
  ctx: Context,
  job: import('../v2/driver.ts').Job,
  paths: { workspace: string; roleStore: string },
  agent: { provider: string; model: string },
  sponsor: { provider: string; model: string },
  limits: import('../v2/protocol.ts').Limits,
) {
  if (agent.provider === sponsor.provider) throw Error('Independent sponsor route required')
  if (
    !process.send ||
    !basename(process.cwd()).startsWith('dsh-benchmark-') ||
    dirname(paths.workspace) !== process.cwd() ||
    dirname(paths.roleStore) !== process.cwd() ||
    ctx.profileContext.home !== join(process.cwd(), 'dsh') ||
    ctx.profileContext.cwd !== paths.workspace ||
    (await realpath(paths.workspace)) !== paths.workspace ||
    (await realpath(paths.roleStore)) !== paths.roleStore
  )
    throw Error('Require a disposable isolated v2 DSH profile')
  const { runProtocol } = await import('../v2/driver.ts')
  const { independentSponsor } = await import('./v2-judges.ts')
  return runProtocol(
    job,
    paths.workspace,
    hostPort(ctx, paths.roleStore, agent),
    independentSponsor(ctx, sponsor),
    agent.provider,
    limits,
  )
}
