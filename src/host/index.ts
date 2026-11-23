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

  @Remote async listTeams(_request: Input<'listTeams'>) {
    return this.index.runs.list()
  }

  @Remote async getTeam(request: Input<'getTeam'>) {
    const team = this.runtime.getTeam(request.runId)
    await this.runtime.native.retryLegacySessions(team.seats.map((seat) => seat.currentSessionId))
    return team
  }

  @Remote async renameTeam(request: Input<'renameTeam'>) {
    return this.index.runs.update(request.runId, (row) => ({ ...row, title: request.title }))
  }

  @Remote async archiveTeam(request: Input<'archiveTeam'>) {
    return this.runtime.archiveTeam(request.runId)
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
