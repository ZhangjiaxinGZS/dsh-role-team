// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import en from '../locales/en-US.json' with { type: 'json' }
import { registerTrainingChangeTail, TrainingChangeCard, trainingChanges } from '../src/client/roles/TrainingChangeTail.js'
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
  const props = { sessionId: 'ordinary', turn: { turn: 3 },
    useChat: (select: (s: unknown) => unknown) => select({
      locations: { getTurn: (turn: number) => turn === 3 ? ['row'] : [] }, nodes: new Map([['row', { kind: 'tool-call', data: { root: modern } }]]),
    }) } as unknown as Tail
  const view = render(<Slot {...props} />)
  expect(view.container.textContent).toBe('')
  act(() => view.rerender(<Slot {...props} sessionId={'rt-training-test' as Tail['sessionId']} />))
  expect(screen.getByRole('region', { name: en.ui.savedUpdates })).toBeTruthy()
})
