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
  SessionPane,
  sessionTarget,
  targetId,
} from '../src/client/workbench/SessionPane.js'
import { registerPreviewWorkspace } from '../src/client/preview.js'
import type { Context } from '@deepseek-ai/cordis'
import { App, LibrarySettings, PreviewToggle } from '../src/client/App.js'
import { DocumentEditor, Documents } from '../src/client/roles/DocumentEditor.js'
import { TeamSetup } from '../src/client/team-setup/TeamSetup.js'
import { serializeMarkdown } from '../src/shared/markdown.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
// The browser supplies the shared menu. Exercise the catalog and selection callbacks here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconEllipsisOutlineRegular: () => null,
  Button: ({
    children,
    icon,
    variant,
    size,
    ...props
  }: import('react').ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode
    variant?: string
    size?: string
  }) => (
    <button data-variant={variant} data-size={size} data-icon={!!icon} {...props}>
      {icon}
      {children}
    </button>
  ),
  IconEditOutlineRegular: () => null,
  IconTrashOutlineRegular: () => null,
  IconArchiveOutlineRegular: () => null,
  IconPlusOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  IconPanelLeftOutlineRegular: () => null,
  IconClockOutlineRegular: () => null,
  IconCloseOutlineRegular: () => null,
  IconFullscreenOutlineRegular: () => null,
  IconRefreshOutlineRegular: () => null,
  IconCompareSplitOutlineRegular: () => null,
  Modal: ({
    title,
    children,
    closeLabel,
    onClose,
  }: {
    title: string
    children: ReactNode
    closeLabel: string
    onClose: () => void
  }) => (
    <div role="dialog" aria-label={title}>
      <button aria-label={closeLabel} onClick={onClose} />
      {children}
    </div>
  ),
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
    items: { id: string; label: string; submenu?: { id: string; label: string }[] }[]
    onSelect: (id: string) => void
  }) => (
    <>
      {anchor}
      {open && (
        <div role="menu">
          {items
            .flatMap((i) => i.submenu ?? [i])
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
  const openView = vi.fn()
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
          useConversationViews: () => [
            { id: 'chat', label: 'Chat' },
            { id: 'trajectory', label: 'Trajectory:' + id },
          ],
          useStore: () => 'chat',
          selectView: vi.fn(),
          actions: { openView },
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
          { event: { seq: 2, type: 'tool/call', data: { callId: id + '-outer', name: 'run_code' } } },
          { event: { seq: 3, type: 'tool/ptc-dispatch-start', data: { subCallId: id + '-nested' } } },
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
    openView,
  }
}
it('routes each column, limits reset to eligible members, and moves reset into the focused chat toolbar', async () => {
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
  expect(column('chief').queryByLabelText(en.ui.reset)).toBeNull()
  expect(column('chief').queryByLabelText(en.ui.history)).toBeNull()
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
  expect(scout.queryByLabelText(en.ui.history)).toBeNull()
  fireEvent.click(scout.getByRole('button', { name: en.ui.focus }))
  expect(document.querySelectorAll('.rt-column')).toHaveLength(1)
  expect(document.querySelector('.rt-column > header')).toBeNull()
  const toolbar = within(document.querySelector<HTMLElement>('.rt-column .rt-session-bar')!)
  expect(toolbar.getByRole('tablist')).toBeTruthy()
  fireEvent.click(toolbar.getByRole('button', { name: en.ui.reset }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.ui.cancel }))
  view.unmount()
  expect(h.releases.get('scout-new')).toHaveBeenCalledOnce()
})
it('opens an archived team only when selected, and uses the native transcript for history', async () => {
  const run = {
    runId: 'a',
    title: 'Past team',
    status: 'archived',
    leaderSeatId: 'chief',
    rootSessionId: 'chief-session',
  }
  let removed = false
  const call = vi.fn(async (method: string) => {
    if (method === 'listTeams') return removed ? [] : [run]
    if (method === 'deleteTeam') return removed = true
    if (method === 'getTeam') return { run, seats: [{ ...seat('chief', null), status: 'archived' }] }
    throw Error(method)
  })
  const h = harness(call), mounted = h.mount(<Workbench roles={[]} />)
  await screen.findByText(en.ui.emptyTeams)
  expect(call).not.toHaveBeenCalledWith('getTeam', { runId: 'a' })
  fireEvent.click(screen.getByText(en.ui.archive))
  fireEvent.click(screen.getByRole('button', { name: 'Past team' }))
  const pane = await screen.findByRole('region', { name: en.ui.readOnly })
  expect(await within(pane).findByText('stream:chief-session')).toBeTruthy()
  expect(pane.querySelector('[data-read-only]')).toBeTruthy()
  fireEvent.click(screen.getByText(en.ui.focus))
  expect(document.querySelector('.rt-column > header')).toBeNull()
  expect(screen.queryByRole('button', { name: en.ui.reset })).toBeNull()
  const openDelete = () => {
    fireEvent.click(screen.getByRole('button', { name: /More actions.*Past team/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.ui.deleteTeam }))
    return within(screen.getByRole('dialog'))
  }
  fireEvent.click(openDelete().getByRole('button', { name: en.ui.cancel }))
  expect(screen.getByText('stream:chief-session')).toBeTruthy()
  expect(removed).toBe(false)
  fireEvent.click(openDelete().getByRole('button', { name: en.ui.deleteTeam }))
  await screen.findByText(en.ui.emptyTeams)
  await waitFor(() => expect(screen.queryByText('Past team')).toBeNull())
  expect(call).toHaveBeenCalledWith('deleteTeam', { runId: 'a' })
  mounted.unmount()
  h.mount(<Workbench roles={[]} />)
  await screen.findByText(en.ui.emptyTeams)
  expect(screen.queryByText('Past team')).toBeNull()
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
    if (method === 'openTraining')
      return { trainingId: 'train-id', sessionId: 'training', proposals: [...proposals] }
    if (method === 'listMemories') return []
    if (method === 'readDocument') return null
    proposals.find((p) => p.id === input.proposalId)!.status =
      method === 'confirmProposal' ? 'confirmed' : 'rejected'
    return { ok: true }
  })
  const changed = vi.fn()
  harness(call).mount(
    <RoleLibrary roles={[{ id: 'editor', name: 'Editor', revision: 1 }]} changed={changed} />,
  )
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
  fireEvent.click(await screen.findByRole('button', { name: 'alpha' }))
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

function profileView() {
  return document.querySelector('.rt-split')?.getAttribute('data-view')
}

it('creates and publishes the named role before opening its first independent conversation', async () => {
  const changed = vi.fn()
  const call = vi.fn(async (method: string) => {
    if (method === 'createRole') return { ok: true, status: { roleId: 'auto-id', publishedRevision: 1 } }
    if (method === 'openTraining') return { roleId: 'auto-id', trainingId: 't', sessionId: 's' }
    return method === 'readDocument' ? null : []
  })
  harness(call).mount(<RoleLibrary roles={[]} changed={changed} />)
  fireEvent.click(screen.getByRole('button', { name: /New role/ }))
  const form = within(screen.getByRole('dialog'))
  expect(form.getAllByRole('textbox')).toHaveLength(2)
  fireEvent.change(form.getByLabelText(en.ui.name), { target: { value: 'Author' } })
  fireEvent.change(form.getByLabelText(en.ui.duty), { target: { value: 'Write stories' } })
  fireEvent.click(form.getByText(en.ui.create))
  await screen.findByText('stream:s')
  expect(profileView()).toBe('splitView')
  expect(screen.queryByRole('heading', { name: 'Author' })).toBeNull()
  expect(call.mock.calls[0]).toEqual(['createRole', { name: 'Author', summary: 'Write stories' }])
  expect(changed).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('openTraining', { roleId: 'auto-id' })
})

it('blocks a duplicate display name when creating or renaming a role', async () => {
  const roles = ['Author', 'Editor'].map((name) => ({ id: name.toLowerCase(), name, revision: 1 }))
  const call = vi.fn(async (method: string, ref: { roleId: string }) => {
    if (method === 'readDocument')
      return { text: serializeMarkdown({ id: ref.roleId, name: 'Author' }, ''), hash: 'a'.repeat(64) }
    return []
  })
  harness(call).mount(<RoleLibrary roles={roles} changed={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: en.ui.newRole }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.change(form.getByLabelText(en.ui.name), { target: { value: ' eDiToR ' } })
  expect(form.getByText(en.ui.duplicateRole)).toBeTruthy()
  expect((form.getByRole('button', { name: en.ui.create }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(form.getByRole('button', { name: en.ui.close }))
  fireEvent.change(await screen.findByLabelText(en.ui.name), { target: { value: 'eDiToR ' } })
  expect(screen.getByText(en.ui.duplicateRole)).toBeTruthy()
  expect((screen.getByRole('button', { name: en.ui.save }) as HTMLButtonElement).disabled).toBe(true)
  expect(call.mock.calls.some(([m]) => m === 'saveDocument' || m === 'createRole')).toBe(false)
})

it('starts coaching immediately without a team debrief entry', async () => {
  const row = { trainingId: 't', sessionId: 'coach-session', roleId: 'author', mode: 'coach' }
  const call = vi.fn(async (method: string) => {
    if (method === 'openTraining') return row
    return method === 'readDocument' ? null : []
  })
  harness(call).mount(
    <RoleLibrary roles={[{ id: 'author', name: 'Author', revision: 1 }]} changed={() => {}} />,
  )
  await screen.findByText('stream:coach-session')
  const toolbar = screen.getByRole('tablist').closest<HTMLElement>('.rt-session-bar')!
  expect(within(toolbar).getByRole('button', { name: en.ui.newTraining })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: en.ui.training })).toBeNull()
  expect(call).toHaveBeenCalledWith('openTraining', { roleId: 'author' })
  expect(call).not.toHaveBeenCalledWith('listTeams', {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: en.ui.debrief })).toBeNull()
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
    if (method === 'openTraining') return current
    if (method === 'listMemories') return []
    if (method === 'readDocument') return null
    if (method === 'createTraining') current = { ...current, trainingId: 'new', sessionId: 'fresh' }
    return current
  })
  const h = harness(call)
  h.mount(<RoleLibrary roles={[{ id: 'scout', name: 'Scout', revision: 1 }]} changed={() => {}} />)
  await screen.findByText('stream:previous')
  const fresh = screen.getByRole('button', { name: en.ui.newTraining })
  const supplement = screen.getByRole('button', { name: en.ui.newMemory })
  for (const key of ['variant', 'size', 'icon']) expect(fresh.dataset[key]).toBe(supplement.dataset[key])
  fireEvent.click(fresh)
  const dialog = within(screen.getByRole('dialog', { name: en.ui.newTraining }))
  expect(dialog.getByText(en.ui.freshChatHint)).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: en.ui.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText('stream:previous')).toBeTruthy()
  expect(call.mock.calls.some(([method]) => method === 'createTraining')).toBe(false)
  fireEvent.click(fresh)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.ui.confirm }))
  await screen.findByText('stream:fresh')
  expect(screen.queryByText('stream:previous')).toBeNull()
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
  for (const [label, mode] of [
    [en.ui.expandProfile, 'settingsOnly'], [en.ui.restoreSplit, 'splitView'],
    [en.ui.collapseProfile, 'chatOnly'], [en.ui.card, 'splitView'],
    [en.ui.expandProfile, 'settingsOnly'],
  ]) {
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(profileView()).toBe(mode)
    expect(editor.isConnected).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: en.ui.source }))
  expect(screen.getByLabelText(en.ui.source)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.ui.roleHistory }))
  expect(screen.queryByRole('dialog')).toBeNull()
  const history = within(screen.getByRole('region', { name: en.ui.roleHistory }))
  await history.findByText('Role version 2')
  fireEvent.click(history.getByRole('button', { name: /^Revision 1 / }))
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
  fireEvent.click(
    within(screen.getByRole('complementary', { name: en.ui.rolesList })).getByRole('button', {
      name: /More actions/,
    }),
  )
  fireEvent.click(screen.getByRole('menuitem', { name: en.ui.deleteRole }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Writer')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: en.ui.cancel }))
  expect(call.mock.calls.some(([method]) => method === 'deleteRole')).toBe(false)
  expect(document.querySelector('.rt-detail > header')).toBeNull()
  fireEvent.click(within(screen.getByRole('complementary', { name: en.ui.rolesList }))
    .getByRole('button', { name: /More actions/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.ui.deleteRole }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', {
    name: en.ui.deleteRole,
  }) as HTMLButtonElement
  await waitFor(() => expect(confirm.disabled).toBe(false))
  fireEvent.click(confirm)
  await screen.findByText(en.ui.emptyRoles)
  expect(changed).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('deleteRole', { roleId: 'writer', expectedHash: file.hash })
})

it('restores the last role, role view, page and team after leaving the panel', async () => {
  const runs = ['North', 'South'].map((id) => ({
    runId: id,
    title: id,
    status: 'active',
    leaderSeatId: id,
    rootSessionId: id + '-session',
  }))
  const call = vi.fn(async (method: string, input: any) => {
    if (method === 'listRoles')
      return ['Writer', 'Editor'].map((roleId) => ({ roleId, publishedRevision: 1 }))
    if (method === 'readSnapshot') return { role: { meta: { name: input }, body: 'role' } }
    if (method === 'listTeams') return runs
    if (method === 'getTeam')
      return { run: runs.find((r) => r.runId === input.runId), seats: [seat(input.runId, null)] }
    if (method === 'openTraining')
      return { trainingId: input.roleId, sessionId: input.roleId + '-session', roleId: input.roleId }
    if (method === 'readDocument') return null
    return []
  })
  const h = harness(call)
  let panel = h.mount(<App />)
  fireEvent.click(screen.getByRole('button', { name: en.ui.teams }))
  fireEvent.click(await screen.findByRole('button', { name: 'South' }))
  await screen.findByText('Trajectory:South-session')
  fireEvent.click(screen.getByRole('button', { name: en.ui.library }))
  fireEvent.click(await screen.findByRole('button', { name: 'Editor' }))
  fireEvent.click(await screen.findByText('Trajectory:Editor-session'))
  expect(h.openView).toHaveBeenCalledWith('trajectory', 'Editor-session-nested')
  fireEvent.click(screen.getByRole('button', { name: en.ui.expandProfile }))
  fireEvent.click(screen.getByRole('button', { name: 'Writer' }))
  expect(profileView()).toBe('splitView')
  fireEvent.click(screen.getByRole('button', { name: en.ui.collapseProfile }))
  fireEvent.click(screen.getByRole('button', { name: 'Editor' }))
  expect(profileView()).toBe('settingsOnly')
  panel.unmount()
  panel = h.mount(<App />)
  await screen.findByRole('button', { name: en.ui.restoreSplit })
  expect(screen.getByRole('button', { name: 'Editor' }).getAttribute('aria-current')).toBe('page')
  expect(profileView()).toBe('settingsOnly')
  fireEvent.click(screen.getByRole('button', { name: en.ui.teams }))
  await screen.findByText('Trajectory:South-session')
  panel.unmount()
  h.mount(<App />)
  await screen.findByText('Trajectory:South-session')
})

it('routes preview gestures to the originating session before native actions run', async () => {
  const { ui } = harness(vi.fn())
  const activate = vi.fn()
  const leave = vi.fn()
  const observed: string[] = []
  const child = sessionTarget('member-session', 'lead-session')
  ui.preview = { activate, leave, setDefault: () => () => {}, subscribe: () => () => {},
    state: () => 'closed', shortcut: () => undefined, toggle: vi.fn() }
  ui.chat = () => (
    <div data-chat-flow="">
      <button>Ordinary control</button>
      <a href="https://example.org" onContextMenu={() => observed.push(targetId(activate.mock.lastCall![0]))}>URL</a>
      <button tabIndex={0} onClick={() => observed.push(targetId(activate.mock.lastCall![0]))}>File</button>
    </div>
  )
  const view = render(<Client.Provider value={ui}><SessionPane target={child} /></Client.Provider>)
  fireEvent.click(await screen.findByText('Ordinary control'))
  expect(activate).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByText('URL'))
  fireEvent.click(screen.getByText('File'))
  fireEvent.keyDown(screen.getByText('URL'), { key: 'F10', shiftKey: true })
  expect(activate.mock.calls).toEqual([[child], [child], [child]])
  expect(observed).toEqual(['member-session', 'member-session'])
  view.unmount()
  expect(leave).toHaveBeenCalledWith('member-session')
})

it('releases the conversation outlet on native navigation and never closes another pane’s preview', () => {
  let panel: string | null = 'role-team'
  let pending = new AbortController()
  const selectPanel = vi.fn((value: string | null) => { pending.abort(); panel = value })
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: panel }) },
    selectPanel,
    beginNavigation: () => { pending.abort(); pending = new AbortController(); return pending.signal },
  }
  const openSession = vi.fn(() => selectPanel(null))
  const remove = vi.fn()
  const register = vi.fn(() => remove)
  const services = { layout, uiWorkspace: { openSession }, sidebarRight: {} }
  const ctx = {
    get: (key: keyof typeof services) => services[key],
    slots: { inject: vi.fn(), register },
    effect: vi.fn(),
  }
  const preview = registerPreviewWorkspace(ctx as unknown as Context, () => null)
  const root = sessionTarget('root')
  const child = sessionTarget('child', 'root')
  preview.activate(root)
  preview.activate(child)
  preview.activate(child)
  expect(openSession.mock.calls).toHaveLength(2)
  expect(openSession).toHaveBeenLastCalledWith(child)
  expect(register).toHaveBeenCalledTimes(1)
  preview.leave('root')
  expect(panel).toBeNull()
  selectPanel('settings')
  expect(remove).toHaveBeenCalledTimes(1)
  preview.leave('child')
  preview.activate(root)
  expect(panel).toBe('settings')
  expect(register).toHaveBeenCalledTimes(1)
  selectPanel('role-team')
  preview.activate(child)
  preview.leave('child')
  expect(panel).toBe('role-team')
  expect(remove).toHaveBeenCalledTimes(2)
})

it('opens the default session, follows native collapse, and reopens the last member preview', async () => {
  let expanded = false
  let signal = new AbortController()
  const listeners = new Set<() => void>()
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: 'role-team' }),
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    },
    beginNavigation() { signal.abort(); signal = new AbortController(); return signal.signal },
  }
  const sidebarRight = {
    isExpanded: () => expanded,
    toggleExpanded() { expanded = !expanded; for (const listener of listeners) listener() },
  }
  const openSession = vi.fn()
  const services = { layout, sidebarRight, uiWorkspace: { openSession } }
  const preview = registerPreviewWorkspace({
    get: (key: keyof typeof services) => services[key],
    slots: { inject: vi.fn(), register: () => () => {} },
    effect: vi.fn(),
  } as unknown as Context, () => null)
  const root = sessionTarget('lead')
  const member = sessionTarget('child', 'lead')
  preview.setDefault(root)
  const { mount } = harness(vi.fn())
  mount(<><PreviewToggle preview={preview} />
    <button onClick={sidebarRight.toggleExpanded}>Native collapse</button>
    <button onClick={() => preview.activate(member)}>Member preview</button></>)
  const reopen = () => screen.getByRole('button', { name: en.ui.openPreview })
  fireEvent.click(reopen())
  expect(openSession).toHaveBeenCalledWith(root)
  const collapse = () => screen.getByRole('button', { name: en.ui.closePreview })
  expect(collapse().getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(collapse())
  expect(reopen().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByText('Member preview'))
  fireEvent.click(reopen())
  fireEvent.click(screen.getByText('Native collapse'))
  fireEvent.click(reopen())
  expect(collapse().getAttribute('aria-expanded')).toBe('true')
  expect(openSession.mock.calls).toEqual([[root], [member]])
})
