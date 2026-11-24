import { PaneDivider, paneStyle, usePaneWidths } from '../PaneDivider.js'
import { rememberRoleView, useNavigation, useRoleView } from '../navigation.js'
import { duplicateRoleName, roleNameKey } from '../../shared/index.js'
import { useEffect, useRef, useState } from 'react'
import type { Diagnostic } from '../../shared/index.js'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MoreMenu, Modal, Notice, useAction, useLoad, useUi } from '../ui.js'
import type { RoleChoice } from '../team-setup/TeamSetup.js'
import { Documents, leaveProfile, type ProfileGuard } from './DocumentEditor.js'
import { TrainingDetail } from './Training.js'
export type LibraryRole = RoleChoice & { error?: Diagnostic | null; empty?: boolean }
export function RoleLibrary({ roles: catalog, changed }: { roles: LibraryRole[]; changed: () => void }) {
  const { t, call } = useUi(),
    [role, setRole] = useNavigation('role'),
    [created, setCreated] = useState<LibraryRole>(),
    [modal, setModal] = useState(''),
    [deleting, setDeleting] = useState<LibraryRole>(),
    [deleted, setDeleted] = useState<string[]>([]),
    roles = (
      created && !catalog.some((r) => r.id === created.id) ? [...catalog, created] : catalog
    ).filter((r) => !deleted.includes(r.id)),
    active = roles.find((r) => r.id === role) ?? roles[0],
    id = active?.id
  const guard = useRef<ProfileGuard['current']>(null)
  const listSize = usePaneWidths('roles.list')
  const nameTaken = (name: string, except?: string) =>
    roles.some((r) => r.id !== except && roleNameKey(r.name) === roleNameKey(name))
  useEffect(() => {
    if (created && catalog.some((r) => r.id === created.id)) setCreated(undefined)
  }, [catalog, created])
  return (
    <section className="rt-library">
      <div className="rt-library-grid">
        <aside style={paneStyle(listSize.widths.list)} className="rt-rolelist rt-list" aria-label={t('rolesList')}>
          <header>
            <h3>{t('rolesList')}</h3>
            <button
              className="rt-icon"
              aria-label={t('newRole')}
              title={t('newRole')}
              onClick={() => setModal('create')}
            >
              <IconPlusOutlineRegular size={16} />
            </button>
          </header>
          {roles.map((r) => (
            <div key={r.id} className="rt-list-row">
              <button
                title={r.name}
                aria-current={id === r.id ? 'page' : undefined}
                onClick={() => { if (id !== r.id) leaveProfile(guard, { kind: 'switch', proceed: () => setRole(r.id) }) }}
              >
                {r.name}
              </button>
              <MoreMenu name={r.name} actions={{ deleteRole: () => setDeleting(r) }} />
            </div>
          ))}
        </aside>
        <PaneDivider label={t('rolesList')} kind="list" pane="list" resize={listSize.resize} />
        {id ? (
          <RoleDetail
            key={id}
            id={id}
            active={active}
            guard={guard}
            nameTaken={(name) => nameTaken(name, id)}
            changed={changed}
          />
        ) : (
          <div className="rt-empty">
            <h2>{t('emptyRoles')}</h2>
            <p>{t('emptyRoleHint')}</p>
          </div>
        )}
      </div>
      {deleting && (
        <DeleteRole
          role={deleting}
          close={() => setDeleting(undefined)}
          done={() => {
            setDeleted((previous) => [...previous, deleting.id])
            if (deleting.id === id) {
              setRole(roles.find((r) => r.id !== deleting.id)?.id ?? '')
            }
            setDeleting(undefined)
            changed()
          }}
        />
      )}
      {modal === 'create' && (
        <CreateRole
          close={() => setModal('')}
          nameTaken={nameTaken}
          save={async (name, summary) => {
            const result = await call('createRole', { name, summary })
            if (!result.ok) {
              if (result.code === 'conflict') throw new Error(t('conflict'))
              throw new Error(result.error.message === duplicateRoleName ? t('duplicateRole') : result.error.message)
            }
            const id = result.status.roleId
            rememberRoleView(id, 'splitView')
            setCreated({ id, name, revision: result.status.publishedRevision, empty: true })
            setRole(id)
            changed()
            setModal('')
          }}
        />
      )}
    </section>
  )
}
function RoleDetail({
  id,
  active,
  guard,
  nameTaken,
  changed,
}: {
  id: string
  nameTaken: (name: string) => boolean
  guard: ProfileGuard
  active?: LibraryRole
  changed: () => void
}) {
  const { t, call } = useUi()
  const [view, setView] = useRoleView(id)
  const profileSize = usePaneWidths('roles.settings')
  const training = useLoad(id, () => call('openTraining', { roleId: id }), 2400)
  const start = useAction()
  const [replacing, setReplacing] = useState<string>()
  const chatActions = (
    <div className="rt-chat-actions">
      <Button
        size="sm"
        variant="outline"
        icon={<IconPlusOutlineRegular size={14} />}
        disabled={start.busy || !training.data?.trainingId}
        onClick={() => {
          start.clear()
          setReplacing(training.data?.trainingId)
        }}
      >
        {t('newTraining')}
      </Button>
      {view === 'chatOnly' && <Button size="sm" variant="outline" onClick={() => setView('splitView')}>{t('card')}</Button>}
    </div>
  )
  return (
    <div className="rt-detail">
      {replacing && (
        <Modal title={t('newTraining')} close={() => setReplacing(undefined)} locked={start.busy}>
          <p>{t('freshChatHint')}</p>
          <Notice>{start.error}</Notice>
          <footer>
            <Button variant="outline" data-modal-autofocus disabled={start.busy} onClick={() => setReplacing(undefined)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={start.busy || replacing !== training.data?.trainingId}
              onClick={() => start.run(async () => {
                await call('createTraining', {
                  roleId: id,
                  mode: active?.revision == null && active ? 'create' : 'coach',
                  expectedTrainingId: replacing,
                })
                training.refresh()
                setReplacing(undefined)
              })}
            >
              {t('confirm')}
            </Button>
          </footer>
        </Modal>
      )}
      {active?.error && (
        <Notice>
          {active.error.file} · {t('line')} {active.error.line} · {active.error.message}
        </Notice>
      )}
      <div className="rt-split" data-view={view} style={paneStyle(profileSize.widths.settings)}>
        <section className="rt-training">
          <Notice>{training.error}</Notice>
          {training.error && <button onClick={training.refresh}>{t('retry')}</button>}
          {training.data?.trainingId ? (
            <TrainingDetail
              key={training.data.trainingId}
              toolbarActions={chatActions}
              chatHint={active?.empty ? t('firstTopic') : undefined}
              row={training.data}
              refresh={training.refresh}
              changed={changed}
            />
          ) : chatActions}
        </section>
        {view === 'splitView' && (
          <PaneDivider label={t('card')} kind="profile" pane="settings" resize={profileSize.resize} />
        )}
        <Documents
          guard={guard}
          roleId={id}
          revision={active?.revision ?? null}
          changed={changed}
          nameTaken={nameTaken}
          fullscreen={view === 'settingsOnly'}
          toggleSize={() => setView(view === 'settingsOnly' ? 'splitView' : 'settingsOnly')}
          collapse={() => setView('chatOnly')}
        />
      </div>
    </div>
  )
}
function DeleteRole({ role, close, done }: { role: LibraryRole; close: () => void; done: () => void }) {
  const { t, call } = useUi()
  const file = useLoad(role.id, () => call('readDocument', { roleId: role.id }))
  const action = useAction()
  return (
    <Modal title={t('deleteRole')} close={close} locked={action.busy}>
      <p>
        <strong>{role.name}</strong> · {role.id}
      </p>
      <p>{t('deleteRoleHint')}</p>
      <Notice>{file.error || action.error}</Notice>
      <footer>
        <button data-modal-autofocus disabled={action.busy} onClick={close}>
          {t('cancel')}
        </button>
        <button
          className="rt-destructive"
          disabled={action.busy || file.data === undefined}
          onClick={() =>
            action.run(async () => {
              const result = await call('deleteRole', {
                roleId: role.id,
                expectedHash: file.data?.hash ?? null,
              })
              if (!result.ok) {
                file.refresh()
                throw new Error(
                  result.code === 'conflict' ? t('roleDeleteConflict') : result.error.message,
                )
              }
              done()
            })
          }
        >
          {t('deleteRole')}
        </button>
      </footer>
    </Modal>
  )
}
function CreateRole({
  close,
  save,
  nameTaken,
}: {
  close: () => void
  save: (name: string, summary: string) => Promise<void>
  nameTaken: (name: string) => boolean
}) {
  const { t } = useUi(), action = useAction()
  const [name, setName] = useState(''), [summary, setSummary] = useState('')
  const duplicate = nameTaken(name)
  return (
    <Modal title={t('newRole')} close={close} locked={action.busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!duplicate && name.trim()) void action.run(() => save(name.trim(), summary.trim()))
        }}
      >
        <label>
          {t('name')}
          <input
            data-modal-autofocus
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t('duty')}
          <input maxLength={160} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <Notice>{duplicate ? t('duplicateRole') : action.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={action.busy || !name.trim() || duplicate}>
            {t('create')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
