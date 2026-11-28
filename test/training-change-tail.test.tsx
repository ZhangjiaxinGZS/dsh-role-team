// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeAssembler as Assembler, ConversationNodeDefinition, ConversationViewDefinition, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import en from '../locales/en-US.json' with { type: 'json' }
import { registerTrainingChangeTail, TrainingChangeCard } from '../src/client/roles/TrainingChangeTail.js'
import { trainingChangeDefinition, trainingChanges } from '../src/client/roles/training-change-events.js'
import type { Ui } from '../src/client/ui.js'

afterEach(cleanup)
const t: Ui['t'] = key => en.ui[key]
function result(name: string, args: object, text = '', override: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq: 1, callId: name, name, time: 1, callTime: 0,
    args: {} as ToolResultNode['args'], call: { name, argsRaw: JSON.stringify(args) }, isError: false,
    content: [{ type: 'text', text }], subCalls: [], ...override }
}
const modern = result('update_role', { name: 'Writer', body: 'Same body' }, '', {
  meta: { kind: 'role-team-change', revision: 8, summary: { zh: '更新名称', en: 'Updated name' },
    changes: [{ field: 'name', hunks: [{ start: 1, lines: ['-Editor', '+Writer'] }] }] },
})
const oldMemory = result('remember_experience', { body: 'Use primary sources.' }, '已记住经验「Use primary sources.」。')
it('renders only confirmed fields and expands and collapses a compact change item', () => {
  render(<TrainingChangeCard receipts={trainingChanges([modern, oldMemory])} t={t} />)
  expect(screen.getByText('v8')).toBeTruthy()
  expect(screen.queryByText(en.ui.body)).toBeNull()
  const item = screen.getByText(en.ui.name).closest('details')!
  expect(item.open).toBe(false)
  fireEvent.click(item.querySelector('summary')!)
  expect(item.open).toBe(true)
  expect(within(item).getByText('-Editor')).toBeTruthy()
  fireEvent.click(item.querySelector('summary')!)
  expect(item.open).toBe(false)
  expect(screen.getByText(en.ui.newExperience, { selector: 'b' })).toBeTruthy()
})
it('pairs historical saved receipts with native or nested calls and never infers a save from arguments alone', () => {
  const old = result('update_role', { body: 'Saved instructions' }, '已保存「Editor」的角色设定。')
  const revised = result('revise_experience', { title: 'Sources', body: 'New lesson' }, '已修订经验「Sources」。')
  const root = result('run_code', {}, '', { subCalls: [old, oldMemory, revised] })
  expect(trainingChanges([root]).map(r => r.changes[0])).toEqual([
    { field: 'body', savedText: 'Saved instructions' },
    { field: 'newExperience', title: 'Use primary sources.', body: 'Use primary sources.' },
    { field: 'revisedExperience', title: 'Sources', body: 'New lesson' },
  ])
  for (const generic of ['Saved to your role profile.', '已记入角色档案。']) {
    expect(trainingChanges([{ ...old, content: [{ type: 'text', text: generic }] }])[0].changes[0])
      .toEqual({ field: 'body', savedText: 'Saved instructions' })
  }
  expect(trainingChanges([{ ...modern, isError: true }, { ...old, call: null }, { ...old, content: [] },
    { ...old, meta: null }, { ...old, call: { name: 'update_role', argsRaw: '{' } },
    { ...old, error: { name: 'failed', code: 'failed', reason: 'not saved' } }])).toEqual([])
})
it('mounts only for training sessions and reads settled calls from the selected turn', () => {
  type Tail = PropsRuntime<'conversation.chat.turnTail'>
  let Slot!: ComponentType<Tail>
  const register = vi.fn((_info, view) => { Slot = view })
  registerTrainingChangeTail({ slots: { inject: (_slot: string, init: () => void) => init(), register } } as unknown as Context, { t })
  expect(register.mock.calls[0][0].name).toBe('conversation.chat.turnTail')
  const calls = [{ root: modern }], empty: never[] = []
  const props = { sessionId: 'ordinary', turn: { turn: 3 },
    useChat: (select: (s: unknown) => unknown) => select({
      nodes: { turnDataSource: (turn: number, kind: string) => ({
        subscribe: () => () => {}, getSnapshot: () => turn === 3 && kind === 'tool-call' ? calls : empty,
      }) },
    }) } as unknown as Tail
  const view = render(<Slot {...props} />)
  expect(view.container.textContent).toBe('')
  act(() => view.rerender(<Slot {...props} sessionId={'rt-training-test' as Tail['sessionId']} />))
  expect(screen.getByRole('region', { name: en.ui.savedUpdates })).toBeTruthy()
})

// Use the installed host's projection engine and Chat definitions without booting its client app.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  notifySubscribers: (listeners: Iterable<() => void>) => { for (const notify of listeners) notify() },
}))
const { ConversationNodeAssembler } = await vi.importActual<{ ConversationNodeAssembler: typeof Assembler }>(
  '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts')
const { chatViewDefinition } = await vi.importActual<{ chatViewDefinition: ConversationViewDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')
const { toolDefinition } = await vi.importActual<{ toolDefinition: ConversationNodeDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/tool.ts')

type Entry = [type: string, data: Record<string, unknown>]
function dispatch(root: string, sub: number, name: string, args: object, outcome: object): Entry[] {
  const call = { rootCallId: root, parentCallId: root, subCallId: root + ':ptc:' + sub, name, arguments: args }
  return [['tool/ptc-dispatch-start', call], ['tool/ptc-dispatch', { ...call, isError: false, content: [], ...outcome }]]
}
function history(turn: number, events: Entry[], mode: 'live' | 'replay' = 'replay') {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [toolDefinition, trainingChangeDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  const rows: Entry[] = [['turn/start', { turn }], ['step/start', { turn, step: 1 }], ...events,
    ['turn/end', { turn, reason: { kind: 'completed' } }]]
  const entries = rows.map(([type, data], seq) => ({ type: 'event', event: { type, data, seq: seq + 1, time: seq + 1, ...(type === 'tool/result' && { surfaceOp: 'append' }) } }) as SessionEventLikeEntry)
  assembler.replaceWindow(mode === 'live' ? [] : entries, false)
  assembler.activateTarget('chat')
  if (mode === 'live') {
    for (const entry of entries) assembler.append(entry)
    assembler.flush()
  }
  const snapshot = assembler.get('chat')!
  type Tail = PropsRuntime<'conversation.chat.turnTail'>
  let Slot!: ComponentType<Tail>
  registerTrainingChangeTail({ slots: { inject: (_: string, init: () => void) => init(),
    register: (_: unknown, view: ComponentType<Tail>) => { Slot = view } } } as unknown as Context, { t })
  const props = { sessionId: 'rt-training-fixture', turn: { turn }, useChat: (select: (s: typeof snapshot) => unknown) => select(snapshot) } as unknown as Tail
  const view = render(<Slot {...props} />)
  return { snapshot, otherTurn: () => view.rerender(<Slot {...props} turn={{ ...props.turn, turn: turn + 1 }} />) }
}

it.each(['live', 'replay'] as const)('shows only confirmed bridge writes in turn 8 with an unrelated mirrored run_code (%s)', mode => {
  const root = 'agy-mcp-8', run = 'agytc-8'
  const saved = (revision: number, changes: object[]) => ({
    meta: { kind: 'role-team-change', revision, summary: { en: 'Saved', zh: '已保存' }, changes },
  })
  const memory = { field: 'newExperience', title: 'Source', body: 'Check the citation' }
  const { snapshot, otherTurn } = history(8, [
    ...dispatch(root, 1, 'update_role', { body: 'Role' }, saved(24, [
      { field: 'body', hunks: [{ start: 1, lines: ['+Role'] }] },
      { field: 'name', hunks: [{ start: 1, lines: ['+Editor'] }] },
    ])),
    ...dispatch(root, 2, 'remember_experience', { body: 'Failed note' }, {
      ...saved(90, [{ ...memory, body: 'Failed note' }]), isError: true }),
    ...dispatch(root, 3, 'remember_experience', { body: memory.body }, saved(25, [memory])),
    ['tool/call', { turn: 8, step: 1, callId: run, name: 'run_code', arguments: '{}' }],
  ], mode)
  expect(snapshot.nodes.turnDataSource(8, 'tool-call').getSnapshot()[0].root.subCalls).toEqual([])
  expect(snapshot.nodes.values().filter(n => n.kind === trainingChangeDefinition.kind).map(n => n.visibility)).toEqual(['hidden', 'hidden'])
  const card = screen.getByRole('region', { name: en.ui.savedUpdates })
  expect(within(card).getByText('v24 · v25')).toBeTruthy()
  expect(card.querySelectorAll('details')).toHaveLength(3)
  expect(card.textContent).not.toMatch(/Failed note|v90/)
  otherTurn()
  expect(screen.queryByRole('region')).toBeNull()
})

it('replays an orphan legacy dispatch using the object arguments and confirmation text', () => {
  history(7, [
    ...dispatch('agy-mcp-7', 1, 'revise_experience', { title: 'Sources', body: 'Read the original.' },
      { content: [{ type: 'text', text: '已修订经验「Sources」。' }] }),
    ...dispatch('agy-mcp-7', 2, 'remember_experience', { body: 'No changes' },
      { content: [{ type: 'text', text: '已记入角色档案。' }], meta: null }),
  ])
  expect(screen.getByText('Read the original.')).toBeTruthy()
  expect(screen.queryByText('No changes')).toBeNull()
})

it('merges direct and parented PTC results by invocation ID in settlement order', () => {
  const direct = { turn: 4, step: 1, callId: 'direct', name: 'update_role', arguments: '{"body":"Direct edit"}' }
  const { snapshot } = history(4, [
    ['tool/call', direct],
    ['tool/call', { ...direct, callId: 'parent', name: 'run_code', arguments: '{}' }],
    ...dispatch('parent', 1, 'remember_experience', { body: 'Nested note' },
      { content: [{ type: 'text', text: '已记入角色档案。' }] }),
    ['tool/result', { turn: 4, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'direct' },
      content: [{ type: 'text', text: 'Saved to your role profile.' }] } }],
  ])
  expect(snapshot.nodes.turnDataSource(4, 'role-team-training-change').getSnapshot()).toHaveLength(2)
  const calls = snapshot.nodes.turnDataSource(4, 'tool-call').getSnapshot()
  expect(trainingChanges(calls.map(c => c.root))).toHaveLength(2)
  const rows = screen.getByRole('region').querySelectorAll('details')
  expect(Array.from(rows, row => row.querySelector('.rt-saved-text')?.textContent)).toEqual(['Nested note', 'Direct edit'])
})

it('recovers a self-contained historical settlement and ignores unfinished calls and failure details', () => {
  const missingStart = dispatch('old-bridge', 1, 'remember_experience', { body: 'Archived note' }, {
    content: [{ type: 'text', text: '已记住经验「Archived note」。' }],
  })[1]
  history(5, [
    missingStart,
    dispatch('old-bridge', 2, 'update_role', { body: 'Pending' }, {})[0],
    ...dispatch('old-bridge', 3, 'update_role', { body: 'Conflicting' }, {
      error: { name: 'Conflict', code: 'conflict' }, content: [{ type: 'text', text: '已保存「X」的角色设定。' }],
    }),
    ['tool/result', { turn: 5, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'unknown' },
      content: [{ type: 'text', text: 'Saved to your role profile.' }] } }],
  ])
  expect(screen.getByRole('region').querySelectorAll('details')).toHaveLength(1)
  expect(screen.getByRole('region').textContent).toContain('Archived note')
})
