import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import schema from '@deepseek-ai/schemastery'
import { defaultRoleDir, RoleStore } from './role-store/index.js'
import { repository, teamDomain } from './storage/index.js'
import type { DeleteRequest, EditRequest, FileRef, RoleTeamRpc } from '../shared/index.js'

export interface Config {
  roleStoreDir: string
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    roleTeam: RoleTeamService
  }
}

export default class RoleTeamService extends TypertRemoteService implements RoleTeamRpc {
  static inject = ['storageDomain']
  static Config: schema<Config> = schema.object({ roleStoreDir: schema.string().default(defaultRoleDir()) })
  private readonly root: string
  private roles!: RoleStore
  index!: ReturnType<typeof repository>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'roleTeam')
    this.root = config.roleStoreDir
  }

  protected async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(teamDomain)
    try {
      this.roles = await RoleStore.open(this.root, {
        onError: (error) => this.ctx.logger.warn(String(error)),
      })
    } catch (error) {
      await domain.close()
      throw error
    }
    this.index = repository(domain)
    this.ctx.effect(() => async () => {
      try {
        await this.roles.close()
      } finally {
        await domain.close()
      }
    })
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
    return this.roles.deleteDocument(request)
  }
  @Remote readSnapshot(roleId: string, publishedRevision: number) {
    return this.roles.readSnapshot(roleId, publishedRevision)
  }
  @Remote rescan() {
    return this.roles.rescan()
  }
}
