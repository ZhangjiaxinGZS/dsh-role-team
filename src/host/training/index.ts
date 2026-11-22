import { randomUUID } from 'node:crypto'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { directory } from '../role-store/files.js'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { fileId, roleMeta, memoryMeta, type IndexRecord } from '../../shared/index.js'
import type { Input } from '../../shared/runtime.js'
import { RoleStore } from '../role-store/index.js'
import { digest, parseMarkdown, serializeMarkdown } from '../role-store/markdown.js'
import type { Index } from '../storage/index.js'
import { trainingTools, workspacePath } from '../isolation/index.js'
import type { NativeTeam } from '../team-runtime/native.js'

type Training = IndexRecord<'training_sessions'>
type Proposal = NonNullable<Training['proposals']>[number]
const text = z.string().trim().min(1).max(24000)
const inputs = [
  z.strictObject({ name: z.string().min(1).max(160), body: text }),
  z.strictObject({ title: z.string().min(1).max(160), body: text }),
  z.strictObject({ content: text.max(8000) }),
] as const
function diff(before: string, after: string) {
  const old = before.split('\n'),
    next = after.split('\n')
  let start = 0,
    end = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  while (end < old.length - start && end < next.length - start && old.at(-1 - end) === next.at(-1 - end))
    end++
  return [
    '@@ -' +
      (start + 1) +
      ',' +
      (old.length - start - end) +
      ' +' +
      (start + 1) +
      ',' +
      (next.length - start - end) +
      ' @@',
    ...old.slice(start, old.length - end).map((s) => '-' + s),
    ...next.slice(start, next.length - end).map((s) => '+' + s),
  ].join('\n')
}

export class TrainingRuntime {
  constructor(
    readonly index: Index,
    readonly roles: RoleStore,
    readonly native: NativeTeam,
    readonly addNote: (request: Input<'addNote'>) => Promise<IndexRecord<'team_local_notes'>>,
  ) {}
  async createTraining(input: Input<'createTraining'>) {
    const { mode, sourceRunId } = input
    const roleId = fileId.parse(input.roleId)
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
    return row
  }
  getTraining(id: string) {
    const row = this.index.training.get(id)
    if (!row) throw new Error('Training session not found')
    return row
  }
  async install(agent: Agent, row: Training) {
    const status = (await this.roles.listRoles()).find((r) => r.roleId === row.roleId)
    const snapshot = status?.publishedRevision
      ? await this.roles.readSnapshot(row.roleId, status.publishedRevision)
      : undefined
    agent.ctx.systemPrompt.section({
      name: 'role-team-role',
      order: 0,
      complete: true,
      interpolate: false,
      text: [
        'Role training (' +
          row.mode +
          '). Propose lasting changes for human confirmation. Scope temporary notes to the designated team.',
        snapshot?.role.body,
        ...(snapshot?.memories.map((m) => m.body) ?? []),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 32000),
    })
    trainingTools.forEach((name, i) =>
      agent.ctx.tools.register({
        name,
        description: [
          'Propose a complete revised role name and Markdown body for review.',
          'Propose one long-term memory for human review.',
          'Record a temporary note for the linked team only.',
        ][i],
        parameters: z.toJSONSchema(inputs[i]),
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async (args, exec) => {
          exec.signal.throwIfAborted()
          if (exec.agent !== agent) throw new Error('Training session mismatch')
          if (name === 'record_temporary_note') {
            const { content } = inputs[2].parse(args)
            if (!row.sourceRunId) throw new Error('Choose a source team to record a temporary note')
            return (await this.addNote({ runId: row.sourceRunId, content })).noteId
          }
          const proposal =
            name === 'propose_role_update'
              ? await this.roleProposal(row, inputs[0].parse(args))
              : await this.memoryProposal(row, inputs[1].parse(args))
          await this.index.training.update(row.trainingId, (state) => ({
            ...state,
            proposals: [...(state.proposals ?? []), proposal],
          }))
          if (proposal.memoryId && (await this.roles.readDocument({ roleId: row.roleId })))
            await this.materializeDraft(row.roleId, proposal)
          return proposal.id
        },
      }),
    )
  }
  private async roleProposal(row: Training, input: { name: string; body: string }): Promise<Proposal> {
    const current = await this.roles.readDocument({ roleId: row.roleId })
    const meta = current
      ? parseMarkdown(current.text, roleMeta, row.roleId, 'role.md').meta
      : { id: row.roleId }
    const next = serializeMarkdown({ ...meta, name: input.name }, input.body)
    return {
      id: randomUUID(),
      before: current?.text ?? null,
      text: next,
      expectedHash: current?.hash ?? null,
      diff: diff(current?.text ?? '', next),
      status: 'pending',
    }
  }
  private async memoryProposal(
    row: Training,
    input: { title: string; body: string },
  ): Promise<Proposal> {
    const id = randomUUID()
    const meta = {
      id,
      title: input.title,
      status: 'draft',
      scope: 'role_long_term',
      createdAt: new Date().toISOString(),
      source: 'training:' + row.trainingId,
    }
    const draft = serializeMarkdown(meta, input.body)
    // During role creation the reviewed draft stays in the training row until role.md exists.
    const parsed = parseMarkdown(draft, memoryMeta, id, 'memory.md')
    const next = serializeMarkdown({ ...parsed.meta, status: 'published' }, parsed.body)
    return {
      id,
      memoryId: id,
      before: draft,
      text: next,
      expectedHash: digest(draft),
      diff: diff(draft, next),
      status: 'pending',
    }
  }
  private async materializeDraft(roleId: string, proposal: Proposal) {
    if (!proposal.memoryId || proposal.before === null) return
    const ref = { roleId, memoryId: proposal.memoryId }
    if (!(await this.roles.readDocument(ref))) {
      const edit = await this.roles.saveDocument({ ...ref, expectedHash: null, text: proposal.before })
      if (!edit.ok && edit.code !== 'conflict') throw new Error('Could not create the memory candidate')
    }
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
      expectedHash: item.expectedHash,
      text: item.text,
    })
    if (!result.ok && result.code === 'conflict' && result.current?.text === item.text) {
      const status = (await this.roles.listRoles()).find((r) => r.roleId === row.roleId)!
      result = { ok: true, hash: result.current.hash, status }
    }
    if (result.ok && result.status.error === null) {
      if (!item.memoryId && item.expectedHash === null) {
        for (const pending of this.getTraining(trainingId).proposals ?? []) {
          if (pending.status === 'pending' && pending.memoryId)
            await this.materializeDraft(row.roleId, pending)
        }
      }
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
