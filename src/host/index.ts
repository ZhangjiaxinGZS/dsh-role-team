import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import schema from '@deepseek-ai/schemastery'
import { TeamRuntime } from './team-runtime/index.js'
import { NativeTeam } from './team-runtime/native.js'
import type { Input } from '../shared/runtime.js'
import { defaultRoleDir, RoleStore } from './role-store/index.js'
import { repository, teamDomain } from './storage/index.js'
import type { DeleteRequest, EditRequest, FileRef, RoleTeamRpc } from '../shared/index.js'

export interface Config {
  roleStoreDir: Volatile<string>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    roleTeam: RoleTeamService
  }
}

export default class RoleTeamService extends TypertRemoteService implements RoleTeamRpc {
  static inject = ['storageDomain']
  static Config = schema.object({
    roleStoreDir: schema
      .string()
      .pattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
      .default(defaultRoleDir())
      .volatile(),
  })
  private readonly pathSetting: Volatile<string>
  private roles!: RoleStore
  private mounted?: TeamRuntime
  private get runtime() {
    if (!this.mounted) throw new Error('Role team runtime is not ready')
    return this.mounted
  }
  index!: ReturnType<typeof repository>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'roleTeam')
    this.pathSetting = config.roleStoreDir
    ctx.on('agent/created', async ({ agent }) => {
      const reserved = (id?: string) => id !== undefined && /^rt-(?:root|child|training)-/.test(id)
      if (!reserved(agent.id) && !reserved(agent.session.header.parentSession)) return
      await this.runtime.attach(agent)
    })
  }

  protected async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(teamDomain)
    try {
      this.roles = await RoleStore.open(this.pathSetting.get(), {
        onError: (error) => this.ctx.logger.warn(String(error)),
      })
    } catch (error) {
      await domain.close()
      throw error
    }
    this.ctx.effect(() => async () => {
      try {
        await this.roles.close()
      } finally {
        await domain.close()
      }
    })
    this.index = repository(domain)
    await this.ctx.inject(
      [
        'llm',
        'agents',
        'sessionController',
        'sessionQuery',
        'sessionPersistence',
        'agentTeams',
        'subagents',
        'workspaceRegistry',
        'tools',
        'systemPrompt',
      ],
      async (host) => {
        const native = new NativeTeam(host)
        const sessionIds = new Set([
          ...this.index.training.list().map((training) => training.sessionId),
          ...this.index.generations.list().map((generation) => generation.sessionId),
          ...this.index.runs.list().map((run) => run.rootSessionId),
          ...this.index.seats
            .list()
            .flatMap((seat) => [seat.currentSessionId, ...(seat.reset ? [seat.reset.sessionId] : [])]),
        ])
        for (const id of sessionIds) await native.prepareLegacySession(id)
        const runtime = new TeamRuntime(this.index, this.roles, native)
        this.mounted = runtime
        host.effect(() => () => {
          if (this.mounted === runtime) this.mounted = undefined
        })
        runtime.observeSessions()
        await runtime.recover()
        await this.roles.rescan()
      },
    )
  }

  @Remote async createTeam(request: Input<'createTeam'>) {
    return this.runtime.createTeam(request)
  }

  @Remote async listTeams(request: Input<'listTeams'>) {
    const runs = this.index.runs.list()
    if (!request.includeMemberCounts) return runs
    const archived = new Set(runs.filter(run => run.status === 'archived').map(run => run.runId))
    const counts = new Map<string, number>()
    for (const seat of this.index.seats.list()) {
      if (seat.status !== 'archived' || archived.has(seat.runId))
        counts.set(seat.runId, (counts.get(seat.runId) ?? 0) + 1)
    }
    return runs.map(run => ({ ...run, memberCount: counts.get(run.runId) ?? 0 }))
  }

  @Remote async teamMentionRoster({ sessionId }: Input<'teamMentionRoster'>) {
    const seat = this.index.seats.list().find(s => s.currentSessionId === sessionId && s.status === 'active')
    if (!seat || this.index.runs.get(seat.runId)?.status !== 'active') return null
    return this.runtime.mentionRoster(seat.runId)
  }

  @Remote async teamMessageSender({ sessionId, senderId, senderName }: Input<'teamMessageSender'>) {
    const generations = this.index.generations.list()
    const receiver = generations.find(g => g.sessionId === sessionId)
    const seat = receiver && this.index.seats.get(receiver.seatId)
    if (!seat) return null

    const members = new Map(this.runtime.getTeam(seat.runId).seats.map(s =>
      [s.seatId, this.roles.published(s.roleId)?.role.meta.name ?? s.displayName] as const,
    ))
    const candidates = generations.filter(g => members.has(g.seatId))
    const exact = candidates.find(g => g.sessionId === senderId)
    if (exact) return { name: members.get(exact.seatId)! }
    // Collaboration names are unique among siblings, but can repeat in different branches.
    const matches = new Set(candidates.filter(g => g.nativeAgentName === senderName).map(g => g.seatId))
    const [only] = matches
    return { name: matches.size === 1 ? members.get(only)! : null }
  }

  @Remote async getTeam(request: Input<'getTeam'>) {
    const team = this.runtime.getTeam(request.runId)
    await this.runtime.native.retryLegacySessions(team.seats.map((seat) => seat.currentSessionId))
    return team
  }

  @Remote async renameTeam(request: Input<'renameTeam'>) {
    return this.index.runs.update(request.runId, (row) => ({ ...row, title: request.title }))
  }

  @Remote async teamSchedules({ runId }: Input<'teamSchedules'>) {
    return this.runtime.schedules.list(runId)
  }
  @Remote async createTeamSchedule(request: Input<'createTeamSchedule'>) {
    return this.runtime.schedules.create(request)
  }
  @Remote async changeTeamSchedule(request: Input<'changeTeamSchedule'>) {
    return this.runtime.schedules.change(request)
  }
  @Remote async teamScheduleHistory(request: Input<'teamScheduleHistory'>) {
    return this.runtime.schedules.history(request)
  }
  @Remote async teamArchiveImpact({ runId }: Input<'teamArchiveImpact'>) {
    return this.runtime.archiveImpact(runId)
  }
  @Remote async archiveTeam(request: Input<'archiveTeam'>) {
    return this.runtime.archiveTeam(request.runId, request.expectedActiveSchedules)
  }

  @Remote async deleteTeam({ runId }: Input<'deleteTeam'>) {
    return this.runtime.deleteTeam(runId)
  }

  @Remote async addMember(request: Input<'addMember'>) {
    return this.runtime.addMember(request)
  }

  @Remote async versionDecision(request: Input<'versionDecision'>) {
    return this.runtime.versionDecision(request)
  }

  @Remote async promptSeat(request: Input<'promptSeat'>) {
    return this.runtime.promptSeat(request)
  }

  @Remote async seatModels(_request: Input<'seatModels'>) {
    return this.runtime.native.models()
  }
  @Remote async selectSeatModel(request: Input<'selectSeatModel'>) {
    return this.runtime.selectSeatModel(request)
  }

  @Remote async resetSeat(request: Input<'resetSeat'>) {
    return this.runtime.resetSeat(request)
  }

  @Remote async listGenerations(request: Input<'listGenerations'>) {
    return this.index.generations
      .list()
      .filter((g) => g.seatId === request.seatId)
      .sort((a, b) => a.generation - b.generation)
  }

  @Remote async rememberExperience({ roleId, body, title }: Input<'rememberExperience'>) {
    return this.runtime.training.rememberExperience(roleId, body, title)
  }

  @Remote async openTraining(request: Input<'openTraining'>) {
    return this.runtime.ordered('training/' + request.roleId, () =>
      this.runtime.training.openTraining(request),
    )
  }
  @Remote async createTraining(request: Input<'createTraining'>) {
    return this.runtime.ordered('training/' + request.roleId, () =>
      this.runtime.training.createTraining(request),
    )
  }

  @Remote async getTraining(request: Input<'getTraining'>) {
    const row = await this.runtime.training.getTraining(request.trainingId)
    await this.runtime.native.retryLegacySessions([row.sessionId])
    return row
  }

  @Remote async listTrainings(request: Input<'listTrainings'>) {
    return this.runtime.training.listTrainings(request.roleId)
  }

  @Remote async confirmProposal(request: Input<'confirmProposal'>) {
    return this.runtime.ordered('review/' + request.trainingId, () =>
      this.runtime.training.confirmProposal(request),
    )
  }

  @Remote async libraryInfo(_request: Input<'libraryInfo'>) {
    return { activePath: this.roles.root, configuredPath: this.pathSetting.get() }
  }

  @Remote async rejectProposal({ trainingId, proposalId }: Input<'rejectProposal'>) {
    return this.runtime.ordered('review/' + trainingId, () =>
      this.index.training.update(trainingId, (row) => {
        const proposal = row.proposals?.find((p) => p.id === proposalId)
        if (!proposal || proposal.status === 'confirmed')
          throw new Error('Proposal is unavailable for rejection')
        return {
          ...row,
          proposals: row.proposals?.map((p) => (p.id === proposalId ? { ...p, status: 'rejected' } : p)),
        }
      }),
    )
  }

  @Remote createRole({ name, summary }: Input<'createRole'>) {
    return this.roles.createRole(name, summary)
  }
  @Remote async deleteRole(request: Input<'deleteRole'>) {
    return this.runtime.ordered('training/' + request.roleId, () =>
      this.runtime.training.deleteRole(request),
    )
  }
  @Remote async roleHistory({ roleId }: Input<'roleHistory'>) {
    return this.roles.roleHistory(roleId)
  }
  @Remote async restoreRole({ roleId, revision, expectedHash }: Input<'restoreRole'>) {
    return this.roles.restoreRole(roleId, revision, expectedHash)
  }
  @Remote listRoles() {
    return this.roles.listRoles()
  }
  @Remote listMemories(roleId: string) {
    return this.roles.listMemories(roleId)
  }
  @Remote readDocument(ref: FileRef) {
    return this.roles.readDocument(ref)
  }
  @Remote saveDocument(request: EditRequest) {
    return this.roles.saveDocument(request)
  }
  @Remote deleteDocument(request: DeleteRequest) {
    return request.memoryId === undefined && this.mounted
      ? this.deleteRole(request)
      : this.roles.deleteDocument(request)
  }
  @Remote readSnapshot(roleId: string, publishedRevision: number) {
    return this.roles.readSnapshot(roleId, publishedRevision)
  }
  @Remote rescan() {
    return this.roles.rescan()
  }
}
