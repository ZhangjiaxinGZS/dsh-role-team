// @vitest-environment jsdom
import { RoleLibrary } from '../src/client/roles/RoleLibrary.js'
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import en from '../locales/en-US.json' with { type: 'json' }
import { Client, type Seat, type Ui } from '../src/client/ui.js'
import { Workbench } from '../src/client/workbench/Workbench.js'
import {
  ChildControls,
  ChildPermission,
  SessionChat,
  targetId,
} from '../src/client/workbench/SessionPane.js'
import { LibrarySettings } from '../src/client/App.js'
import { DocumentEditor, Documents } from '../src/client/roles/DocumentEditor.js'
import { TrainingDetail, TrainingPanel } from '../src/client/roles/Training.js'
import { TeamSetup } from '../src/client/team-setup/TeamSetup.js'
import { serializeMarkdown } from '../src/shared/markdown.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
// The browser supplies the shared menu. Exercise the catalog and selection callbacks here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconDataOutlineRegular: () => null,
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => (
    <span title={label}>{children}</span>
  ),
  IconChevronDownOutlineRegular: () => null,
  Menu: ({
    anchor,
    open,
    items,
    onSelect,
  }: {
    anchor: ReactNode
    open: boolean
    items: { id: string; submenu?: { id: string; label: string }[] }[]
    onSelect: (id: string) => void
  }) => (
    <>
      {anchor}
      {open && (
        <div role="menu">
          {items
            .flatMap((i) => i.submenu ?? [])
            .map((i) => (
              <button key={i.id} role="menuitem" onClick={() => onSelect(i.id)}>
                {i.label}
              </button>
            ))}
        </div>
      )}
    </>
  ),
}))
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
  function NativePermission({ locked }: { locked: boolean }) {
    const id = useContext(Scope)
    return <button disabled={locked} aria-label={'Access: ' + id} />
  }
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
              <ChildPermission
                {...({
                  sessionId: id,
                  useProjection: () => ({ currentValue: 'read-only' }),
                  useSession: () => false,
                  SessionProvider: ui.SessionProvider,
                  renderSlot: (name: string, { locked }: { locked: boolean }) =>
                    name === 'roleTeam.leadPermission' && <NativePermission locked={locked} />,
                } as unknown as ComponentProps<typeof ChildPermission>)}
              />
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
          { sessionId: 'scout-session', generation: 1, archivedAt: '2026-11-23T00:00:00Z' },
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
  expect(scout.queryByText(en.ui.followLeader, { exact: false })).toBeNull()
  expect(await scout.findByRole('button', { name: 'Access: chief-session' })).toBeTruthy()
  expect(scout.getByTitle(en.ui.readOnlyMode + ' · ' + en.ui.followLeader)).toBeTruthy()
  expect(scout.queryByRole('button', { name: 'Access: scout-session' })).toBeNull()
  fireEvent.click(scout.getByTitle(en.ui.chooseModel))
  const picker = within(screen.getByRole('menu'))
  fireEvent.click(await picker.findByRole('menuitem', { name: 'Flash' }))
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('selectSeatModel', {
      seatId: 'scout',
      generation: 1,
      selection: { provider: 'demo', model: 'flash', reasoningEffort: undefined },
    }),
  )
  expect(scout.queryByText(en.ui.next)).toBeNull()
  expect(document.querySelector('.rt-chips')).toBeNull()
  fireEvent.click(screen.getByLabelText(en.ui.collapseTeams))
  expect(screen.queryByLabelText(en.ui.teamsList)).toBeNull()
  fireEvent.click(screen.getByLabelText(en.ui.expandTeams))
  expect(screen.getByLabelText(en.ui.teamsList)).toBeTruthy()
  fireEvent.click(scout.getByLabelText(en.ui.reset))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'handoff' } })
  fireEvent.click(dialog.getByRole('button', { name: en.ui.reset }))
  await screen.findByText('stream:scout-new')
  expect(h.releases.get('scout-session')).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('resetSeat', { seatId: 'scout', generation: 1, handoff: 'handoff' })
  fireEvent.click(scout.getByLabelText(en.ui.history))
  await scout.findByRole('option', { name: /2026/ })
  fireEvent.change(scout.getByRole('combobox', { name: en.ui.history }), {
    target: { value: 'scout-session' },
  })
  const history = await scout.findByRole('region', { name: en.ui.readOnly })
  expect(await within(history).findByText('stream:scout-session')).toBeTruthy()
  expect(within(history).queryByRole('button', { name: 'Access: chief-session' })).toBeNull()
  expect(scout.queryByRole('textbox')).toBeNull()
  expect(h.releases.get('scout-new')).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByText(en.ui.focus))
  await waitFor(() => expect(document.querySelectorAll('.rt-column')).toHaveLength(1))
  view.unmount()
  expect(h.releases.get('chief-session')).toHaveBeenCalledOnce()
  expect(h.releases.get('scout-session')).toHaveBeenCalledOnce()
})
it('opens an archived team only when selected, and uses the native transcript for history', async () => {
  const run = {
    runId: 'a',
    title: 'Past team',
    status: 'archived',
    leaderSeatId: 'chief',
    rootSessionId: 'chief-session',
  }
  const call = vi.fn(async (method: string) => {
    if (method === 'listTeams') return [run]
    if (method === 'getTeam') return { run, seats: [{ ...seat('chief', null), status: 'archived' }] }
    throw Error(method)
  })
  harness(call).mount(<Workbench roles={[]} />)
  await screen.findByText(en.ui.emptyTeams)
  expect(call).not.toHaveBeenCalledWith('getTeam', { runId: 'a' })
  fireEvent.click(screen.getByText(en.ui.archive))
  fireEvent.click(screen.getByRole('button', { name: 'Past team' }))
  const pane = await screen.findByRole('region', { name: en.ui.readOnly })
  expect(await within(pane).findByText('stream:chief-session')).toBeTruthy()
  expect(pane.querySelector('[data-read-only]')).toBeTruthy()
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

it('saves an experience with no status to choose', async () => {
  const file = { roleId: 'editor', memoryId: 'review' }
  const call = vi.fn().mockResolvedValue({ ok: true, hash: 'a'.repeat(64) })
  harness(call).mount(<DocumentEditor file={file} initial={null} changed={() => {}} />)
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.change(screen.getByLabelText(en.ui.memoryTitle), { target: { value: 'Review habit' } })
  fireEvent.click(screen.getByText(en.ui.save))
  await screen.findByText(en.ui.saved)
  expect(call.mock.calls[0][1]).toMatchObject({
    ...file,
    expectedHash: null,
    text: expect.stringContaining('Review habit'),
  })
  expect(call.mock.calls[0][1].text).not.toContain('status:')
})
it('switches teams and releases the old root', async () => {
  const runs = ['alpha', 'beta'].map((id) => ({
    runId: id,
    title: id,
    status: 'active',
    rootSessionId: id + '-session',
    leaderSeatId: id,
  }))
  const call = vi.fn(async (method: string, input: { runId: string; content: string }) => {
    switch (method) {
      case 'listTeams':
        return runs
      case 'getTeam':
        return { run: runs.find((r) => r.runId === input.runId), seats: [seat(input.runId, null)] }
      default:
        throw new Error(method)
    }
  })
  const h = harness(call)
  h.mount(<Workbench roles={[]} />)
  await screen.findByText('stream:alpha-session')
  fireEvent.click(within(screen.getByLabelText(en.ui.teamsList)).getByRole('button', { name: 'beta' }))
  await screen.findByText('stream:beta-session')
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
  fireEvent.change(form.getByLabelText(en.ui.duty), { target: { value: 'Write stories' } })
  fireEvent.click(form.getByText(en.ui.create))
  await screen.findByText('stream:s')
  expect(call.mock.calls[0]).toEqual([
    'saveDocument',
    expect.objectContaining({
      roleId: 'author',
      expectedHash: null,
      text: expect.stringContaining('summary: Write stories'),
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

it('keeps the role editor across views and restores the chosen revision against the displayed file', async () => {
  const changed = vi.fn()
  const meta = { id: 'editor', name: 'Editor', summary: 'Edit' }
  const file = { text: serializeMarkdown(meta, 'Current'), hash: 'f'.repeat(64) }
  const call = vi.fn(async (method: string) => {
    if (method === 'readDocument') return file
    if (method === 'roleHistory')
      return [2, 1].map((n) => ({
        publishedRevision: n,
        publishedAt: '2026-11-23T00:00:00Z',
        role: { meta, body: 'Role version ' + n },
      }))
    if (method === 'restoreRole') return { ok: true, status: {} }
    return []
  })
  harness(call).mount(
    <RoleLibrary roles={[{ id: 'editor', name: 'Editor', revision: 3 }]} changed={changed} />,
  )
  const editor = await screen.findByDisplayValue('Current')
  for (const mode of ['chatOnly', 'settingsOnly', 'splitView'] as const) {
    fireEvent.click(screen.getByRole('button', { name: en.ui[mode] }))
    expect(editor.closest('.rt-split')?.getAttribute('data-view')).toBe(mode)
    expect(editor.isConnected).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: en.ui.roleHistory }))
  const history = within(screen.getByRole('dialog'))
  await history.findByText('Role version 2')
  fireEvent.change(history.getByRole('combobox'), { target: { value: '1' } })
  await history.findByText('Role version 1')
  fireEvent.click(history.getByRole('button', { name: en.ui.restoreRole }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(call).toHaveBeenCalledWith('restoreRole', {
    roleId: 'editor',
    revision: 1,
    expectedHash: file.hash,
  })
})

it('confirms the selected role by name and hash, supports cancel and clears the last role after deletion', async () => {
  const changed = vi.fn()
  const file = {
    text: serializeMarkdown({ id: 'writer', name: 'Writer' }, 'Write'),
    hash: 'a'.repeat(64),
  }
  const call = vi.fn(async (method: string) => {
    if (method === 'readDocument') return file
    if (method === 'deleteRole') return { ok: true }
    return []
  })
  harness(call).mount(
    <RoleLibrary roles={[{ id: 'writer', name: 'Writer', revision: 1 }]} changed={changed} />,
  )
  fireEvent.click(screen.getByRole('button', { name: en.ui.deleteRole }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Writer')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: en.ui.cancel }))
  expect(call.mock.calls.some(([method]) => method === 'deleteRole')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.ui.deleteRole }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', {
    name: en.ui.deleteRole,
  }) as HTMLButtonElement
  await waitFor(() => expect(confirm.disabled).toBe(false))
  fireEvent.click(confirm)
  await screen.findByText(en.ui.emptyRoles)
  expect(changed).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('deleteRole', { roleId: 'writer', expectedHash: file.hash })
})
