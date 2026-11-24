// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { RoleLibrary } from '../src/client/roles/RoleLibrary.js'
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { DocumentEditor, Documents, EditorBuffers } from '../src/client/roles/DocumentEditor.js'
import { TeamSetup } from '../src/client/team-setup/TeamSetup.js'
import { serializeMarkdown } from '../src/shared/markdown.js'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
// The browser supplies the shared menu. Exercise the catalog and selection callbacks here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="native-markdown">{text}</div>,
  IconSettingsOutlineRegular: () => null,
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
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
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
  expect(document.querySelector('.rt-controls .rt-chip')).toBeNull()
  expect(document.querySelectorAll('.rt-member-bar .rt-chip')).toHaveLength(2)
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
  fireEvent.change(screen.getByLabelText(en.ui.body), { target: { value: 'updated elsewhere and mine' } })
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
  await screen.findByRole('heading', { name: 'Author' })
  fireEvent.click(screen.getByRole('button', { name: en.ui.edit }))
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

it('reads with native Markdown, edits inline, and returns to reading after cancel, save, back and restore', async () => {
  const changed = vi.fn()
  const meta = { id: 'editor', name: 'Editor', summary: 'Duty' }
  const body = '## Current\n\n**Detail**'
  let file = { text: serializeMarkdown(meta, body), hash: 'f'.repeat(64) }
  const memory = { id: 'lesson', title: 'Lesson', scope: 'role_long_term', createdAt: new Date().toISOString() }
  const call = vi.fn(async (method: string, input: any) => {
    if (method === 'listMemories') return ['lesson']
    if (method === 'readDocument') return input.memoryId
      ? { text: serializeMarkdown(memory, '- Note'), hash: 'a'.repeat(64) } : file
    if (method === 'saveDocument') {
      file = { text: input.text, hash: 'b'.repeat(64) }
      return { ok: true, hash: file.hash }
    }
    if (method === 'roleHistory')
      return [2, 1].map((n) => ({
        publishedRevision: n, publishedAt: '2026-11-23T00:00:00Z',
        role: { meta, body: '# Version ' + n },
      }))
    if (method === 'restoreRole') {
      file = { text: serializeMarkdown(meta, '# Version ' + input.revision), hash: 'c'.repeat(64) }
      return { ok: true, status: {} }
    }
    return []
  })
  harness(call).mount(<RoleLibrary roles={[{ ...meta, revision: 3 }]} changed={changed} />)
  const btn = (name: string) => screen.getByRole('button', { name })
  await screen.findByText('- Note')
  const fields = screen.getAllByRole('term')
  expect(fields.map(field => field.textContent)).toEqual([en.ui.name, en.ui.duty, en.ui.body])
  const values = screen.getAllByRole('definition')
  expect(values.map(value => value.textContent)).toEqual(['Editor', 'Duty', body])
  expect(within(values[2]).getByTestId('native-markdown')).toBeTruthy()
  expect(screen.getAllByTestId('native-markdown').map((el) => el.textContent)).toEqual([body, '- Note'])
  expect(screen.queryByRole('button', { name: 'Source' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: en.ui.body })).toBeNull()
  fireEvent.click(btn(en.ui.edit))
  fireEvent.change(screen.getByLabelText(en.ui.body), { target: { value: 'discard' } })
  fireEvent.click(btn(en.ui.cancel))
  fireEvent.doubleClick(screen.getByLabelText(en.ui.body))
  const editor = screen.getByLabelText<HTMLTextAreaElement>(en.ui.body)
  expect(editor.value).toBe(body)
  fireEvent.change(editor, { target: { value: '# New' } })
  fireEvent.click(btn(en.ui.expandProfile))
  expect(profileView()).toBe('settingsOnly')
  expect(screen.queryByRole('button', { name: en.ui.collapseProfile })).toBeNull()
  expect(editor.isConnected).toBe(true)
  fireEvent.click(btn(en.ui.save))
  await screen.findByText('# New')
  expect(screen.queryByRole('textbox', { name: en.ui.body })).toBeNull()
  fireEvent.click(btn(en.ui.restoreSplit))
  fireEvent.click(btn(en.ui.collapseProfile))
  for (const key of ['variant', 'size'])
    expect(btn(en.ui.card).dataset[key]).toBe(btn(en.ui.newTraining).dataset[key])
  fireEvent.click(btn(en.ui.card))
  expect(profileView()).toBe('splitView')
  fireEvent.click(btn(en.ui.roleHistory))
  await screen.findByText('# Version 2')
  fireEvent.click(btn(en.ui.back))
  await screen.findByText('# New')
  fireEvent.click(btn(en.ui.roleHistory))
  const history = within(screen.getByRole('region', { name: en.ui.roleHistory }))
  fireEvent.click(await history.findByRole('button', { name: /^Revision 1 / }))
  expect(history.getByTestId('native-markdown').textContent).toBe('# Version 1')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(btn(en.ui.restoreRole))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
  await screen.findByText('# Version 1')
  expect(screen.queryByRole('region', { name: en.ui.roleHistory })).toBeNull()
  expect(call).toHaveBeenCalledWith('restoreRole', {
    roleId: 'editor', revision: 1, expectedHash: 'b'.repeat(64),
  })
})

it.each(['collapse', 'switch'] as const)('protects profile edits on %s and leaves only after a successful save', async kind => {
  const roles = ['alpha', 'beta'].map(id => ({ id, name: id.toUpperCase(), revision: 1 }))
  const file = { text: '---\n# Preserve this comment\nid: alpha\nname: ALPHA\n---\nOriginal', hash: 'a'.repeat(64) }
  let refuse = false
  const call = vi.fn(async (method: string, input: any) => {
    if (method === 'readDocument') return input.roleId === 'alpha' ? file : {
      text: serializeMarkdown({ id: 'beta', name: 'BETA' }, 'Second'), hash: 'b'.repeat(64),
    }
    if (method === 'saveDocument') {
      if (refuse) return { ok: false, code: 'conflict', current: { ...file }, proposed: input.text }
      Object.assign(file, { text: input.text, hash: 'c'.repeat(64) })
      return { ok: true, hash: file.hash }
    }
    return []
  })
  const buffers = new Map()
  harness(call).mount(<EditorBuffers.Provider value={buffers}><RoleLibrary roles={roles} changed={vi.fn()} /></EditorBuffers.Provider>)
  const button = (name: string) => screen.getByRole('button', { name })
  const click = (name: string) => fireEvent.click(button(name))
  const edit = async () => {
    await screen.findByRole('heading', { name: 'ALPHA' })
    click(en.ui.edit)
    return screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.ui.body })
  }
  const leave = () => click(kind === 'collapse' ? en.ui.collapseProfile : 'BETA')
  const back = async () => {
    if (kind === 'collapse') {
      await waitFor(() => expect(profileView()).toBe('chatOnly'))
      click(en.ui.card)
    } else {
      await screen.findByRole('heading', { name: 'BETA' })
      click('ALPHA')
    }
    await screen.findByRole('heading', { name: 'ALPHA' })
    expect(screen.queryByRole('textbox', { name: en.ui.body })).toBeNull()
  }
  click('ALPHA')
  if (profileView() === 'chatOnly') click(en.ui.card)
  await edit()
  const summary = screen.getByRole('textbox', { name: en.ui.duty })
  fireEvent.change(summary, { target: { value: 'changed' } })
  fireEvent.change(summary, { target: { value: '' } })
  leave()
  expect(screen.queryByRole('dialog')).toBeNull()
  await back()

  const change = async () => fireEvent.change(await edit(), { target: { value: 'New draft' } })
  await change()
  leave()
  click(en.ui.keepEditing)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.ui.body }).value).toBe('New draft')
  leave()
  click(kind === 'collapse' ? en.ui.discardCollapse : en.ui.discardSwitch)
  await back()
  expect(buffers.size).toBe(0)
  expect(file.text).toContain('Original')
  expect(call.mock.calls.some(([method]) => method === 'saveDocument')).toBe(false)

  await change()
  leave()
  refuse = true
  const save = kind === 'collapse' ? en.ui.saveCollapse : en.ui.saveSwitch
  click(save)
  await screen.findByText(en.ui.conflict, { exact: true })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.ui.body }).value).toBe('New draft')
  click(en.ui.merge)
  refuse = false
  leave()
  click(save)
  await back()
  expect(file.text).toContain('New draft')
  expect(buffers.size).toBe(0)
  expect(await screen.findByText('New draft')).toBeTruthy()
})

it('chains split-view scrolling and gives the full profile a single scroll surface', async () => {
  const style = document.createElement('style')
  style.textContent = readFileSync('src/client/ui.css', 'utf8')
  document.head.append(style)
  try {
    const file = { text: serializeMarkdown({ id: 'layout', name: 'Layout' }, 'Paragraph\n\n'.repeat(80)), hash: 'a'.repeat(64) }
    const call = vi.fn(async (method: string) => method === 'readDocument' ? file : [])
    harness(call).mount(<RoleLibrary roles={[{ id: 'layout', name: 'Layout', revision: 1 }]} changed={vi.fn()} />)
    const box = await screen.findByRole('definition', { name: en.ui.body })
    expect(screen.getAllByRole('definition')[1].textContent).toBe('—')
    expect(getComputedStyle(box).overflow).toBe('auto')
    expect(getComputedStyle(box).overscrollBehavior).toBe('auto')
    expect(getComputedStyle(box).maxHeight).toBe('min(280px, 36vh)')
    fireEvent.click(screen.getByRole('button', { name: en.ui.expandProfile }))
    expect(getComputedStyle(box).maxHeight).toBe('none')
    expect(getComputedStyle(box).overflow).toBe('visible')
    expect(getComputedStyle(box.closest('.rt-docs')!).overflow).toBe('auto')
    const lessons = screen.getByRole('heading', { name: en.ui.memories })
    expect(box.compareDocumentPosition(lessons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  } finally { style.remove() }
})

it('reports the file and line when a saved document has invalid frontmatter', async () => {
  const call = vi.fn(async (method: string) => method === 'readDocument'
    ? { text: '---\nid: [\n---\n', hash: 'a'.repeat(64) } : [])
  harness(call).mount(<Documents roleId="editor" revision={1} changed={() => {}} />)
  expect((await screen.findByRole('alert')).textContent).toMatch(/editor\/role.md · Line \d+/)
  expect(screen.queryByRole('button', { name: 'Source' })).toBeNull()
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

function installWidthStorage() {
  const disk = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => disk.set(key, value),
    removeItem: (key: string) => disk.delete(key),
  })
}

// jsdom has no pane geometry or pointer capture. Real layout and hit testing are checked in Chrome.
function dragDivider(handle: HTMLElement, delta: number, left: number, right: number, available = left + right + 1) {
  Object.defineProperty(handle.parentElement, 'clientWidth', { configurable: true, value: available })
  for (const [sibling, width] of [[handle.previousElementSibling!, left], [handle.nextElementSibling!, right]] as const) {
    vi.spyOn(sibling, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, 600))
  }
  handle.setPointerCapture = vi.fn()
  for (const [type, clientX] of [['pointerdown', 100], ['pointermove', 100 + delta], ['pointerup', 100 + delta]] as const) {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    fireEvent(handle, event)
  }
}
const widthPreference = (selector: string) =>
  document.querySelector<HTMLElement>(selector)!.style.getPropertyValue('--rt-pane-width')

it('resizes the role list and profile independently, clamps both and restores defaults after remount', async () => {
  installWidthStorage()
  const h = harness(vi.fn(async (method: string) => method === 'readDocument' ? null : []))
  const library = () => h.mount(<RoleLibrary roles={[{ id: 'resize-role', name: 'Resize', revision: 1 }]} changed={vi.fn()} />)
  const separator = (name: string) => screen.getByRole('separator', { name: 'Resize · ' + name })
  let view = library()
  dragDivider(separator(en.ui.rolesList), 500, 190, 960)
  dragDivider(separator(en.ui.card), -800, 620, 340)
  expect(widthPreference('.rt-rolelist')).toBe('340px')
  expect(widthPreference('.rt-split')).toBe('640px')
  view.unmount()
  view = library()
  expect(widthPreference('.rt-rolelist')).toBe('340px')
  expect(widthPreference('.rt-split')).toBe('640px')
  dragDivider(separator(en.ui.rolesList), -999, 340, 800)
  dragDivider(separator(en.ui.card), 999, 320, 640)
  expect(widthPreference('.rt-rolelist')).toBe('140px')
  expect(widthPreference('.rt-split')).toBe('310px')
  fireEvent.doubleClick(separator(en.ui.rolesList))
  fireEvent.keyDown(separator(en.ui.card), { key: 'Home' })
  view.unmount()
  library()
  expect(widthPreference('.rt-rolelist')).toBe('')
  expect(widthPreference('.rt-split')).toBe('')
  await screen.findByRole('heading', { name: 'resize-role' })
})

it('stores team list and adjacent member widths, scoped to team and seats across remounts', async () => {
  installWidthStorage()
  const runs = ['width-a', 'width-b'].map(runId => ({ runId, title: runId, leaderSeatId: 'lead', status: 'active' }))
  const h = harness(vi.fn(async (method: string, input: { runId: string }) => {
    if (method === 'listTeams') return runs
    if (method === 'getTeam') return { run: runs.find(r => r.runId === input.runId), seats: [seat('lead', null), seat('other', 'lead')] }
    return []
  }))
  const mount = () => h.mount(<Workbench roles={[]} />)
  const pair = () => screen.findByRole('separator', { name: 'Resize · lead / other' })
  const sizes = () => ['.rt-team-list', '#seat-lead', '#seat-other'].map(widthPreference)
  let view = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'width-a' }))
  fireEvent.click(await screen.findByText(en.ui.columns))
  dragDivider(await pair(), 130, 400, 400)
  dragDivider(screen.getByRole('separator', { name: 'Resize · ' + en.ui.teamsList }), 75, 180, 900)
  expect(sizes()).toEqual(['255px', '530px', '300px'])
  view.unmount()
  view = mount()
  await pair()
  expect(sizes()).toEqual(['255px', '530px', '300px'])
  fireEvent.click(screen.getByRole('button', { name: 'width-b' }))
  await pair()
  expect(sizes()).toEqual(['255px', '', ''])
  fireEvent.click(screen.getByRole('button', { name: 'width-a' }))
  fireEvent.doubleClick(await pair())
  fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize · ' + en.ui.teamsList }))
  view.unmount()
  mount()
  await pair()
  expect(sizes()).toEqual(['', '', ''])
})

it('keeps the layout and column preference, locates members, and shows live session status', async () => {
  installWidthStorage()
  const resize = new Map<Element, () => void>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(el: Element) { resize.set(el, this.callback) }
    disconnect() {}
  })
  const run = { runId: 'status-team', title: 'Status team', status: 'active', leaderSeatId: 'lead', rootSessionId: 'lead-session' }
  const seats = [seat('lead', null), seat('writer', 'lead')]
  const h = harness(vi.fn(async (method: string) => {
    if (method === 'listTeams') return [run]
    if (method === 'getTeam') return { run, seats }
    return []
  }))
  const id = 'writer-session' as SessionReference['sessionId']
  const status = { running: true, completionUnread: false, pendingInteraction: undefined }
  const states = new Map<typeof id, import('@deepseek-ai/dsh-client-ui-session/client').SessionStatus>([[id, status]])
  const listeners = new Set<() => void>()
  h.ui.sessionStatus = {
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSnapshot: () => states,
  }
  const mount = () => h.mount(<Workbench roles={[]} />)
  let view = mount()
  fireEvent.click(await screen.findByText(en.ui.columns))
  expect(await screen.findAllByRole('img', { name: en.ui.seatWorking })).toHaveLength(2)
  expect(screen.getAllByRole('img', { name: en.ui.seatIdle })).toHaveLength(2)
  act(() => {
    states.set(id, { ...status, pendingInteraction: { sessionId: id, key: 'p1', kind: 'approval' } })
    listeners.forEach(fn => fn())
  })
  expect(screen.getAllByTitle(en.ui.seatApproval)).toHaveLength(2)
  expect(screen.queryByText(en.ui.seatApproval)).toBeNull()
  expect(document.querySelector('.rt-column .rt-lead-badge')?.textContent).toBe(en.ui.leader)
  fireEvent.click(screen.getByTitle(en.ui.boardSettings))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(dialog.getByText(en.ui.wideWidth))
  fireEvent.change(dialog.getByRole('slider'), { target: { value: '680' } })
  expect(dialog.getByText('680 px')).toBeTruthy()
  fireEvent.click(dialog.getByLabelText(en.ui.close))
  fireEvent.click(screen.getByText(en.ui.focus))
  const bar = screen.getByRole('navigation', { name: en.ui.members })
  const picker = () => within(bar).queryByRole('button', { name: 'All (2)' })
  expect(picker()).toBeNull()
  const content = bar.querySelector('.rt-chip-track')!
  Object.defineProperty(content, 'scrollWidth', { value: 420 })
  function sizeBar(width: number) {
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: width })
    act(() => resize.get(bar)!())
  }
  sizeBar(350)
  fireEvent.click(picker()!)
  const menu = within(screen.getByRole('menu'))
  expect(menu.getByTitle(en.ui.seatApproval)).toBeTruthy()
  expect(menu.getByText(en.ui.leader)).toBeTruthy()
  fireEvent.click(menu.getByRole('menuitem', { name: /writer/ }))
  expect(document.querySelector('.rt-column')?.id).toBe('seat-writer')
  expect(document.querySelector('.rt-chip .rt-lead-badge')?.textContent).toBe(en.ui.leader)
  sizeBar(420)
  expect(picker()).toBeNull()
  view.unmount()
  view = mount()
  expect((await screen.findByText(en.ui.focus)).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByTitle(en.ui.boardSettings))
  expect(screen.getByText('680 px')).toBeTruthy()
  fireEvent.click(screen.getByText(en.ui.restoreWidth))
  expect(screen.getByText('480 px')).toBeTruthy()
  view.unmount()
})

it('renders team turn triggers expanded with Markdown, sender and timestamp, and delegates other turns to the native card', async () => {
  const { registerTeamTrigger, teamMessage } = await import('../src/client/workbench/TeamTrigger.js')
  const source = { kind: 'agent-message', senderSessionId: 'rt-child-123' }
  const text = (text: string) => ({ type: 'text' as const, text })
  const content = [text('Agent role-abc sent a message: '), text('这条通知触发了本轮回复。\n**请审稿**\n第二行')]
  expect(teamMessage({ source, content })).toMatchObject({ senderId: 'rt-child-123', senderName: 'role-abc', parts: [{ text: '**请审稿**\n第二行' }] })
  expect(teamMessage({ source: { kind: 'team-message', senderId: 'old', senderName: 'alias' }, content: [text('转述：Agent lead sent a message: 原文')] })).toMatchObject({ senderId: 'old', senderName: 'alias', parts: [{text:'转述：Agent lead sent a message: 原文'}] })
  let Route!: React.ComponentType<{ sessionId: string; node: { data: Record<string, unknown> } }>
  const ctx = { slots: {
    inject: (_: string, cb: () => void) => cb(),
    register: (opts: object, component: typeof Route) => { expect(opts).toMatchObject({ key: 'turn-trigger', priority: -1 }); Route = component },
    entries: () => [{ options: { key: 'turn-trigger' }, locale:'chat', component: () => <button aria-expanded="false">native trigger</button> }],
  } }
  const lookup = vi.fn().mockResolvedValue({ name: '程序员' })
  registerTeamTrigger(ctx as unknown as Context, lookup as Ui['call'], k => en.ui[k])
  const node = { data: { source, content, time: Date.UTC(2026,0,1) } }
  const view = render(<Route sessionId="rt-root-test" node={node} />)
  const header = await screen.findByRole('button', {name:/From 程序员/})
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(header.querySelector('time')?.dateTime).toBe('2026-01-01T00:00:00.000Z')
  expect(screen.getByTestId('native-markdown').textContent).toBe('**请审稿**\n第二行')
  fireEvent.click(header)
  expect(screen.queryByTestId('native-markdown')).toBeNull()
  fireEvent.click(header)
  expect(screen.getByTestId('native-markdown')).toBeTruthy()
  view.rerender(<Route sessionId="ordinary" node={node} />)
  expect(screen.getByText('native trigger').getAttribute('aria-expanded')).toBe('false')
  for (const kind of ['schedule','goal','webhook']) {
    view.rerender(<Route sessionId="rt-root-test" node={{data:{...node.data,source:{kind}}}} />)
    expect(screen.getByText('native trigger')).toBeTruthy()
  }
  expect(lookup).toHaveBeenCalledTimes(1)
})

it('offers team-only atomic mentions, disambiguates names and renders the serialized identity', async () => {
  const { memberSource, memberRule } = await import('../src/client/workbench/TeamMentions.js')
  const name = 'Dev [QA]'
  const members = ['lead', 'dev/qa'].map((address, i) => ({
    seatId: 'seat-' + i, address, name, leader: !i, duty: i ? 'Review builds' : 'Plan',
  }))
  const call = vi.fn().mockResolvedValue({ runId: 'team-abc', members })
  const source = memberSource(call as Ui['call'], key => en.ui[key])
  const session = { sessionId: 'rt-child-xyz' as import('@deepseek-ai/dsh-session').SessionId }
  const req = { signal: new AbortController().signal, query: '', position: 'inline' as const, drilled: false }
  expect(await source.candidates({ sessionId: 'ordinary' as typeof session.sessionId }, req)).toEqual([])
  expect(await source.candidates(session, { ...req, quoted: true })).toEqual([])
  expect(call).not.toHaveBeenCalled()
  const rows = await source.candidates(session, req)
  expect(rows.map(row => row.section)).toEqual(Array(3).fill(en.ui.mentionGroup))
  expect(rows[0].description).toContain(en.ui.leader)
  expect(rows[2].name).toBe(en.ui.mentionEveryone)
  expect(await source.candidates(session, { ...req, query: 'build' })).toEqual([rows[1]])
  const pick = await source.onPick({ candidate: rows[1], session, position: 'inline', via: 'enter', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
  expect(pick).toMatchObject({ insert: { label: '@Dev [QA] · dev/qa', ref: rows[1].value } })
  const encoded = await source.codec!.serialize(rows[1].value!, req.signal)
  expect(source.codec!.clipboardText(encoded)).toBe(encoded)
  expect(memberRule.match('go ' + encoded, 0, { read: () => undefined })).toMatchObject({ start: 3, end: 3 + encoded.length, data: { label: rows[1].name } })
  expect(memberRule.match('@readme.md', 0, { read: () => undefined })).toBeUndefined()
})
