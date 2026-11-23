// @vitest-environment jsdom
import { RoleLibrary } from '../src/client/roles/RoleLibrary.js'
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import en from '../locales/en-US.json' with { type: 'json' }
import { Client, type Seat, type Ui } from '../src/client/ui.js'
import { Workbench } from '../src/client/workbench/Workbench.js'
import { ChildControls, SessionChat, targetId } from '../src/client/workbench/SessionPane.js'
import { LibrarySettings } from '../src/client/App.js'
import { DocumentEditor, Documents } from '../src/client/roles/DocumentEditor.js'
import { TrainingDetail, TrainingPanel } from '../src/client/roles/Training.js'
import { TeamSetup } from '../src/client/team-setup/TeamSetup.js'
import { serializeMarkdown } from '../src/shared/markdown.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
afterEach(cleanup)
const Scope = createContext('')
const seat = (sid: string, parent: string | null): Seat => ({
  seatId: sid,
  runId: 'a',
  parentSeatId: parent,
  roleId: sid,
  displayName: sid,
  currentGeneration: 1,
  currentSessionId: sid + '-session',
  nativeAgentName: sid,
  adoptedRoleRev: 1,
  adoptedMemoryRev: 1,
  pendingRoleRev: null,
  pendingMemoryRev: null,
  status: 'active',
})
function harness(call: ReturnType<typeof vi.fn>) {
  const releases = new Map<string, ReturnType<typeof vi.fn>>(),
    stops = new Map<string, ReturnType<typeof vi.fn>>(),
    approvals = new Set<string>()
  function Chat() {
    const id = useContext(Scope)
    return (
      <SessionChat
        {...({
          sessionId: id,
          useSession: () => true,
          useProjection: () => undefined,
          useSessionStatus: () => approvals.has(id),
          renderFactorySlot: () => (
            <div data-conversation-region="chat">
              stream:{id}
              <ChildControls
                {...({ sessionId: id, useProjection: () => undefined } as unknown as ComponentProps<
                  typeof ChildControls
                >)}
              />
              {approvals.has(id) && <button>approve:{id}</button>}
            </div>
          ),
        } as unknown as ComponentProps<typeof SessionChat>)}
      />
    )
  }
  const ui: Ui = {
    t: (key) => en.ui[key],
    call: call as Ui['call'],
    SessionProvider: ({ session, children }) => (
      <Scope.Provider value={(session as SessionReference).sessionId}>{children}</Scope.Provider>
    ),
    chat: () => <Chat />,
    retain: (target) => {
      const id = targetId(target),
        release = vi.fn(),
        cancel = vi.fn(async () => ({ ok: true, value: undefined }))
      releases.set(id, release)
      stops.set(id, cancel)
      const window = {
        entries: [
          {
            event: {
              seq: 1,
              type: 'user/message',
              data: { content: [{ type: 'text', text: 'history:' + id }] },
            },
          },
        ],
        hasMore: false,
      }
      return {
        sessionId: id,
        ready: Promise.resolve(),
        release,
        binding: {
          session: {
            cancel,
            projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) },
          },
          eventSource: { subscribe: () => () => {}, getSnapshot: () => window },
        },
      } as unknown as SessionReference
    },
  }
  return {
    ui,
    mount: (node: ReactNode) => render(<Client.Provider value={ui}>{node}</Client.Provider>),
    releases,
    stops,
    approvals,
  }
}
it('routes each column, guards the lead, and rebinds reset and read-only history to distinct references', async () => {
  const lead = seat('chief', null)
  let child = { ...seat('scout', 'chief'), pendingMemoryRev: 2 as number | null }
  const run = {
    runId: 'a',
    leaderSeatId: 'chief',
    status: 'active',
    rootSessionId: 'chief-session',
    title: 'Alpha',
  }
  const call = vi.fn(async (method: string, input: any) => {
    switch (method) {
      case 'listTeams':
        return [run]
      case 'getTeam':
        return { run, seats: [lead, child] }
      case 'seatModels':
        return [{ model: 'flash', provider: 'demo', name: 'Flash', efforts: [] }]
      case 'selectSeatModel':
        child = { ...child, selection: input.selection }
        return child
      case 'versionDecision':
        child = { ...child, pendingMemoryRev: null }
        return child
      case 'promptSeat':
        return { accepted: true, sessionId: child.currentSessionId }
      case 'resetSeat':
        child = { ...child, currentGeneration: 2, currentSessionId: 'scout-new' }
        return child
      case 'listGenerations':
        return [
          { sessionId: 'scout-session', generation: 1 },
          { sessionId: 'scout-new', generation: 2 },
        ]
      default:
        throw Error(method + JSON.stringify(input))
    }
  })
  const h = harness(call)
  h.approvals.add('chief-session')
  const view = h.mount(<Workbench roles={[]} />)
  await screen.findByText('stream:scout-session')
  const column = (name: string) => within(document.getElementById('seat-' + name)!)
  expect(column('chief').queryByRole('textbox')).toBeNull()
  expect(column('chief').getByText('approve:chief-session')).toBeTruthy()
  fireEvent.click(column('chief').getByLabelText(en.ui.reset))
  await screen.findByText(en.ui.protectLead)
  fireEvent.click(screen.getByLabelText(en.ui.close))
  const scout = column('scout')
  expect(scout.queryByRole('textbox')).toBeNull()
  expect(scout.queryByRole('combobox')).toBeNull()
  expect(scout.getByText(en.ui.followLeader)).toBeTruthy()
  fireEvent.click(scout.getByTitle(en.ui.chooseModel))
  const picker = within(screen.getByRole('dialog'))
  const option = await picker.findByRole('option', { name: 'demo · Flash' })
  fireEvent.change(picker.getByRole('combobox'), {
    target: { value: (option as HTMLOptionElement).value },
  })
  fireEvent.click(picker.getByText(en.ui.save))
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('selectSeatModel', {
      seatId: 'scout',
      generation: 1,
      selection: { provider: 'demo', model: 'flash', reasoningEffort: undefined },
    }),
  )
  fireEvent.click(scout.getByText(en.ui.next))
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('versionDecision', {
      seatId: 'scout',
      revision: 2,
      decision: 'next-turn',
    }),
  )
  fireEvent.click(scout.getByLabelText(en.ui.reset))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'handoff' } })
  fireEvent.click(dialog.getByRole('button', { name: en.ui.reset }))
  await screen.findByText('stream:scout-new')
  expect(h.releases.get('scout-session')).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('resetSeat', { seatId: 'scout', generation: 1, handoff: 'handoff' })
  fireEvent.click(scout.getByLabelText(en.ui.history))
  await scout.findByRole('option', { name: /G1/ })
  fireEvent.change(scout.getByRole('combobox', { name: en.ui.history }), {
    target: { value: 'scout-session' },
  })
  await scout.findByText('history:scout-session')
  expect(scout.queryByRole('textbox')).toBeNull()
  expect(h.releases.get('scout-new')).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByText(en.ui.focus))
  await waitFor(() => expect(document.querySelectorAll('.rt-column')).toHaveLength(1))
  view.unmount()
  expect(h.releases.get('chief-session')).toHaveBeenCalledOnce()
  expect(h.releases.get('scout-session')).toHaveBeenCalledOnce()
})
it('keeps both versions on a conflict and requires an explicit second save against the disk hash', async () => {
  const initial = {
    text: serializeMarkdown({ id: 'editor', name: 'Editor' }, 'first'),
    hash: 'a'.repeat(64),
  }
  const current = {
      text: serializeMarkdown({ id: 'editor', name: 'Editor' }, 'updated elsewhere'),
      hash: 'b'.repeat(64),
    },
    changed = vi.fn()
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, code: 'conflict', current, proposed: 'mine' })
    .mockResolvedValueOnce({ ok: true, hash: 'c'.repeat(64) })
  harness(call).mount(<DocumentEditor file={{ roleId: 'editor' }} initial={initial} changed={changed} />)
  fireEvent.change(screen.getByLabelText(en.ui.body), { target: { value: 'my body' } })
  fireEvent.click(screen.getByRole('button', { name: en.ui.save }))
  await screen.findByText(en.ui.conflict)
  expect(screen.getByText(/updated elsewhere/)).toBeTruthy()
  expect(call.mock.calls[0][1].expectedHash).toBe(initial.hash)
  fireEvent.click(screen.getByText(en.ui.merge))
  expect(call).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: en.ui.source }))
  const source = screen.getByRole('textbox')
  fireEvent.change(source, { target: { value: '---\nid: [\n---\n' } })
  expect(screen.getByRole('alert').textContent).toMatch(/editor\/role.md · Line \d+/)
  expect((screen.getByText(en.ui.save) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(source, { target: { value: current.text + ' and mine' } })
  fireEvent.click(screen.getByText(en.ui.save))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(call.mock.calls[1][1]).toMatchObject({
    expectedHash: current.hash,
    text: current.text + ' and mine',
  })
})
it('reviews each proposal only in its training session', async () => {
  const proposals = [
    { id: 'one', status: 'pending', diff: '+new role' },
    { id: 'two', status: 'pending', diff: '+habit', memoryId: 'habit' },
  ]
  const call = vi.fn(async (method: string, input: { proposalId?: string }) => {
    if (method === 'getTraining') return { sessionId: 'training', proposals: [...proposals] }
    proposals.find((p) => p.id === input.proposalId)!.status =
      method === 'confirmProposal' ? 'confirmed' : 'rejected'
    return { ok: true }
  })
  const changed = vi.fn()
  harness(call).mount(<TrainingDetail trainingId="train-id" changed={changed} />)
  const first = (await screen.findByText('+new role')).closest('article')!,
    second = screen.getByText('+habit').closest('article')!
  fireEvent.click(within(first).getByText(en.ui.approve))
  await waitFor(() => expect(screen.queryByText('+new role')).toBeNull())
  fireEvent.click(within(second).getByText(en.ui.reject))
  await waitFor(() => expect(screen.queryByText(en.ui.proposals)).toBeNull())
  expect(changed).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('confirmProposal', { trainingId: 'train-id', proposalId: 'one' })
  expect(call).toHaveBeenCalledWith('rejectProposal', { trainingId: 'train-id', proposalId: 'two' })
})
it('retries partial team setup without creating a second root and preserves nested parents', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ run: { runId: 'alpha', leaderSeatId: 'root' } })
    .mockResolvedValueOnce({ seatId: 'sub' })
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValueOnce({ seatId: 'leaf' })
  const done = vi.fn()
  harness(call).mount(
    <TeamSetup
      roles={['chief', 'deputy', 'staff'].map((id) => ({ id, name: id, revision: 1 }))}
      close={() => {}}
      onDone={done}
    />,
  )
  fireEvent.change(screen.getByLabelText(en.ui.name), { target: { value: 'Alpha' } })
  fireEvent.change(screen.getByPlaceholderText('/workspace/project'), { target: { value: '/project' } })
  fireEvent.click(screen.getByLabelText('deputy'))
  fireEvent.click(screen.getByLabelText('staff'))
  fireEvent.change(screen.getByLabelText('staff · ' + en.ui.parent), { target: { value: 'deputy' } })
  fireEvent.click(screen.getByText(en.ui.create))
  await screen.findByText('offline')
  fireEvent.click(screen.getByText(en.ui.retry))
  await waitFor(() => expect(done).toHaveBeenCalledOnce())
  expect(call.mock.calls.map((c) => c[0])).toEqual(['createTeam', 'addMember', 'addMember', 'addMember'])
  expect(call.mock.calls[3][1]).toMatchObject({ roleId: 'staff', parentSeatId: 'sub' })
})

it('edits a memory through draft, published and archived metadata without changing its identity', async () => {
  const file = { roleId: 'editor', memoryId: 'review' }
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, hash: 'a'.repeat(64) })
    .mockResolvedValueOnce({ ok: true, hash: 'b'.repeat(64) })
  harness(call).mount(<DocumentEditor file={file} initial={null} changed={() => {}} />)
  const status = screen.getByLabelText(en.ui.status)
  expect((status as HTMLSelectElement).value).toBe('draft')
  fireEvent.change(screen.getByLabelText(en.ui.memoryTitle), { target: { value: 'Review habit' } })
  fireEvent.change(status, { target: { value: 'published' } })
  fireEvent.click(screen.getByText(en.ui.save))
  await screen.findByText(en.ui.saved)
  expect(call.mock.calls[0][1]).toMatchObject({
    ...file,
    expectedHash: null,
    text: expect.stringContaining('status: published'),
  })
  fireEvent.change(status, { target: { value: 'archived' } })
  fireEvent.click(screen.getByText(en.ui.save))
  await waitFor(() =>
    expect(call.mock.calls[1][1]).toMatchObject({
      ...file,
      expectedHash: 'a'.repeat(64),
      text: expect.stringContaining('status: archived'),
    }),
  )
})
it('loads notes only for the selected team and releases the old root on a switch', async () => {
  const runs = ['alpha', 'beta'].map((id) => ({
    runId: id,
    title: id,
    status: 'active',
    rootSessionId: id + '-session',
    leaderSeatId: id,
  }))
  const notes: Record<string, string[]> = { alpha: ['ALPHA-9527'], beta: [] }
  const call = vi.fn(async (method: string, input: { runId: string; content: string }) => {
    switch (method) {
      case 'listTeams':
        return runs
      case 'getTeam':
        return { run: runs.find((r) => r.runId === input.runId), seats: [seat(input.runId, null)] }
      case 'listNotes':
        return notes[input.runId].map((content, n) => ({ content, noteId: String(n) }))
      case 'addNote':
        notes[input.runId].push(input.content)
        return {}
      default:
        throw new Error(method)
    }
  })
  const h = harness(call)
  h.mount(<Workbench roles={[]} />)
  await screen.findByText('stream:alpha-session')
  fireEvent.click(screen.getByText(en.ui.board))
  await screen.findByText('ALPHA-9527')
  fireEvent.change(screen.getByLabelText(en.ui.chooseTeam), { target: { value: 'beta' } })
  await screen.findByText('stream:beta-session')
  expect(screen.queryByText('ALPHA-9527')).toBeNull()
  fireEvent.click(screen.getByText(en.ui.board))
  fireEvent.change(screen.getByLabelText(en.ui.newNote), { target: { value: 'Beta only' } })
  fireEvent.click(screen.getByRole('button', { name: en.ui.add }))
  await screen.findByText('Beta only')
  expect(call).toHaveBeenCalledWith('addNote', { runId: 'beta', content: 'Beta only' })
  expect(h.releases.get('alpha-session')).toHaveBeenCalledOnce()
})
it('shows the effective library and writes the next path against the native settings revision', async () => {
  let configured = '/roles'
  const h = harness(vi.fn(async () => ({ activePath: '/roles', configuredPath: configured })))
  const write = vi.fn(async (path) => {
    configured = path
  })
  h.ui.settings = { read: async () => ({ revision: 5, writable: true }), write }
  h.mount(<LibrarySettings />)
  await screen.findByDisplayValue('/roles')
  fireEvent.change(screen.getByLabelText(en.ui.configured), { target: { value: '/next' } })
  fireEvent.click(screen.getByText(en.ui.save))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/next', 5))
  expect(screen.getByText('/roles')).toBeTruthy()
})

it('creates and publishes the named role before opening its first independent conversation', async () => {
  const changed = vi.fn()
  const call = vi.fn(async (method: string) => {
    if (method === 'saveDocument') return { ok: true }
    if (method === 'createTraining') return { roleId: 'author', trainingId: 't' }
    if (method === 'getTraining') return { sessionId: 's' }
    return method === 'readDocument' ? null : []
  })
  harness(call).mount(<RoleLibrary roles={[]} changed={changed} />)
  fireEvent.click(screen.getByRole('button', { name: /New role/ }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.change(form.getByLabelText(en.ui.name), { target: { value: 'Author' } })
  fireEvent.click(form.getByText(en.ui.create))
  await screen.findByText('stream:s')
  expect(call.mock.calls[0]).toEqual([
    'saveDocument',
    expect.objectContaining({
      roleId: 'author',
      expectedHash: null,
      text: expect.stringContaining('name: Author'),
    }),
  ])
  expect(changed).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('createTraining', { roleId: 'author', mode: 'coach' })
})

it('starts coaching immediately and only offers team selection for a debrief', async () => {
  const row = { trainingId: 't', sessionId: 'coach-session', roleId: 'author', mode: 'coach' }
  const call = vi.fn(async (method: string) => {
    if (method === 'listTrainings') return []
    if (method === 'listTeams') return [{ runId: 'run', title: 'Review team', status: 'active' }]
    return row
  })
  harness(call).mount(<TrainingPanel roleId="author" hasRole changed={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: en.ui.newTraining }))
  await screen.findByText('stream:coach-session')
  expect(call).toHaveBeenCalledWith('createTraining', { roleId: 'author', mode: 'coach' })
  expect(call).not.toHaveBeenCalledWith('listTeams', {})
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.ui.debrief }))
  const modal = within(screen.getByRole('dialog'))
  await modal.findByRole('option', { name: 'Review team' })
  expect(modal.queryByRole('textbox')).toBeNull()
  expect((modal.getByRole('combobox') as HTMLSelectElement).value).toBe('')
  fireEvent.change(modal.getByRole('combobox'), { target: { value: 'run' } })
  fireEvent.click(modal.getByRole('button', { name: en.ui.startTraining }))
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('createTraining', {
      roleId: 'author',
      mode: 'debrief',
      sourceRunId: 'run',
    }),
  )
})

it('records a plain-language experience with one field, including for a legacy training-only role', async () => {
  const changed = vi.fn()
  const call = vi.fn(async (method: string) => (method === 'rememberExperience' ? 'note-id' : null))
  harness(call).mount(<Documents roleId="scout" revision={null} changed={changed} />)
  fireEvent.click(screen.getByRole('button', { name: en.ui.newMemory }))
  fireEvent.change(screen.getByLabelText(en.ui.experienceBody), {
    target: { value: '  Check the source.  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: en.ui.remember }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(call).toHaveBeenCalledWith('rememberExperience', { roleId: 'scout', body: 'Check the source.' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(en.ui.savedDirty)).toBeNull()
  expect(screen.queryByLabelText(en.ui.memoryTitle)).toBeNull()
})

it('rebinds the only visible training chat and releases the previous session', async () => {
  let current = { roleId: 'scout', trainingId: 'old', sessionId: 'previous' }
  const call = vi.fn(async (method: string) => {
    if (method === 'listTrainings') return [current]
    if (method === 'createTraining') current = { ...current, trainingId: 'new', sessionId: 'fresh' }
    return current
  })
  const h = harness(call)
  h.mount(<TrainingPanel roleId="scout" hasRole changed={() => {}} />)
  await screen.findByText('stream:previous')
  fireEvent.click(screen.getByRole('button', { name: en.ui.newTraining }))
  await screen.findByText('stream:fresh')
  expect(screen.queryByText('stream:previous')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(h.releases.get('previous')).toHaveBeenCalledOnce()
})
