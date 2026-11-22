import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-team'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { ModelChoice } from '../../shared/index.js'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Input } from '../../shared/runtime.js'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace'

export class NativeTeam {
  constructor(readonly ctx: Context) {}
  async models() {
    const catalog = await this.ctx.sessionController.modelCatalog()
    return catalog.groups.flatMap((group) =>
      group.models.map((model) => ({
        provider: group.id,
        model: model.id,
        name: model.name,
        efforts: (model.reasoning?.efforts ?? []).map(({ id, name }) => ({ id, name })),
      })),
    )
  }
  select(agent: Agent, choice: ModelChoice) {
    agent.model.select(choice as Parameters<Agent['model']['select']>[0])
  }
  followPermission(rootId: string, child: Agent, saved?: string) {
    const presets = this.ctx.get('permissionPresets')
    if (!presets) return
    const leader = this.ctx.agents.get(rootId as SessionId)
    const mode = leader ? presets.current(leader.session) : saved
    if (!mode) throw new Error('Team leader permission is unavailable')
    if (mode === 'custom') throw new Error('Select a team permission preset on the lead')
    presets.set(child.session, mode)
  }
  async exists(id: string) {
    try {
      return await this.ctx.sessionQuery.inspectSession(id as SessionId, () => true)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
        return false
      throw error
    }
  }
  async create(id: string, cwd: string) {
    const result = await this.ctx.sessionController.create({
      sessionId: id as SessionId,
      cwd,
      agentPreset: 'role-team',
    })
    if (result.sessionId !== id) throw new Error('Session identity changed during creation')
  }
  async root(id: string) {
    const result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result) throw result.error
    return result.agent
  }
  async enable(id: string) {
    await this.ctx.agentTeams.setEnabled(await this.root(id), true)
  }
  async prompt(id: string, child: boolean, input: Input<'promptSeat'>) {
    const requestId = input.requestId as SessionPromptRequest['requestId']
    const sessionId = id as SessionId
    const content = [{ type: 'text' as const, text: input.text }]
    const signal = new AbortController().signal
    if (child)
      await this.ctx.subagents.prompt(
        { requestId, childSessionId: sessionId, delivery: input.delivery, content },
        signal,
      )
    else
      await this.ctx.sessionController.prompt(
        { requestId, sessionId, mode: input.delivery, content },
        signal,
      )
    return { accepted: true as const, sessionId: id }
  }
  async archive(id: string) {
    const live = this.ctx.agents.get(id as SessionId)
    await this.ctx.workspaceRegistry.archiveSession(id as SessionId, { stopActivity: true })
    await live?.whenIdle()
  }
  async spawn(
    rootId: string,
    parentId: string,
    childId: string,
    name: string,
    label: string,
    locale: 'zh' | 'en' = 'zh',
  ) {
    const root = await this.root(rootId)
    const catalog = await this.ctx.subagents.listDescendants(root.id)
    const existing = catalog.find((entry) => entry.id === childId)
    if (existing) {
      if (existing.kind === 'child' && existing.parentId === parentId && existing.mode === 'continuable')
        return
      throw new Error('Reserved session has conflicting native membership')
    }
    let parent: Agent | undefined = this.ctx.agents.get(parentId as SessionId)
    if (!parent) {
      // A cold intermediate leader must rejoin the native tree before it can create a child.
      await this.ctx.subagents.sendMessage(
        root,
        parentId as SessionId,
        [
          {
            type: 'text',
            text:
              locale === 'zh' ? '即将有新成员加入，请待命。' : 'Stand by for a team membership change.',
          },
        ],
        { signal: new AbortController().signal },
      )
      parent = this.ctx.agents.get(parentId as SessionId)
    }
    if (!parent || this.ctx.subagents.rootOf(parent).id !== root.id)
      throw new Error('Team parent is unavailable')
    const provider = this.ctx.subagents.getProvider('spawn')
    if (!provider?.prepareContinuable || provider.inheritsParentContext !== false)
      throw new Error('Fresh continuable spawn provider required')
    const activation = await this.ctx.subagents.startActivation({
      parent,
      childId: childId as SessionId,
      name,
      label,
      provider: 'spawn',
      delivery: 'parent',
      maxDepth: 8,
      signal: new AbortController().signal,
      prompt: [
        {
          type: 'text',
          text:
            locale === 'zh'
              ? '你已加入团队，请用中文简短报到，并等待队长安排。'
              : 'You have joined the team. Acknowledge briefly in English and wait for your assignment.',
        },
      ],
    })
    void activation.result.catch((error) => this.ctx.logger.warn(String(error)))
  }
  async transfer(rootId: string, oldId: string, newId: string) {
    const root = await this.root(rootId)
    for (let attempt = 0; attempt < 16; attempt++) {
      const tasks = this.ctx.agentTeams
        .listTasks(root)
        .filter((t) => t.ownerId === oldId && (t.status === 'pending' || t.status === 'in_progress'))
      if (!tasks.length) return
      for (const task of tasks) {
        try {
          await this.ctx.agentTeams.updateTask(root, {
            action: 'reassign',
            taskId: task.id,
            expectedRevision: task.revision,
            owner: newId as SessionId,
          })
        } catch (error) {
          const current = this.ctx.agentTeams.listTasks(root).find((t) => t.id === task.id)
          if (current?.revision === task.revision) throw error
        }
      }
    }
    throw new Error('Task board is changing. Retry this generation to finish the transfer.')
  }
}
