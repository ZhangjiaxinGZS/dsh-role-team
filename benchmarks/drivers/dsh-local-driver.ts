import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { document } from '../types.ts'
import { flagshipCodex, withLocalHost } from './local-host.ts'
import type { LiveTrial, LiveHostDriver, Observation } from '../types.ts'

import { installPrefixBrief } from './prefix-brief.ts'

async function settle(ctx: Context, agent: Agent) {
  while (true) {
    await agent.whenIdle()
    const seq = agent.session.seq
    if (!(await ctx.subagents.waitForTreeWork(agent)) && agent.status === 'idle' && agent.session.seq === seq)
      return
  }
}
async function execute(ctx: Context, trial: LiveTrial): ReturnType<LiveHostDriver['runTrial']> {
  const { scenario, workspace } = trial
  const [provider, model] = trial.model.split(':')
  ctx.on('agent/created', ({ agent }) => {
    agent.model.select({
      provider,
      model,
      ...(trial.model === flagshipCodex && { reasoningEffort: ReasoningEffortId('high') }),
    })
    return undefined
  })
  const team = trial.arm !== 'single-agent'
  const leaders = new Set<string>()
  let runId = ''
  let prefixSeen = false
  if (trial.arm === 'v0.2.0-prefix-brief') {
    if (scenario.id !== 'S4') throw new Error('Prefix treatment requires the S4 protocol')
    installPrefixBrief(ctx, () => runId)
  }
  const actors = new Map<string, string>()
  const observations: Observation[] = []
  let step = 1
  let order = 0
  const effort = new Set<string>()
  const fatal = Promise.withResolvers<never>()
  // Observe early errors even if the host is still admitting members.
  void fatal.promise.catch(() => {})
  let failure: string | undefined
  const answers = new Map<string, string>()
  const cache = new Set<string>()
  function observe(kind: Observation['kind'], actor: string, text: string) {
    observations.push({ kind, actor, text, step: scenario.id === 'S3' ? step : ++order })
  }
  ctx.on('session/event', (s, e) => {
    if (e.type === 'request/header') {
      const cfg = e.data.header.config
      effort.add(cfg.reasoningEffort ?? 'adapter-default')
      if (cfg.provider !== provider || cfg.model !== model) failure = 'Model turn failed: ROUTE_MISMATCH'
      else if (trial.model === flagshipCodex && cfg.reasoningEffort !== 'high')
        failure = 'Model turn failed: REASONING_EFFORT_MISMATCH'
    }
    if (e.type === 'turn/end' && e.data.reason.kind === 'error') {
      const f = e.data.reason.error
      const status = 'status' in f && typeof f.status === 'number' ? f.status : undefined
      failure ??=
        'Model turn failed: ' +
        (/^[A-Z0-9_]+$/.test(f.code) ? f.code : 'UNKNOWN') +
        (status ? ' HTTP ' + status : '')
    }
    if ((e.type as string) === 'llm/retry') {
      const f = (e.data as { failure?: { status?: number; code?: string } }).failure
      if (
        f &&
        ([401, 403, 429].includes(f.status ?? 0) || /AUTH|QUOTA|CREDENTIAL|RATE_LIMIT/.test(f.code ?? ''))
      )
        failure =
          'Model turn failed: ' +
          (/^[A-Z_0-9]+$/.test(f.code ?? '') ? f.code : 'UNKNOWN') +
          (f.status ? ' HTTP ' + f.status : '')
    }
    if (failure) fatal.reject(new Error(failure))
    if (e.type === 'system/message' && JSON.stringify(e.data.message.content).includes('<team-brief-update '))
      prefixSeen = true
    if (e.type === 'assistant/message') {
      if (typeof e.data.usage?.cacheReadTokens === 'number' && typeof e.data.usage.inputTokens === 'number')
        cache.add(s.id)
      const text = e.data.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
      if (text) {
        answers.set(s.id, text)
        observe('work', actors.get(s.id) ?? s.id, text)
      }
    }
    if (
      scenario.id === 'S3' &&
      e.type === 'tool/call' &&
      ['write', 'edit', 'send_message'].includes(e.data.name)
    )
      observe('work', actors.get(s.id) ?? s.id, e.data.arguments)
    if (e.type === 'compaction/summary') observe('compaction', actors.get(s.id) ?? s.id, 'summary committed')
    if (
      e.type === 'user/message' &&
      (e.data.source.kind === 'agent-message' || e.data.source.kind === 'team-message')
    ) {
      const from = Reflect.get(e.data.source, 'senderSessionId') ?? Reflect.get(e.data.source, 'senderId')
      const text = e.data.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
      if (leaders.has(s.id)) observe('report', actors.get(from) ?? from, text)
      else if (leaders.has(from)) observe('assignment', actors.get(s.id) ?? s.id, text)
    }
    if (e.type === 'team/task') {
      const task = e.data.task
      if (task?.ownerId) observe('board', actors.get(task.ownerId) ?? task.ownerId, task.status)
    }
  })
  const resolveAgent = async (id: string) => {
    const v = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in v) throw new Error('Isolated session resolution failed')
    return v.agent
  }
  const workers = team ? scenario.roles.slice(1).map((r) => r.id) : ['lead']
  async function create() {
    const rootId = team
      ? (
          await ctx.roleTeam.createTeam({
            title: scenario.title,
            roleId: scenario.roles[0].id,
            workspaceCwd: workspace,
            locale: 'en',
            agentPreset: trial.preset,
          })
        ).run
      : {
          rootSessionId: (await ctx.sessionController.create({ cwd: workspace, agentPreset: trial.preset }))
            .sessionId,
          runId: '',
        }
    runId = rootId.runId
    const lead = await resolveAgent(rootId.rootSessionId)
    leaders.add(lead.id)
    actors.set(lead.id, 'lead')
    ctx.permissionPresets.set(lead.session, 'danger-full-access')
    if (team) {
      for (const role of scenario.roles.slice(1)) {
        const seat = await ctx.roleTeam.addMember({ runId, roleId: role.id })
        actors.set(seat.currentSessionId, role.id)
        if (failure) throw new Error(failure)
      }
    }
    return lead
  }
  const lead = await create()
  const ask = async (agent: Agent, text: string) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await Promise.race([settle(ctx, agent), fatal.promise])
    if (failure) throw new Error(failure)
  }
  const inventory = (await readdir(workspace)).sort().join(', ')
  const instructions = [
    scenario.initialPrompt,
    'Workspace files: ' + inventory,
    'Use workspace read/write/edit for local files. Ask the sponsor in a plain-text response.',
    ...(team ? [] : scenario.roles.map((r) => [r.duty, r.privateContext].filter(Boolean).join(' '))),
    ...(scenario.id === 'S3' ? ['Start checkpoint 1 only. The sponsor advances each checkpoint.'] : []),
    ...(scenario.id === 'S4'
      ? [
          'First review the incident log and prepare a handoff. Wait for the continuation before writing the delivery.',
        ]
      : []),
    ...(scenario.id === 'S6' ? ['For now perform T1 only. Wait for the separate T2 input.'] : []),
  ].join('\n')
  async function changeBrief(text: string) {
    if (!['v0.2.0-full', 'v0.2.0-prefix-brief'].includes(trial.arm)) return
    const b = await ctx.roleTeam.getTeamBrief({ runId })
    const result = await ctx.roleTeam.saveTeamBrief({ runId, text, expectedHash: b?.hash ?? null })
    if (!result.ok) throw new Error('Isolated brief revision conflict')
  }
  if (scenario.id === 'S4') await changeBrief(scenario.initialPrompt)
  await ask(lead, instructions)
  if (scenario.id === 'S2') {
    const seen = new Set<string>()
    for (let round = 0; round < 3; round++) {
      const answer = answers.get(lead.id) ?? ''
      if (
        !/[?？]|please (?:provide|clarify|confirm)|could you|what is|who (?:is|are)/i.test(answer) ||
        seen.has(answer)
      )
        break
      seen.add(answer)
      observe('question', 'lead', answer)
      await ask(lead, scenario.simulatedUser!(answer))
    }
    observe('answer', 'lead', answers.get(lead.id) ?? '')
  }
  if (scenario.id === 'S3') {
    for (step = 2; step <= 10; step++) {
      const pivot = scenario.pivots!.find((p) => p.progress * 10 === step)
      if (pivot) observe('pivot', 'user', pivot.instruction)
      await ask(
        lead,
        `Checkpoint ${step} of 10. ${pivot?.instruction ?? 'Continue under the latest agreement.'}`,
      )
    }
  }
  if (scenario.id === 'S4') {
    const second = 'Prepare to resume after maintenance and record the retained decisions in delivery.json.'
    // Both brief-bearing arms receive the same sponsor-controlled revisions.
    await changeBrief(scenario.initialPrompt + '\n' + second)
    await ask(lead, second)
    // The standard preset owns compaction in a private Cordis group. Its public
    // slash command resolves the engine for this particular Agent.
    const compacted = await ctx.commands.execute(lead, '/compact', [], AbortSignal.timeout(180_000))
    if (!compacted || compacted.result.kind !== 'success' || compacted.result.sourceEventSeq === undefined)
      throw new Error('Model turn failed: COMPACTION_NOT_COMMITTED')
    if (team) {
      const seat = (await ctx.roleTeam.getTeam({ runId })).seats.find((s) => s.roleId === workers[0])!
      const next = await ctx.roleTeam.resetSeat({
        seatId: seat.seatId,
        generation: seat.currentGeneration,
        handoff: (answers.get(seat.currentSessionId) ?? '').slice(0, 8000),
      })
      actors.set(next.currentSessionId, seat.roleId)
      observe('reset', seat.roleId, 'new generation admitted')
      await ctx.roleTeam.promptSeat({
        seatId: next.seatId,
        generation: next.currentGeneration,
        delivery: 'queue',
        requestId: crypto.randomUUID(),
        text: 'Resume the handoff. Report the retained release decisions to the leader.',
      })
      await Promise.race([settle(ctx, lead), fatal.promise])
    }
    await ask(lead, 'Finish the delivery using the retained decisions.')
  }
  if (scenario.id === 'S6') {
    const a = await document(workspace, 't1.json')
    const accepted = a.region === 'east' && JSON.stringify(a.ids) === '[1,2,3]'
    observe('stage1', 'lead', accepted ? 'accepted' : 'rejected')
    if (team && accepted) {
      const trainee = workers[0]
      const training = await ctx.roleTeam.createTraining({
        roleId: trainee,
        mode: 'coach',
        workspaceCwd: workspace,
        locale: 'en',
      })
      const before = new Set(await ctx.roleTeam.listMemories(trainee))
      const coach = await resolveAgent(training.sessionId)
      actors.set(coach.id, trainee)
      await ask(
        coach,
        'The east release passed verification. Save the reusable lesson with remember_experience: ' +
          scenario.simulatedUser!('T1'),
      )
      for (const id of await ctx.roleTeam.listMemories(trainee)) {
        if (before.has(id)) continue
        const doc = await ctx.roleTeam.readDocument({ roleId: trainee, memoryId: id })
        if (doc) observe('experience', trainee, doc.text)
      }
    }
    await rm(join(workspace, 't2.json'), { force: true })
    const fresh = await create()
    await ask(
      fresh,
      scenario.pivots![0].instruction +
        '\n' +
        scenario.simulatedUser!('T2') +
        '\nWrite t2.json with region and ids.',
    )
    const b = await document(workspace, 't2.json')
    observe(
      'stage2',
      'lead',
      b.region === 'west' && JSON.stringify(b.ids) === '[5,6,8]' ? 'accepted' : 'rejected',
    )
  }
  if ([...leaders].some((id) => !cache.has(id)))
    throw new Error('Leader response missing measured inputTokens/cacheReadTokens')
  if (trial.arm === 'v0.2.0-prefix-brief' && !prefixSeen)
    throw new Error('Prefix treatment missing system evidence')
  const sessions = ctx.get('sessions') as unknown as import('@deepseek-ai/dsh-session').SessionStore
  for (const s of sessions.list()) await sessions.flush(s)
  const traces = []
  for (const id of actors.keys()) {
    const reader = await ctx.sessionPersistence.open(id as SessionId, 'read')
    try {
      const { events } = await reader.read()
      if (
        trial.arm === 'v0.2.0-prefix-brief' &&
        events.some((e) => e.type === 'user/message' && e.data.source.kind === 'team-brief')
      )
        throw new Error('Prefix treatment leaked a suffix')
      const path = join(trial.traceDir, id + '.decoded.jsonl')
      await writeFile(
        path,
        [{ type: 'session', ...reader.header }, ...events].map((row) => JSON.stringify(row)).join('\n') +
          '\n',
        { flag: 'wx', mode: 0o600 },
      )
      traces.push({ path, leader: leaders.has(id) })
    } finally {
      await reader.close()
    }
  }
  await writeFile(join(trial.traceDir, 'observations.json'), JSON.stringify(observations), { mode: 0o600 })
  return { traces, observations, workers, reasoningEfforts: [...effort].sort() }
}
export default {
  arms: ['single-agent', 'v0.1.0', 'v0.2.0-full', 'v0.2.0-prefix-brief'],
  capabilities: ['clarification', 'pivots', 'compaction', 'reset', 'parallel-reports', 'training'],
  runTrial: (trial) => withLocalHost(trial, (ctx) => execute(ctx, trial)),
} satisfies LiveHostDriver
