import { randomUUID } from 'node:crypto'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { directory } from '../role-store/files.js'
import { z } from 'zod'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { fileId, roleMeta, memoryMeta, type EditResult, type IndexRecord } from '../../shared/index.js'
import type { Input } from '../../shared/runtime.js'
import { RoleStore } from '../role-store/index.js'
import { digest, parseMarkdown, serializeMarkdown } from '../role-store/markdown.js'
import type { Index } from '../storage/index.js'
import { trainingTools, workspacePath, installRolePrompt } from '../isolation/index.js'
import type { NativeTeam } from '../team-runtime/native.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'role-team-update': { kind: 'role-team-update' } & ContextFormed
  }
}
type Training = IndexRecord<'training_sessions'>
const reportChanges =
  '更新工具执行成功后，必须在本轮最终回复正文中用中文向用户简要总结具体改动。分别说明改动的设定、新增或修订的经验；只列实际成功的改动。'
const text = z.string().trim().min(1).max(24000)
const inputs = [
  z.strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    summary: roleMeta.shape.summary,
    body: text,
  }),
  z.strictObject({ body: text }),
  z.strictObject({ memoryId: fileId, title: z.string().trim().min(1).max(160), body: text }),
] as const
function saved(result: EditResult) {
  if (!result.ok)
    throw new Error(
      result.code === 'conflict'
        ? 'Role changed during editing. Read the current settings and retry.'
        : result.error.message,
    )
  if (result.status.error) throw new Error(result.status.error.message)
  return result
}

export class TrainingRuntime {
  constructor(
    readonly index: Index,
    readonly roles: RoleStore,
    readonly native: NativeTeam,
  ) {}
  current(roleId?: string) {
    const rows = this.index.training.list().filter((r) => !r.initializing)
    const superseded = new Set(rows.flatMap((r) => r.replaces ?? []))
    return rows.filter((r) => !superseded.has(r.trainingId) && (!roleId || roleId === r.roleId))
  }
  private async retirePrevious(row: Training) {
    if (!row.replaces?.length) return
    for (const id of row.replaces) {
      const old = this.index.training.get(id)
      if (!old || old.roleId !== row.roleId || old.trainingId === row.trainingId) continue
      await this.archiveTraining(old)
    }
    await this.index.training.update(row.trainingId, (state) => ({ ...state, replaces: undefined }))
  }
  private async archiveTraining(row: Training) {
    try {
      await this.native.archive(row.sessionId)
    } catch (error) {
      if (!(error instanceof Error && error.name === 'WorkspaceUnknownSessionError')) throw error
    }
    await this.index.training.delete(row.trainingId)
  }
  private async endRoleTraining(roleId: string) {
    for (const row of this.index.training.list())
      if (row.roleId === roleId) await this.archiveTraining(row)
  }
  async deleteRole(request: Input<'deleteRole'>) {
    const result = await this.roles.retireRole(request, this.current(request.roleId).length > 0)
    if (result.ok) await this.endRoleTraining(request.roleId)
    return result
  }
  async listTrainings(roleId?: string) {
    const rows = this.current(roleId)
    const retired = new Set<string>()
    for (const id of new Set(rows.map((row) => row.roleId)))
      if (await this.roles.isRetired(id)) retired.add(id)
    return rows.filter((row) => !retired.has(row.roleId))
  }
  async recover(roleId: string) {
    if (await this.roles.isRetired(roleId)) return this.endRoleTraining(roleId)
    for (const row of this.index.training.list()) {
      if (row.roleId !== roleId || !row.initializing) continue
      if (await this.native.exists(row.sessionId)) {
        await this.index.training.update(row.trainingId, (state) => ({
          ...state,
          initializing: undefined,
        }))
      } else {
        await this.index.training.delete(row.trainingId)
      }
    }
    for (const row of this.current(roleId)) await this.retirePrevious(row)
  }
  async openTraining(request: Input<'openTraining'>) {
    const current = (await this.listTrainings(request.roleId)).at(-1)
    if (
      current &&
      !this.native.ctx.workspaceRegistry.archivedSessionIds.some((id) => id === current.sessionId)
    ) {
      await this.native.retryLegacySessions([current.sessionId])
      return current
    }
    return this.createTraining({
      ...request,
      mode: current && !(await this.roles.readDocument({ roleId: request.roleId })) ? 'create' : 'coach',
    })
  }
  async createTraining(input: Input<'createTraining'>) {
    const { mode, sourceRunId } = input
    const roleId = fileId.parse(input.roleId)
    if (await this.roles.isRetired(roleId)) throw new Error('Role ID is retired: ' + roleId)
    if (sourceRunId && this.index.runs.get(sourceRunId)?.status !== 'active')
      throw new Error('Unknown active team')
    if (mode !== 'create' && !(await this.roles.readDocument({ roleId })))
      throw new Error('Role must exist for coaching')
    const row: Training = {
      trainingId: randomUUID(),
      sessionId: 'rt-training-' + randomUUID(),
      roleId,
      mode,
      sourceRunId,
      locale: input.locale,
      initializing: true,
      replaces: this.index.training
        .list()
        .filter((r) => r.roleId === roleId)
        .map((r) => r.trainingId),
    }
    await this.index.training.put(row)
    let sandbox: string | undefined
    try {
      let cwd: string
      if (input.workspaceCwd !== undefined) {
        cwd = await workspacePath(input.workspaceCwd, this.roles.root)
      } else {
        // Keep the directory for the lifetime of the native session, including cold restores.
        if (dirname(this.roles.root) === this.roles.root)
          throw new Error('A filesystem root cannot have a separate sibling training sandbox')
        const parent = this.roles.root + '.training-sandboxes'
        await directory(parent, true)
        const roleSandbox = join(await workspacePath(parent, this.roles.root), roleId)
        await directory(roleSandbox, true)
        sandbox = await mkdtemp(join(await workspacePath(roleSandbox, this.roles.root), 'session-'))
        cwd = sandbox
      }
      await this.native.create(row.sessionId, cwd)
    } catch (error) {
      await this.index.training.delete(row.trainingId)
      if (sandbox) await rmdir(sandbox)
      throw error
    }
    await this.index.training.update(row.trainingId, (state) => ({ ...state, initializing: undefined }))
    await this.retirePrevious(row)
    return this.getTraining(row.trainingId)
  }
  getTraining(id: string) {
    const row = this.current().find((r) => r.trainingId === id)
    if (!row) throw new Error('Training session not found')
    return row
  }
  async rememberExperience(roleId: string, body: string, title?: string) {
    const content = text.parse(body)
    const ref = { roleId: fileId.parse(roleId), memoryId: 'note-' + digest(content).slice(0, 32) }
    if (!(await this.roles.readDocument({ roleId }))) {
      if (!this.current(roleId).length) throw new Error('Role not found')
      const created = await this.roles.saveDocument({
        roleId,
        expectedHash: null,
        text: serializeMarkdown({ id: roleId, name: roleId }, ''),
      })
      if (!created.ok && created.code !== 'conflict') saved(created)
    }
    const current = await this.roles.readDocument(ref)
    const entry = current && parseMarkdown(current.text, memoryMeta, ref.memoryId, 'memory.md')
    if (entry && entry.body !== content)
      throw new Error('This experience was edited. Review the existing entry.')
    if (entry) return ref.memoryId
    const meta = {
      id: ref.memoryId,
      title: title ?? Array.from(content.split('\n')[0]).slice(0, 80).join(''),
      scope: 'role_long_term',
      createdAt: new Date().toISOString(),
    }
    const result = await this.roles.saveDocument({
      ...ref,
      expectedHash: current?.hash ?? null,
      text: serializeMarkdown(meta, content),
    })
    if (!result.ok && result.code === 'conflict' && result.current) {
      const concurrent = parseMarkdown(result.current.text, memoryMeta, ref.memoryId, 'memory.md')
      if (concurrent.body === content) return ref.memoryId
    }
    saved(result)
    return ref.memoryId
  }
  async install(agent: Agent, row: Training) {
    const ref = { roleId: row.roleId }
    let base = await this.roles.readDocument(ref)
    const loadSnapshot = async () => {
      const status = (await this.roles.listRoles()).find((r) => r.roleId === row.roleId)
      return status?.publishedRevision
        ? this.roles.readSnapshot(row.roleId, status.publishedRevision)
        : undefined
    }
    let snapshot = await loadSnapshot()
    let pendingTurn = -1
    let remindedTurn = -1
    const receipts = new Set<string>()
    agent.ctx.on('session/event', (session, event) => {
      if (
        session !== agent.session ||
        event.type !== 'assistant/message' ||
        pendingTurn !== event.data.turn
      )
        return
      if (
        event.data.message.content.some(
          (block) => block.type === 'text' && /\p{Script=Han}/u.test(block.text),
        )
      )
        receipts.clear()
    })
    agent.ctx.on('agent/turn-stopping', ({ agent: owner, turn, signal }) => {
      if (
        owner !== agent ||
        signal.aborted ||
        turn !== pendingTurn ||
        turn === remindedTurn ||
        !receipts.size
      )
        return
      remindedTurn = turn
      const summary = Array.from(receipts).join(' ')
      agent.steer(
        createUserMessage({
          source: { kind: 'role-team-update', form: 'notice', summary },
          content: [
            { type: 'text', text: summary + ' ' + reportChanges + ' 已保存，无需重复调用工具。' },
          ],
        }),
      )
    })
    installRolePrompt(agent, () =>
      [
        row.locale === 'en'
          ? 'Reply in English. In this private coaching chat, update your own role with update_role when learning a lasting responsibility or preference. Preserve unrelated settings. Keep the current role name unless the user explicitly requests a rename. Use remember_experience for reusable lessons and revise_experience to correct a saved lesson. Report successful profile changes in Chinese. Keep one-off requests and team-specific details out of the role profile.'
          : '请用中文回复。在这次一对一培养中，学到持久的职责或偏好时，用 update_role 直接更新自己的角色设定，保留其他设定。只有用户明确要求改名才传 name，不要使用 lead、root 等系统名称。值得复用的经验用 remember_experience 记住，纠正已有经验用 revise_experience。写入成功后简短告诉用户记住了什么。临时要求和团队专属细节留在本次对话或关联团队。',
        reportChanges,
        snapshot?.role.meta.name ?? row.roleId,
        snapshot?.role.meta.summary,
        snapshot?.role.body,
        ...(snapshot?.memories.map((m) => '[' + m.meta.id + '] ' + m.meta.title + '\n' + m.body) ?? []),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 32000),
    )
    trainingTools.forEach((name, i) =>
      agent.ctx.tools.register({
        name,
        description: [
          'Save the complete revised role instructions. Omit name unless the user explicitly asks to rename this role. Never copy a system agent name such as lead or root. Use summary for a short one-line duty to introduce yourself to the team. Preserve existing responsibilities unless corrected.',
          'Remember a durable lesson for this role. Supply the lesson in plain text.',
          'Correct one saved lesson by its memoryId from your profile. Supply its revised title and full content.',
        ][i],
        // Zod also attaches a non-enumerable ~standard validator. PTC accepts only JSON data.
        parameters: { ...z.toJSONSchema(inputs[i]) },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async (args, exec) => {
          exec.signal.throwIfAborted()
          if (
            exec.agent !== agent ||
            !this.current(row.roleId).some((t) => t.trainingId === row.trainingId)
          )
            throw new Error('Training session mismatch')
          let receipt: string
          if (name === 'update_role') {
            const { name: displayName, summary, body } = inputs[0].parse(args)
            const meta = base
              ? parseMarkdown(base.text, roleMeta, row.roleId, 'role.md').meta
              : { id: row.roleId, name: row.roleId }
            if (displayName && displayName !== meta.name && /^(lead|root)$/i.test(displayName))
              throw new Error(
                row.locale === 'en'
                  ? 'Reserved system name. Omit name to keep the current role name.'
                  : '系统名称不能用于改名。省略 name 即可保留当前角色名称。',
              )
            const next = serializeMarkdown(
              { ...meta, name: displayName ?? meta.name, ...(summary !== undefined && { summary }) },
              body,
            )
            const result = await this.roles.saveDocument({
              ...ref,
              text: next,
              expectedHash: base?.hash ?? null,
            })
            if (!result.ok && result.code === 'conflict') {
              base = result.current
              snapshot = await loadSnapshot()
              throw new Error(
                'Role changed. Merge your updates with these current settings: ' + (base?.text ?? ''),
              )
            }
            const { hash } = saved(result)
            base = { text: next, hash: hash! }
            receipt = '已保存「' + (displayName ?? meta.name) + '」的角色设定。'
          } else if (name === 'revise_experience') {
            const { memoryId, title, body } = inputs[2].parse(args)
            const known = snapshot?.memories.find((m) => m.meta.id === memoryId)
            if (!known) throw new Error('Unknown published experience for this role')
            const file = await this.roles.readDocument({ ...ref, memoryId })
            const current = file && parseMarkdown(file.text, memoryMeta, memoryId, 'memory.md')
            if (
              !file ||
              !current ||
              current.body !== known.body ||
              current.meta.title !== known.meta.title
            ) {
              snapshot = await loadSnapshot()
              throw new Error('The experience changed. Check the updated role profile before editing.')
            }
            saved(
              await this.roles.saveDocument({
                ...ref,
                memoryId,
                expectedHash: file.hash,
                text: serializeMarkdown({ ...current.meta, title }, body),
              }),
            )
            receipt = '已修订经验「' + title + '」。'
          } else {
            const { body } = inputs[1].parse(args)
            await this.rememberExperience(row.roleId, body)
            receipt = '已记住经验「' + Array.from(body.split('\n')[0]).slice(0, 80).join('') + '」。'
          }
          snapshot = await loadSnapshot()
          const turn = agent.ctx.agents.turnBoundaryOf(agent.session).lastTurn
          if (turn !== pendingTurn) receipts.clear()
          pendingTurn = turn
          receipts.add(receipt)
          return receipt + reportChanges
        },
      }),
    )
  }
  async confirmProposal({ trainingId, proposalId }: Input<'confirmProposal'>) {
    const row = this.getTraining(trainingId)
    const item = row.proposals?.find((p) => p.id === proposalId)
    if (!item || item.status === 'rejected')
      throw new Error('Proposal unavailable in this training session')
    const ref = { roleId: row.roleId, memoryId: item.memoryId }
    if (item.status === 'confirmed') {
      const current = await this.roles.readDocument(ref)
      if (current?.text !== item.text)
        return { ok: false as const, code: 'conflict' as const, current, proposed: item.text }
      const status = (await this.roles.listRoles()).find((r) => r.roleId === row.roleId)!
      return { ok: true as const, status, hash: current.hash }
    }
    if (item.memoryId && !(await this.roles.readDocument({ roleId: row.roleId })))
      throw new Error('Confirm the role before publishing its first memory')
    let result = await this.roles.saveDocument({
      ...ref,
      expectedHash:
        item.memoryId && item.before !== null && !(await this.roles.readDocument(ref))
          ? null
          : item.expectedHash,
      text: item.text,
    })
    if (!result.ok && result.code === 'conflict' && result.current?.text === item.text) {
      const status = (await this.roles.listRoles()).find((r) => r.roleId === row.roleId)!
      result = { ok: true, hash: result.current.hash, status }
    }
    if (result.ok && result.status.error === null) {
      await this.index.training.update(trainingId, (state) => ({
        ...state,
        proposals: state.proposals?.map((p) =>
          p.id === proposalId ? { ...p, status: 'confirmed' } : p,
        ),
      }))
    }
    return result
  }
}
