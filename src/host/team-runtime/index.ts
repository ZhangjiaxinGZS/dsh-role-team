import type {} from '@deepseek-ai/dsh-compaction'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { roleNameKey, type IndexRecord, type Snapshot, type ModelChoice } from '../../shared/index.js'
import type { Input } from '../../shared/runtime.js'
import { RoleStore } from '../role-store/index.js'
import { generationKey, type Index } from '../storage/index.js'
import { isolate, workspacePath, installRolePrompt } from '../isolation/index.js'
import { TrainingRuntime } from '../training/index.js'
import { replaceSeat } from '../seat-reset/index.js'
import { NativeTeam } from './native.js'

import { policyNotice } from './policy.js'
import { TeamBriefs, briefNotice } from './briefs.js'
import { TeamSchedules } from './schedules.js'

export type Seat = IndexRecord<'team_seats'>
export class TeamRuntime {
  readonly briefs = new TeamBriefs(this)
  readonly schedules = new TeamSchedules(this)
  readonly training: TrainingRuntime
  private readonly queue = new Map<string, Promise<unknown>>()
  private readonly restoringModel = new Set<string>()
  private readonly cache = new Map<string, Snapshot>()
  constructor(
    readonly index: Index,
    readonly roles: RoleStore,
    readonly native: NativeTeam,
  ) {
    this.training = new TrainingRuntime(index, roles, native)
  }
  async ordered<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(key)
    const task = (previous ?? Promise.resolve()).catch(() => {}).then(work)
    this.queue.set(key, task)
    try {
      return await task
    } finally {
      if (this.queue.get(key) === task) this.queue.delete(key)
    }
  }
  async snapshot(id: string, rev: number) {
    const key = id + '/' + rev
    if (!this.cache.has(key)) this.cache.set(key, await this.roles.readSnapshot(id, rev))
    return this.cache.get(key)!
  }
  async latest(roleId: string) {
    const rev = (await this.roles.listRoles()).find((r) => r.roleId === roleId)?.publishedRevision
    if (!rev) throw new Error('Role has no published snapshot')
    return this.snapshot(roleId, rev)
  }
  seat(id: string) {
    const row = this.index.seats.get(id)
    if (!row) throw new Error('Seat not found')
    return row
  }
  getTeam(runId: string) {
    const run = this.index.runs.get(runId)
    if (!run) throw new Error('Team not found')
    // The stored displayName is the seat's historical fallback. Resolve labels on read
    // so a new publication is visible without rewriting seat or generation records.
    const seats = this.index.seats.list().filter(s => s.runId === runId).map(s => ({
      ...s, displayName: this.roles.published(s.roleId)?.role.meta.name ?? s.displayName,
    }))
    const reserved = new Set(seats.map(s => roleNameKey(s.displayName)))
    const counts = new Map<string, number>()
    for (const seat of seats) {
      const base = seat.displayName
      const key = roleNameKey(base)
      let number = (counts.get(key) ?? 0) + 1
      if (number > 1) {
        // A separate role can already own a numbered name such as “Editor 2”.
        while (reserved.has(roleNameKey(base + ' ' + number))) number++
        seat.displayName = base + ' ' + number
      }
      counts.set(key, number)
    }
    return { run, seats }
  }
  active(runId: string) {
    const { run } = this.getTeam(runId)
    if (run.status !== 'active') throw new Error('Team is not active')
    return run
  }
  mentionRoster(runId: string) {
    const { seats } = this.getTeam(runId)
    const byId = new Map(seats.map(s => [s.seatId, s]))
    const address = (seat: Seat): string => {
      if (!seat.parentSeatId) return 'lead'
      const path = [seat.nativeAgentName]
      let parent = byId.get(seat.parentSeatId)
      while (parent?.parentSeatId) {
        path.unshift(parent.nativeAgentName)
        parent = byId.get(parent.parentSeatId)
      }
      return path.join('/')
    }
    const members = seats.filter(s => s.status === 'active' && !s.joining).map(s => {
      const role = this.roles.published(s.roleId) ?? this.cache.get(s.roleId + '/' + s.adoptedRoleRev)
      return { seatId: s.seatId, name: s.displayName, duty: role?.role.meta.summary ?? '',
        address: address(s), leader: !s.parentSeatId }
    })
    return { runId, members }
  }
  nativeName(parentId: string, label: string, roleId: string) {
    const used = new Set(
      this.index.seats
        .list()
        .filter((s) => s.parentSeatId === parentId)
        .flatMap((s) =>
          this.index.generations
            .list()
            .filter((g) => g.seatId === s.seatId)
            .map((g) => g.nativeAgentName),
        ),
    )
    const slug = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    let base = slug(label) || slug(roleId)
    if (/^role-[a-f0-9]{10}$/.test(base)) base = 'member'
    if (!/^[a-z]/.test(base) || base === 'lead') base = 'member-' + base
    base = base.slice(0, 26)
    let name = base
    for (let i = 2; used.has(name); i++) name = base + '-' + i
    return name
  }
  async selectSeatModel(input: Input<'selectSeatModel'>) {
    return this.ordered(this.seat(input.seatId).runId, async () => {
      const s = this.seat(input.seatId)
      this.active(s.runId)
      if (
        !s.parentSeatId ||
        s.status !== 'active' ||
        s.joining ||
        s.currentGeneration !== input.generation
      )
        throw new Error('Seat generation is unavailable')
      const choice = input.selection
      const entry = (await this.native.models()).find(
        (m) => m.provider === choice.provider && m.model === choice.model,
      )
      if (
        !entry ||
        (choice.reasoningEffort && !entry.efforts.some((e) => e.id === choice.reasoningEffort))
      )
        throw new Error('Model or reasoning effort is unavailable')
      await this.native.ctx.llm.resolveCallConfig(
        choice as Parameters<typeof this.native.ctx.llm.resolveCallConfig>[0],
      )
      const updated = await this.index.seats.update(s.seatId, (row) => ({ ...row, selection: choice }))
      const live = this.native.ctx.agents.get(s.currentSessionId as SessionId)
      if (live) this.native.select(live, choice)
      await this.remember(s.roleId, choice)
      return updated
    })
  }
  private remember(roleId: string, selection: ModelChoice) {
    return this.ordered('model/' + roleId, () => this.index.models.put({ roleId, selection }))
  }
  private async restoreModel(agent: Agent, roleId: string, selected?: ModelChoice) {
    await this.queue.get('model/' + roleId)
    const choice =
      selected ?? (!agent.session.firstLiveSeq ? this.index.models.get(roleId)?.selection : undefined)
    if (!choice) return
    this.restoringModel.add(agent.id)
    try {
      this.native.select(agent, choice)
    } finally {
      this.restoringModel.delete(agent.id)
    }
  }
  observeSessions() {
    const { ctx } = this.native
    ctx.on('session/event', (session, event) => {
      if (!session.id.startsWith('rt-')) return
      const source = event.type === 'user/message' ? event.data.source : undefined
      if (event.type === 'compaction/summary' || source?.kind === 'team-brief' || source?.kind === 'team-policy') {
        const seen = source?.kind === 'team-brief' ? { seenBriefHash: source.briefHash }
          : source?.kind === 'team-policy' ? { seenPolicyHash: source.policyHash }
          : { seenBriefHash: null, seenPolicyHash: null }
        const g = this.index.generations.list().find(g => g.sessionId === session.id)
        if (g) void this.ordered('seen/' + session.id, () => this.index.generations.update(
          generationKey(g.seatId, g.generation), row => ({ ...row, ...seen }),
        )).catch(e => ctx.logger.warn(String(e)))
        return
      }
      if (event.type === 'model/selection' || event.type === 'request/header') {
        if (this.restoringModel.has(session.id)) return
        const roleId =
          this.index.seats.list().find((s) => s.currentSessionId === session.id && s.status === 'active')
            ?.roleId ?? this.index.training.list().find((t) => t.sessionId === session.id)?.roleId
        if (!roleId) return
        const config = event.type === 'model/selection' ? event.data : event.data.header.config
        if (event.type === 'request/header' && this.index.models.get(roleId)) return
        void this.remember(roleId, {
          provider: config.provider,
          model: config.model,
          reasoningEffort:
            event.type === 'request/header' && event.data.header.adapterDefaults?.reasoningEffort
              ? undefined
              : config.reasoningEffort,
        }).catch((e) => ctx.logger.warn(String(e)))
      }
      if (!['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) return
      const seat = this.index.seats.list().find((s) => s.currentSessionId === session.id)
      if (!seat) return
      if (!seat.parentSeatId && event.type === 'permission/preset')
        void this.index.runs
          .update(seat.runId, (run) => ({ ...run, permissionPreset: event.data.preset }))
          .catch((e) => ctx.logger.warn(String(e)))
      // The preset and its knobs are appended together. Reconcile after the complete native switch.
      queueMicrotask(() => {
        const { run, seats } = this.getTeam(seat.runId)
        for (const s of seats.filter((s) => s.parentSeatId && s.status === 'active')) {
          const live = ctx.agents.get(s.currentSessionId as SessionId)
          if (live) {
            try {
              this.native.followPermission(run.rootSessionId, live, run.permissionPreset)
            } catch (e) {
              ctx.logger.warn(String(e))
            }
          }
        }
      })
    })
  }
  async reserve(
    runId: string,
    parentSeatId: string | null,
    snap: Snapshot,
    displayName?: string,
    seatId = randomUUID(),
    sessionId = 'rt-child-' + randomUUID(),
  ) {
    const seat: Seat = {
      seatId,
      runId,
      parentSeatId,
      roleId: snap.roleId,
      displayName: displayName ?? snap.role.meta.name,
      currentGeneration: 1,
      currentSessionId: sessionId,
      nativeAgentName: parentSeatId
        ? this.nativeName(parentSeatId, displayName ?? snap.role.meta.name, snap.roleId)
        : 'lead',
      adoptedRoleRev: snap.publishedRevision,
      adoptedMemoryRev: snap.publishedRevision,
      pendingRoleRev: null,
      pendingMemoryRev: null,
      status: 'active',
      ...(parentSeatId ? { joining: true as const } : {}),
    }
    await this.index.generations.put({
      seatId,
      generation: 1,
      sessionId,
      nativeAgentName: seat.nativeAgentName,
      roleSnapshotHash: snap.sourceHash,
      memoryIds: snap.memories.map((m) => m.meta.id),
      seenBriefHash: null,
      seenPolicyHash: null,
      handoffNote: null,
      archivedAt: null,
    })
    await this.index.seats.put(seat)
    return seat
  }
  async createTeam(input: Input<'createTeam'>) {
    const cwd = await workspacePath(input.workspaceCwd, this.roles.root)
    const snap = await this.latest(input.roleId)
    const runId = randomUUID(),
      seatId = randomUUID(),
      rootSessionId = 'rt-root-' + randomUUID()
    await this.index.runs.put({
      runId,
      title: input.title,
      locale: input.locale,
      agentPreset: input.agentPreset,
      workspaceCwd: cwd,
      rootSessionId,
      leaderSeatId: seatId,
      status: 'creating',
      createdAt: new Date().toISOString(),
    })
    try {
      await this.reserve(runId, null, snap, undefined, seatId, rootSessionId)
      await this.native.create(rootSessionId, cwd, input.agentPreset)
      await this.native.enable(rootSessionId)
      await this.index.runs.update(runId, (run) => ({ ...run, status: 'active' }))
      return this.getTeam(runId)
    } catch (error) {
      await this.index.runs.update(runId, (run) => ({ ...run, status: 'failed' }))
      throw error
    }
  }
  addMember(input: Input<'addMember'>) {
    return this.ordered(input.runId, async () => {
      const run = this.active(input.runId)
      const parent = this.seat(input.parentSeatId ?? run.leaderSeatId)
      if (parent.runId !== run.runId || parent.status !== 'active')
        throw new Error('Select an active parent in this team')
      const seat = await this.reserve(
        run.runId,
        parent.seatId,
        await this.latest(input.roleId),
        input.displayName,
      )
      try {
        await this.native.spawn(
          run.rootSessionId,
          parent.currentSessionId,
          seat.currentSessionId,
          seat.nativeAgentName,
          seat.displayName,
          run.locale,
        )
      } catch (error) {
        await this.index.seats.update(seat.seatId, (s) => ({ ...s, status: 'archived' }))
        throw error
      }
      return this.finishJoin(seat)
    })
  }
  private async finishJoin(seat: Seat) {
    const run = this.active(seat.runId)
    const snap = await this.snapshot(seat.roleId, seat.adoptedRoleRev)
    const duty = snap.role.meta.summary || (run.locale === 'en' ? 'Awaiting assignment' : '待队长安排')
    const message =
      run.locale === 'en'
        ? `${seat.displayName} (${seat.nativeAgentName}) has joined and is ready. Responsibilities: ${duty}.`
        : `成员「${seat.displayName}」已加入团队并就绪。职责：${duty}。协作名称：${seat.nativeAgentName}。`
    const leader = await this.native.root(run.rootSessionId)
    const child = this.native.ctx.agents.get(seat.currentSessionId as SessionId)
    if (child)
      await this.native.ctx.subagents.sendMessage(child, leader.id, [{ type: 'text', text: message }], {
        signal: new AbortController().signal,
      })
    else
      await this.native.prompt(leader.id, false, {
        seatId: run.leaderSeatId,
        generation: 1,
        requestId: seat.seatId,
        delivery: 'queue',
        text: message,
      })
    return this.index.seats.update(seat.seatId, ({ joining, ...ready }) => ready)
  }
  /** Restore interrupted creation intents before the next UI operation addresses their seats. */
  async recover() {
    const trainings = this.index.training.list()
    await Promise.all(
      [...new Set(trainings.map((row) => row.roleId))].map((roleId) =>
        this.ordered('training/' + roleId, () => this.training.recover(roleId)),
      ),
    )
    for (const run of this.index.runs.list()) {
      if (run.status === 'deleting') {
        await this.deleteTeam(run.runId)
        continue
      }
      if (run.status === 'creating') {
        const leader = this.index.seats.get(run.leaderSeatId)
        if (!leader) {
          await this.index.runs.update(run.runId, (r) => ({ ...r, status: 'failed' }))
          continue
        }
        if (!(await this.native.exists(run.rootSessionId)))
          await this.native.create(run.rootSessionId, run.workspaceCwd, run.agentPreset)
        await this.native.enable(run.rootSessionId)
        await this.index.runs.update(run.runId, (r) => ({ ...r, status: 'active' }))
      }
      if (this.index.runs.get(run.runId)?.status !== 'active') continue
      if (
        this.native.ctx.workspaceRegistry.archivedSessionIds.includes(run.rootSessionId as SessionId)
      ) {
        await this.archiveTeam(run.runId)
        continue
      }
      for (const seat of this.getTeam(run.runId).seats.filter(
        (s) => s.joining && s.status === 'active',
      )) {
        await this.ordered(run.runId, async () => {
          const parent = this.seat(seat.parentSeatId!)
          await this.native.spawn(
            run.rootSessionId,
            parent.currentSessionId,
            seat.currentSessionId,
            seat.nativeAgentName,
            seat.displayName,
            run.locale,
          )
          await this.finishJoin(seat)
        })
      }
    }
  }
  deleteTeam(runId: string) {
    return this.ordered(runId, async () => {
      const run = this.index.runs.get(runId)
      if (!run) return false
      if (run.status !== 'archived' && run.status !== 'deleting')
        throw new Error('Only archived teams can be deleted')
      if (run.status === 'archived')
        await this.index.runs.update(runId, (r) => ({ ...r, status: 'deleting' }))
      // Keep seat ownership until every generation has been removed. Recovery
      // can repeat these deletes after a failure at any table boundary.
      const seats = this.index.seats.list().filter((s) => s.runId === runId)
      const ids = new Set(seats.map((s) => s.seatId))
      for (const g of this.index.generations.list()) {
        if (ids.has(g.seatId)) await this.index.generations.delete(generationKey(g.seatId, g.generation))
      }
      for (const seat of seats) await this.index.seats.delete(seat.seatId)
      for (const link of this.index.schedules.list()) {
        if (link.runId === runId) await this.index.schedules.delete(link.scheduleId)
      }
      await this.briefs.remove(runId)
      return this.index.runs.delete(runId)
    })
  }
  async archiveImpact(runId: string) {
    const { rootSessionId } = this.getTeam(runId).run
    const tasks = await this.native.ctx.get('schedule')?.catalog() ?? []
    return tasks.filter(task => task.status === 'active' && task.target.kind === 'session' && task.target.sessionId === rootSessionId).length
  }
  archiveTeam(runId: string, expectedActiveSchedules?: number) {
    return this.ordered(runId, async () => {
      const { run, seats } = this.getTeam(runId)
      if (expectedActiveSchedules !== undefined && await this.archiveImpact(runId) !== expectedActiveSchedules)
        throw new Error(run.locale === 'en' ? 'Scheduled tasks changed. Review the count and confirm again.' : '定时任务数量已变更，请重新核对后归档。')
      if (run.status === 'deleting') throw new Error('Team deletion is in progress')
      if (
        run.status !== 'archived' &&
        (run.status === 'active' || (await this.native.exists(run.rootSessionId)))
      )
        await this.native.archive(run.rootSessionId)
      for (const s of seats)
        await this.index.seats.update(s.seatId, (value) => ({ ...value, status: 'archived' }))
      // Wait for an admitted brief save only after native activity has stopped.
      return this.ordered('brief/' + runId, () => this.index.runs.update(runId, (r) => ({ ...r, status: 'archived' })))
    })
  }
  async versionDecision(input: Input<'versionDecision'>) {
    // Compatibility for older clients. Published changes apply automatically.
    return this.seat(input.seatId)
  }
  promptSeat(input: Input<'promptSeat'>) {
    const check = () => {
      const seat = this.seat(input.seatId)
      this.active(seat.runId)
      if (seat.status !== 'active' || seat.joining || seat.currentGeneration !== input.generation)
        throw new Error('Seat generation is unavailable')
      if (input.text.includes('dsh-session:'))
        throw new Error('Cross-session references are unavailable')
      return seat
    }
    return this.ordered(check().runId, async () => {
      const seat = check()
      return this.native.prompt(seat.currentSessionId, seat.parentSeatId !== null, input)
    })
  }
  resetSeat(input: Input<'resetSeat'>) {
    return this.ordered(this.seat(input.seatId).runId, () => replaceSeat(this, input))
  }
  private async attachTemporaryChild(agent: Agent) {
    // Ordinary forks may also have a parent header. Only native subagent
    // ancestry can confer a seat's isolation policy, never its role tools.
    let header = agent.session.header
    const seen = new Set<SessionId>()
    while (header.origin === 'subagent' && header.parentSession) {
      const parent = header.parentSession
      if (seen.has(parent)) throw new Error('Invalid subagent ancestry')
      seen.add(parent)
      if (parent.startsWith('rt-')) {
        const owner = this.index.seats.list().find(s => s.currentSessionId === parent)
        if (!owner) throw new Error('Managed session has no current binding')
        const active = () => {
          const current = this.index.seats.get(owner.seatId)
          return current?.status === 'active' && current.currentSessionId === parent &&
            this.index.runs.get(owner.runId)?.status === 'active'
        }
        if (!active()) throw new Error('Member generation is unavailable')
        isolate(agent, this.roles.root, active, this.active(owner.runId).locale, 'member')
        return
      }
      if (header.delegationDepth === 1) return
      header = this.native.ctx.agents.get(parent)?.session.header ??
        await this.native.ctx.sessionQuery.inspectSession(parent, session => session.header)
    }
    if (header.parentSession?.startsWith('rt-')) throw new Error('Managed session has no current binding')
  }
  async attach(agent: Agent) {
    const { index } = this
    const training = index.training.list().find((t) => t.sessionId === agent.id)
    if (training) {
      await this.restoreModel(agent, training.roleId)
      isolate(
        agent,
        this.roles.root,
        () => this.training.current(training.roleId).some((t) => t.trainingId === training.trainingId),
        training.locale,
      )
      agent.ctx.systemPrompt.suppressRuntimeContext()
      await this.training.install(agent, training)
      return
    }
    const seat = index.seats
      .list()
      .find((s) => s.currentSessionId === agent.id || s.reset?.sessionId === agent.id)
    if (!seat) {
      if (agent.id.startsWith('rt-'))
        throw new Error('Managed session has no current binding')
      return this.attachTemporaryChild(agent)
    }
    const current = () => this.seat(seat.seatId)
    const active = () => {
      const row = current(),
        run = index.runs.get(row.runId)
      return (
        (run?.status === 'active' || run?.status === 'creating') &&
        (row.status === 'resetting'
          ? row.reset?.sessionId === agent.id
          : row.status === 'active' && row.currentSessionId === agent.id)
      )
    }
    const run = this.getTeam(seat.runId).run
    if (!seat.parentSeatId) {
      const preset = this.native.ctx.get('permissionPresets')?.current(agent.session)
      if (preset && preset !== run.permissionPreset)
        await index.runs.update(seat.runId, (r) => ({ ...r, permissionPreset: preset }))
    }
    await this.restoreModel(agent, seat.roleId, seat.selection)
    if (seat.parentSeatId)
      this.native.followPermission(
        run.rootSessionId,
        agent,
        this.getTeam(seat.runId).run.permissionPreset,
      )
    isolate(agent, this.roles.root, active, run.locale, seat.parentSeatId ? 'member' : 'leader')
    this.briefs.install(agent, seat.runId, !seat.parentSeatId, agent.ctx)
    if (!seat.parentSeatId) agent.ctx.inject(['schedule'], scope => this.schedules.install(agent, seat.runId, scope))
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== agent) return next()
      if (seat.parentSeatId)
        this.native.followPermission(
          run.rootSessionId,
          agent,
          this.getTeam(seat.runId).run.permissionPreset,
        )
      const args = exec.arguments as { agent?: unknown; owner?: unknown }
      const target =
        exec.name === 'send_message'
          ? args.agent
          : exec.name === 'team_task_update'
            ? args.owner
            : undefined
      if (typeof target === 'string') {
        const id = await this.native.ctx.subagents.resolveName(agent, target, exec.signal)
        const recipient = index.seats
          .list()
          .find((s) => s.runId === seat.runId && s.currentSessionId === id)
        if (recipient?.status !== 'active')
          return {
            kind: 'deny',
            reason:
              run.locale === 'en'
                ? 'Target is not an active seat in this team'
                : '目标成员不在当前团队的活跃席位中。',
          }
      }
      return next()
    })
    const generation =
      seat.reset?.sessionId === agent.id ? seat.currentGeneration + 1 : seat.currentGeneration
    const history = index.generations.get(generationKey(seat.seatId, generation))
    if (!history) throw new Error('Missing generation')
    await this.snapshot(seat.roleId, seat.adoptedRoleRev)
    await this.snapshot(seat.roleId, seat.adoptedMemoryRev)
    if (seat.reset) await this.snapshot(seat.roleId, seat.reset.revision)
    let frozen:
      | { turn: number; role: Snapshot; memory: Snapshot; context: string; adopting: boolean }
      | undefined
    const view = () => {
      const turn = this.native.ctx.agents.turnBoundaryOf(agent.session).lastTurn
      if (frozen?.turn === turn) return frozen
      const row = current()
      const replacement = row.reset?.sessionId === agent.id ? row.reset.revision : undefined
      const published = replacement === undefined ? this.roles.published(row.roleId) : undefined
      if (published) this.cache.set(row.roleId + '/' + published.publishedRevision, published)
      const read = (revision: number) => {
        const s = this.cache.get(row.roleId + '/' + revision)
        if (!s) throw new Error('Required role snapshot is unavailable')
        return s
      }
      const role = published ?? read(replacement ?? row.adoptedRoleRev),
        memory = published ?? read(replacement ?? row.adoptedMemoryRev)
      const context = [
        memory.memories
          .map((m) => m.meta.title + '\n' + m.body)
          .join('\n')
          .slice(0, 16000),
        history.handoffNote,
      ]
        .filter(Boolean)
        .join('\n\n')
      return (frozen = {
        turn,
        role,
        memory,
        context,
        adopting: replacement === undefined,
      })
    }
    agent.ctx.systemPrompt.suppressRuntimeContext()
    installRolePrompt(agent, () =>
      [
        run.locale === 'en' ? 'Work and reply in English.' : '请用中文协作、报到并回复用户。',
        view().role.role.meta.name,
        view().role.role.meta.summary,
        view().role.role.body,
        run.locale === 'en'
          ? 'Team mentions identify collaborators. Match role-team:RUN/SEAT to the current roster below, using the seat ID even if a name has changed. A plain @name must match uniquely. Ask if ambiguous, missing, or from another team. /all or @Everyone addresses every active member. For requested collaboration, do your own part and use send_message with each other recipient’s exact address and a concrete assignment or report. Members can report to lead. A mention alone sends no message.'
          : '团队协作：标签 role-team:团队ID/席位ID 按下方本队花名册定位，改名仍按席位匹配。手写 @角色名 仅在唯一匹配时指派；重名、离队或非本队标签请先澄清。/all 或 @全体成员 指当前全队。需要协作时，自己承担本职部分，用 send_message 向其余被点名成员的准确 address 派发具体任务或汇报；成员向队长汇报用 lead。标签本身不会发送消息。',
        run.locale === 'en'
          ? 'Members report scheduling requests to lead. Only the leader manages team schedules. Before creating one, present the time, time zone, frequency and exact instructions and wait for explicit user confirmation. A scheduled delivery is a request to execute the confirmed work and delegate as needed. It is not authorization to schedule it again.'
          : '成员遇到定时或延时需求，只向队长汇报。队长须先向用户列明时间、时区、频率和具体执行内容，获得明确确认后才可创建团队定时任务。收到定时投递时执行已确认的工作，按需派给成员，不能据此再次创建定时任务。',
        run.locale === 'en'
          ? 'Before ending assigned work, update both the shared board and your personal todo_write list. Read the latest revision and use team_task_update complete for finished work or release when blocked. Mark the corresponding todos completed or pending and keep unrelated todos. Report the result or blocker and next step to the leader. Stopped work must never remain in_progress. As leader, read the latest member reports and completion notices first, then reconcile stale board entries or reassign the next step before waiting.'
          : '成员完成任务或因卡点暂停时，结束回合前同步更新共享任务板和个人 todo_write。读取最新修订号，用 team_task_update 的 complete 完成任务，遇阻停工用 release 释放任务。个人清单对应项标为 completed 或 pending，保留其余条目。向队长汇报结果或卡点及下一步，已停工的条目不能留在 in_progress。队长先核对最新成员汇报与结束通知，再核实滞后的任务板记录，按需重新分派，避免空等。',
        run.locale === 'en'
          ? "Team brief: this team shares a concise brief. Any member may call read_team_brief; only the leader (and user) may call update_team_brief (max 1500 chars: current goal, locked decisions/guardrails, current stage and artifact paths—never paste long reports). Updates sync incrementally. The user's latest direct instruction always overrides the brief."
          : '团队简报：本队共享一份简短主线简报。成员可用 read_team_brief 查看；仅队长（和用户）可用 update_team_brief 更新（限 1500 字，只写主线目标、已拍板决定与红线、当前阶段与产物路径，不粘贴长报告）。简报变更时系统会自动增量同步。用户最新直接指令始终高于简报。',
        JSON.stringify({ ...this.mentionRoster(run.runId), selfSeatId: seat.seatId }),
      ].join('\n'),
    )
    agent.ctx.systemPrompt.context({
      name: 'role-team-memory',
      order: 0,
      required: true,
      interpolate: false,
      text: () => view().context,
    })
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== agent) return next()
      const decision = await next()
      const selected = view()
      const rev = selected.role.publishedRevision
      const row = current()
      const needsAdoption =
        row.adoptedRoleRev < rev ||
        row.adoptedMemoryRev < rev ||
        row.pendingRoleRev != null ||
        row.pendingMemoryRev != null ||
        row.approved != null
      if (decision.kind === 'enter' && selected.adopting && needsAdoption)
        await index.seats.update(seat.seatId, (s) =>
          s.status === 'active' && s.currentSessionId === agent.id && s.adoptedRoleRev <= rev
            ? {
                ...s,
                adoptedRoleRev: rev,
                adoptedMemoryRev: rev,
                approved: undefined,
                pendingRoleRev: null,
                pendingMemoryRev: null,
              }
            : s,
        )
      if (decision.kind === 'enter') {
        await this.queue.get('seen/' + agent.id)
        const brief = await this.briefs.read(seat.runId)
        const gen = index.generations.get(generationKey(seat.seatId, generation))
        const notices = []
        if (brief?.text.trim() && brief.hash !== gen?.seenBriefHash)
          notices.push(briefNotice(brief, run.locale === 'en'))
        const team = this.getTeam(seat.runId)
        if (team.run.status === 'active' && team.seats.some(other => other.status === 'active' &&
          other.seatId !== seat.seatId && (!row.parentSeatId || other.parentSeatId === seat.seatId))) {
          const notice = policyNotice(team.run, gen?.seenPolicyHash)
          if (notice) notices.push(notice)
        }
        if (notices.length) return { ...decision, messages: [...decision.messages, ...notices] }
      }
      return decision
    })
  }
}
