import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { IndexRecord, RoleStatus, Snapshot } from '../../shared/index.js'
import type { Input } from '../../shared/runtime.js'
import { RoleStore } from '../role-store/index.js'
import { generationKey, type Index } from '../storage/index.js'
import { isolate, workspacePath } from '../isolation/index.js'
import { TrainingRuntime } from '../training/index.js'
import { replaceSeat } from '../seat-reset/index.js'
import { NativeTeam } from './native.js'

export type Seat = IndexRecord<'team_seats'>
export class TeamRuntime {
  readonly training: TrainingRuntime
  private readonly queue = new Map<string, Promise<unknown>>()
  private readonly cache = new Map<string, Snapshot>()
  constructor(
    readonly index: Index,
    readonly roles: RoleStore,
    readonly native: NativeTeam,
  ) {
    this.training = new TrainingRuntime(index, roles, native, (input) => this.addNote(input))
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
  async observe(status: RoleStatus) {
    const rev = status.publishedRevision
    if (!rev) return
    for (const seat of this.index.seats.list()) {
      if (
        seat.roleId !== status.roleId ||
        rev <= Math.max(seat.seenRevision ?? 0, seat.adoptedRoleRev, seat.pendingRoleRev ?? 0) ||
        seat.status === 'archived'
      )
        continue
      await this.index.seats.update(seat.seatId, (current) =>
        rev <= Math.max(current.seenRevision ?? 0, current.adoptedRoleRev, current.pendingRoleRev ?? 0)
          ? current
          : { ...current, pendingRoleRev: rev, pendingMemoryRev: rev },
      )
    }
  }
  seat(id: string) {
    const row = this.index.seats.get(id)
    if (!row) throw new Error('Seat not found')
    return row
  }
  getTeam(runId: string) {
    const run = this.index.runs.get(runId)
    if (!run) throw new Error('Team not found')
    return { run, seats: this.index.seats.list().filter((s) => s.runId === runId) }
  }
  active(runId: string) {
    const { run } = this.getTeam(runId)
    if (run.status !== 'active') throw new Error('Team is not active')
    return run
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
      nativeAgentName: parentSeatId ? 's-' + seatId.slice(0, 12) + '-1' : 'lead',
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
      workspaceCwd: cwd,
      rootSessionId,
      leaderSeatId: seatId,
      status: 'creating',
      createdAt: new Date().toISOString(),
    })
    try {
      await this.reserve(runId, null, snap, undefined, seatId, rootSessionId)
      await this.native.create(rootSessionId, cwd)
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
        )
      } catch (error) {
        await this.index.seats.update(seat.seatId, (s) => ({ ...s, status: 'archived' }))
        throw error
      }
      return this.index.seats.update(seat.seatId, ({ joining, ...ready }) => ready)
    })
  }
  /** Restore interrupted creation intents before the next UI operation addresses their seats. */
  async recover() {
    for (const run of this.index.runs.list()) {
      if (run.status === 'creating') {
        const leader = this.index.seats.get(run.leaderSeatId)
        if (!leader) {
          await this.index.runs.update(run.runId, (r) => ({ ...r, status: 'failed' }))
          continue
        }
        if (!(await this.native.exists(run.rootSessionId)))
          await this.native.create(run.rootSessionId, run.workspaceCwd)
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
          )
          await this.index.seats.update(seat.seatId, ({ joining, ...ready }) => ready)
        })
      }
    }
  }
  archiveTeam(runId: string) {
    return this.ordered(runId, async () => {
      const { run, seats } = this.getTeam(runId)
      if (
        run.status !== 'archived' &&
        (run.status === 'active' || (await this.native.exists(run.rootSessionId)))
      )
        await this.native.archive(run.rootSessionId)
      for (const s of seats)
        await this.index.seats.update(s.seatId, (value) => ({ ...value, status: 'archived' }))
      return this.index.runs.update(runId, (r) => ({ ...r, status: 'archived' }))
    })
  }
  async addNote(input: Input<'addNote'>) {
    this.active(input.runId)
    if (input.seatId && this.seat(input.seatId).runId !== input.runId)
      throw new Error('Seat belongs to another team')
    const note = { ...input, noteId: randomUUID(), createdAt: new Date().toISOString() }
    await this.index.notes.put(note)
    return note
  }
  async versionDecision(input: Input<'versionDecision'>) {
    const { seatId, revision, decision } = input
    const seat = this.seat(seatId)
    this.active(seat.runId)
    await this.snapshot(seat.roleId, revision)
    return this.index.seats.update(seatId, (row) => {
      if (row.status !== 'active' || row.pendingRoleRev !== revision)
        throw new Error('Pending revision changed. Refresh the seat.')
      const agent = this.native.ctx.agents.get(row.currentSessionId as SessionId)
      const afterTurn = agent ? this.native.ctx.agents.turnBoundaryOf(agent.session).lastTurn : 0
      return {
        ...row,
        seenRevision: revision,
        approved: decision === 'next-turn' ? { revision, afterTurn } : row.approved,
        pendingRoleRev: null,
        pendingMemoryRev: null,
      }
    })
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
  async attach(agent: Agent) {
    const { index } = this
    const training = index.training.list().find((t) => t.sessionId === agent.id)
    if (training) {
      isolate(agent, true, () => !!index.training.get(training.trainingId))
      agent.ctx.systemPrompt.suppressRuntimeContext()
      await this.training.install(agent, training)
      return
    }
    const seat = index.seats
      .list()
      .find((s) => s.currentSessionId === agent.id || s.reset?.sessionId === agent.id)
    if (!seat) {
      if (agent.id.startsWith('rt-') || agent.session.header.parentSession?.startsWith('rt-'))
        throw new Error('Managed session has no current binding')
      return
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
    isolate(agent, false, active)
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== agent) return next()
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
          return { kind: 'deny', reason: 'Target is not an active seat in this team' }
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
    if (seat.approved) await this.snapshot(seat.roleId, seat.approved.revision)
    let frozen:
      | { turn: number; role: Snapshot; memory: Snapshot; context: string; adopting: boolean }
      | undefined
    const view = () => {
      const turn = this.native.ctx.agents.turnBoundaryOf(agent.session).lastTurn
      if (frozen?.turn === turn) return frozen
      const row = current()
      const replacement = row.reset?.sessionId === agent.id ? row.reset.revision : undefined
      const selected =
        replacement ??
        (row.approved && turn > row.approved.afterTurn ? row.approved.revision : undefined)
      const read = (revision: number) => {
        const s = this.cache.get(row.roleId + '/' + revision)
        if (!s) throw new Error('Required role snapshot is unavailable')
        return s
      }
      const role = read(selected ?? row.adoptedRoleRev),
        memory = read(selected ?? row.adoptedMemoryRev)
      const previous =
        generation > 1 ? index.generations.get(generationKey(row.seatId, generation - 1)) : undefined
      const notes =
        generation > 1 && turn <= 1
          ? []
          : index.notes
              .list()
              .filter(
                (n) =>
                  n.runId === row.runId &&
                  (!n.seatId || n.seatId === row.seatId) &&
                  (!previous || (previous.archivedAt && n.createdAt > previous.archivedAt)),
              )
      const context = [
        memory.memories
          .map((m) => m.meta.title + '\n' + m.body)
          .join('\n')
          .slice(0, 16000),
        history.handoffNote,
        notes
          .map((n) => n.content)
          .join('\n')
          .slice(-8000),
      ]
        .filter(Boolean)
        .join('\n\n')
      return (frozen = {
        turn,
        role,
        memory,
        context,
        adopting: replacement === undefined && selected !== undefined,
      })
    }
    agent.ctx.systemPrompt.suppressRuntimeContext()
    agent.ctx.systemPrompt.section({
      name: 'role-team-role',
      order: 0,
      complete: true,
      interpolate: false,
      text: () => view().role.role.body,
    })
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
      if (decision.kind === 'enter' && selected.adopting && current().adoptedRoleRev < rev)
        await index.seats.update(seat.seatId, (s) =>
          s.status === 'active' && s.currentSessionId === agent.id && s.adoptedRoleRev < rev
            ? {
                ...s,
                adoptedRoleRev: rev,
                adoptedMemoryRev: rev,
                approved: s.approved?.revision === rev ? undefined : s.approved,
              }
            : s,
        )
      return decision
    })
  }
}
