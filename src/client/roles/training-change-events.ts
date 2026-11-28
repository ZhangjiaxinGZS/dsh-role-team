import type {} from '@deepseek-ai/dsh-tool-executor-ptc/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition, ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { trainingReceipt, type TrainingReceipt } from '../../shared/role-diff.js'

type Change = TrainingReceipt['changes'][number] | { field: 'name' | 'summary' | 'body'; savedText: string }
export type Receipt = { callId: string; seq: number; revision?: number; summary: TrainingReceipt['summary']; changes: Change[] }
const legacy = {
  update_role: ['已保存「', 'Saved role profile', '已保存角色设定'],
  remember_experience: ['已记住经验「', 'Added experience', '新增经验'],
  revise_experience: ['已修订经验「', 'Revised experience', '修订经验'],
} as const

function confirmedText(content: ToolResultNode['content'], prefix: string) {
  return content.some(b => b.type === 'text' && (
    b.text.startsWith(prefix) || b.text === 'Saved to your role profile.' || b.text === '已记入角色档案。'
  ))
}

type Outcome = Pick<ToolResultNode, 'content' | 'error' | 'meta'> & { isError?: boolean }

function receipt(callId: string, seq: number, name: string, args: unknown, result: Outcome): Receipt | null {
  if (!Object.hasOwn(legacy, name) || result.isError || result.error) return null
  if (result.meta !== undefined) {
    const parsed = trainingReceipt.safeParse(result.meta)
    return parsed.success && parsed.data.changes.length ? { ...parsed.data, callId, seq } : null
  }
  const [prefix, en, zh] = legacy[name as keyof typeof legacy]
  if (!confirmedText(result.content, prefix)) return null
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (!args || typeof args !== 'object' || !('body' in args) || typeof args.body !== 'string') return null
  const changes: Change[] = []
  if (name === 'update_role') {
    for (const field of ['name', 'summary', 'body'] as const) {
      const value = (args as Record<string, unknown>)[field]
      if (typeof value === 'string') changes.push({ field, savedText: value })
    }
  } else {
    changes.push({ field: name === 'revise_experience' ? 'revisedExperience' : 'newExperience',
      title: 'title' in args && typeof args.title === 'string' ? args.title : Array.from(args.body.split('\n')[0]).slice(0, 80).join(''), body: args.body })
  }
  return { callId, seq, summary: { en, zh }, changes }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'role-team-training-change': Receipt }
}

function settled(event: SessionEventLike, start?: SessionEventLike): Receipt | null {
  if (event.type === 'tool/ptc-dispatch') {
    const d = event.data
    if (start?.type === 'tool/ptc-dispatch-start' && start.data.name !== d.name) return null
    return receipt(d.subCallId, event.seq, d.name, d.arguments, d)
  }
  if (event.type === 'tool/result' && start?.type === 'tool/call') {
    const { message, error, meta } = event.data
    return receipt(message.source.callId, event.seq, start.data.name, start.data.arguments, { ...message, error, meta })
  }
  return null
}

// A bridge dispatch can settle before the model emits run_code under a different ID.
export const trainingChangeDefinition: ConversationNodeDefinition<Receipt | null> = {
  kind: 'role-team-training-change',
  target: 'chat',
  match(event) {
    if (event.type === 'tool/call' && Object.hasOwn(legacy, event.data.name))
      return { id: event.data.callId, role: 'start' }
    if (event.type === 'tool/result' && (!('surfaceOp' in event) || event.surfaceOp === 'append')) {
      // Native results carry only the call ID. Discard unrelated results before allocating a context.
      const { meta, message } = event.data
      if ((meta && typeof meta === 'object' && 'kind' in meta && meta.kind === 'role-team-change')
        || (meta === undefined && Object.values(legacy).some(([prefix]) => confirmedText(message.content, prefix))))
        return { id: message.source.callId, role: 'update' }
    }
    if ((event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') && Object.hasOwn(legacy, event.data.name))
      return { id: event.data.subCallId, role: 'start' } // A settlement also carries the call arguments on historical windows without a start.
    return null
  },
  start: (_, match) => settled(match.event),
  update: (context, match) => settled(match.event, context.start?.event),
  buildViewNode({ start, state, key, id }) {
    if (!start || !state) return null
    return { key, id, kind: 'role-team-training-change', target: 'chat', anchorSeq: start.event.seq,
      location: start.location, visibility: 'hidden', data: state } satisfies ChatNode<'role-team-training-change'>
  },
}

export function trainingChanges(roots: readonly ToolCallBlock[], projected: readonly Receipt[] = []): Receipt[] {
  const byCall = new Map<string, Receipt>()
  function visit(node: ToolCallBlock) {
    if ('kind' in node && node.kind === 'tool-result' && node.call?.name === node.name) {
      const saved = receipt(node.callId, node.seq, node.name, node.call.argsRaw, node)
      if (saved) byCall.set(saved.callId, saved)
    }
    node.subCalls.forEach(visit)
  }
  roots.forEach(visit)
  for (const r of projected) byCall.set(r.callId, r)
  return [...byCall.values()].sort((a, b) => a.seq - b.seq)
}
