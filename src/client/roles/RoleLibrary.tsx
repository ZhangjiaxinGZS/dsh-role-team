import { rememberRoleView, useNavigation, useRoleView } from '../navigation.js'
import { fileId } from '../../shared/index.js'
import { serializeMarkdown } from '../../shared/markdown.js'
import { useEffect, useState } from 'react'
import type { Diagnostic } from '../../shared/index.js'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MoreMenu, Modal, Notice, useAction, useLoad, useUi } from '../ui.js'
import type { RoleChoice } from '../team-setup/TeamSetup.js'
import { Documents } from './DocumentEditor.js'
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
  useEffect(() => {
    if (created && catalog.some((r) => r.id === created.id)) setCreated(undefined)
  }, [catalog, created])
  return (
    <section className="rt-library">
      <div className="rt-library-grid">
        <aside className="rt-rolelist rt-list" aria-label={t('rolesList')}>
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
                aria-current={id === r.id ? 'page' : undefined}
                onClick={() => setRole(r.id)}
              >
                {r.name}
              </button>
              <MoreMenu name={r.name} actions={{ deleteRole: () => setDeleting(r) }} />
            </div>
          ))}
        </aside>
        {id ? (
          <RoleDetail
            key={id}
            id={id}
            active={active}
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
          save={async (name, id, summary) => {
            if (roles.some((r) => r.id === id)) throw new Error(t('duplicateRole'))
            const result = await call('saveDocument', {
              roleId: id,
              expectedHash: null,
              text: serializeMarkdown({ id, name, ...(summary && { summary }) }, ''),
            })
            if (!result.ok)
              throw new Error(result.code === 'conflict' ? t('duplicateRole') : result.error.message)
            rememberRoleView(id, 'settingsOnly')
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
  changed,
}: {
  id: string
  active?: LibraryRole
  changed: () => void
}) {
  const { t, call } = useUi()
  const [view, setView] = useRoleView(id)
  const training = useLoad(id, () => call('openTraining', { roleId: id }), 2400)
  const start = useAction()
  return (
    <div className="rt-detail">
      <header>
        <div className="rt-row">
          <h2>{active?.name ?? id}</h2>
        </div>
        <button
          className="rt-primary"
          title={t('freshChatHint')}
          disabled={start.busy || !training.data?.trainingId}
          onClick={() =>
            start.run(async () => {
              await call('createTraining', {
                roleId: id,
                mode: active?.revision == null && active ? 'create' : 'coach',
              })
              if (view === 'settingsOnly') setView('splitView')
              training.refresh()
            })
          }
        >
          {t('newTraining')}
        </button>
        <div className="rt-segment" role="group" aria-label={t('roleView')}>
          <button
            aria-pressed={view !== 'settingsOnly'}
            aria-disabled={view === 'chatOnly'}
            onClick={() => {
              if (view !== 'chatOnly') setView(view === 'splitView' ? 'settingsOnly' : 'splitView')
            }}
          >
            {t('showChat')}
          </button>
          <button
            aria-pressed={view !== 'chatOnly'}
            aria-disabled={view === 'settingsOnly'}
            onClick={() => {
              if (view !== 'settingsOnly') setView(view === 'splitView' ? 'chatOnly' : 'splitView')
            }}
          >
            {t('showProfile')}
          </button>
        </div>
      </header>
      {active?.error && (
        <Notice>
          {active.error.file} · {t('line')} {active.error.line} · {active.error.message}
        </Notice>
      )}
      <div className="rt-split" data-view={view}>
        <section className="rt-training">
          <Notice>{training.error || start.error}</Notice>
          {training.error && <button onClick={training.refresh}>{t('retry')}</button>}
          {active?.empty && <p className="rt-intro">{t('firstTopic')}</p>}
          {training.data?.trainingId && (
            <TrainingDetail
              key={training.data.trainingId}
              row={training.data}
              refresh={training.refresh}
              changed={changed}
            />
          )}
        </section>
        <Documents roleId={id} revision={active?.revision ?? null} changed={changed} />
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
}: {
  close: () => void
  save: (name: string, id: string, summary: string) => Promise<void>
}) {
  const { t } = useUi(),
    action = useAction()
  const [name, setName] = useState(''),
    [custom, setCustom] = useState(''),
    [summary, setSummary] = useState('')
  const [suffix] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => n.toString(16).padStart(2, '0')).join(
      '',
    ),
  )
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 112)
  const generated = fileId.safeParse(slug).success ? slug : 'role-' + suffix
  return (
    <Modal title={t('newRole')} close={close} locked={action.busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            const id = fileId.safeParse(custom.trim() || generated)
            if (!id.success) throw new Error(t('idHint'))
            try {
              await save(name.trim(), id.data, summary.trim())
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes('Role ID is retired:'))
                throw error
              if (custom.trim()) throw new Error(t('retiredId'))
              await save(name.trim(), id.data + '-' + suffix, summary.trim())
            }
          })
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
        <details>
          <summary>{t('customId')}</summary>
          <label>
            {t('roleId')}
            <input placeholder={generated} value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
        </details>
        <Notice>{action.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={action.busy || !name.trim()}>
            {t('create')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
