import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useMemo } from 'react'
import { trainingReceipt, type TrainingReceipt } from '../../shared/role-diff.js'
import type { Ui } from '../ui.js'
import { DiffLines, fieldLabels } from './RoleDiffView.js'

type Tail = PropsRuntime<'conversation.chat.turnTail'>
type Change = TrainingReceipt['changes'][number] | { field: 'name' | 'summary' | 'body'; savedText: string }
type Receipt = { callId: string; revision?: number; summary: TrainingReceipt['summary']; changes: Change[] }
const legacy = {
  update_role: ['已保存「', 'Saved role profile', '已保存角色设定'],
  remember_experience: ['已记住经验「', 'Added experience', '新增经验'],
  revise_experience: ['已修订经验「', 'Revised experience', '修订经验'],
} as const

function fromResult(node: ToolResultNode): Receipt | undefined {
  if (node.isError || node.error || !node.call || !Object.hasOwn(legacy, node.name) || node.name !== node.call.name) return
  if (node.meta !== undefined) {
    const result = trainingReceipt.safeParse(node.meta)
    if (result.success && result.data.changes.length) return { ...result.data, callId: node.callId }
    return
  }
  // Old tools rendered string receipts. Their arguments identify saved content,
  // but cannot establish a prior value or revision.
  const [prefix, en, zh] = legacy[node.name as keyof typeof legacy]
  const confirmed = node.content.some(b => b.type === 'text' && (
    b.text.startsWith(prefix) || b.text === 'Saved to your role profile.' || b.text === '已记入角色档案。'
  ))
  if (!confirmed) return
  let parsed: unknown
  try { parsed = JSON.parse(node.call.argsRaw) } catch { return }
  if (!parsed || typeof parsed !== 'object') return
  const args = parsed as Record<string, unknown>
  if (typeof args.body !== 'string') return
  const changes: Change[] = []
  if (node.name === 'update_role') {
    for (const field of ['name', 'summary', 'body'] as const) {
      if (typeof args[field] === 'string') changes.push({ field, savedText: args[field] })
    }
  } else {
    changes.push({ field: node.name === 'revise_experience' ? 'revisedExperience' : 'newExperience',
      title: typeof args.title === 'string' ? args.title : Array.from(args.body.split('\n')[0]).slice(0, 80).join(''), body: args.body })
  }
  return { callId: node.callId, summary: { en, zh }, changes }
}

// Native chat nodes correlate durable tool/call and tool/result events, including nested PTC dispatches.
export function trainingChanges(roots: readonly ToolCallBlock[]): Receipt[] {
  const results: ToolResultNode[] = []
  function visit(node: ToolCallBlock) {
    if ('kind' in node && node.kind === 'tool-result') results.push(node)
    node.subCalls.forEach(visit)
  }
  roots.forEach(visit)
  return results.sort((a, b) => a.seq - b.seq).flatMap(node => fromResult(node) ?? [])
}

export function TrainingChangeCard({ receipts, t, language = 'en' }: Pick<Ui, 't' | 'language'> & { receipts: Receipt[] }) {
  if (!receipts.length) return null
  const versions = [...new Set(receipts.flatMap(r => r.revision ? ['v' + r.revision] : []))]
  return <section className="rt-change-card" aria-label={t('savedUpdates')}>
    <header><strong>{t('savedUpdates')}</strong>{versions.length > 0 && <small>{versions.join(' · ')}</small>}</header>
    <p>{[...new Set(receipts.map(r => r.summary[language]))].join(' · ')}</p>
    {receipts.flatMap(r => r.changes.map(change =>
      <details key={r.callId + '/' + change.field}>
        <summary><b>{t(fieldLabels[change.field])}</b>{'title' in change && <span>{change.title}</span>}</summary>
        {'hunks' in change ? <DiffLines hunks={change.hunks} /> :
          <div className="rt-saved-text">{'savedText' in change ? change.savedText || '—' : change.body}</div>}
      </details>))}
  </section>
}

export function registerTrainingChangeTail(ctx: Context, ui: Pick<Ui, 't' | 'language'>) {
  function TrainingTail({ turn, useChat }: Tail) {
    const roots = useChat(s => s.locations.getTurn(turn.turn).flatMap(key => {
      const node = s.nodes.get(key) as ChatNode | undefined
      return node?.kind === 'tool-call' ? [node.data.root] : []
    }), (a, b) => a.length === b.length && a.every((v, i) => v === b[i]))
    const receipts = useMemo(() => trainingChanges(roots), [roots])
    return <TrainingChangeCard receipts={receipts} t={ui.t} language={ui.language} />
  }
  function TailSlot(props: Tail) {
    return props.sessionId.startsWith('rt-training-') ? <TrainingTail {...props} /> : null
  }
  const slot = 'conversation.chat.turnTail'
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'dsh-role-team.training-changes' }, TailSlot))
}
