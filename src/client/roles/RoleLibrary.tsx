import { fileId } from '../../shared/index.js'
import { serializeMarkdown } from '../../shared/markdown.js'
import { useState } from 'react'
import type { Diagnostic } from '../../shared/index.js'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MoreMenu, Modal, Notice, useAction, useLoad, useUi } from '../ui.js'
import type { RoleChoice } from '../team-setup/TeamSetup.js'
import { Documents } from './DocumentEditor.js'
import { TrainingPanel } from './Training.js'
export type LibraryRole = RoleChoice & { error?: Diagnostic | null; empty?: boolean }
export function RoleLibrary({ roles: catalog, changed }: { roles: LibraryRole[]; changed: () => void }) {
  const { t, call } = useUi(),
    [view, setView] = useState<'chatOnly' | 'splitView' | 'settingsOnly'>('splitView'),
    [role, setRole] = useState(''),
    [session, setSession] = useState<{ roleId: string; trainingId: string }>(),
    [modal, setModal] = useState(''),
    [deleting, setDeleting] = useState<LibraryRole>(),
    [deleted, setDeleted] = useState<string[]>([]),
    [startError, setStartError] = useState(''),
    roles = catalog.filter((r) => !deleted.includes(r.id)),
    id = role || roles[0]?.id
  const active = roles.find((r) => r.id === id)
  return (
    <section className="rt-library">
      <Notice>{startError}</Notice>
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
                onClick={() => {
                  setRole(r.id)
                  setSession(undefined)
                }}
              >
                {r.name}
              </button>
              <MoreMenu name={r.name} actions={{ deleteRole: () => setDeleting(r) }} />
            </div>
          ))}
        </aside>
        {id ? (
          <div className="rt-detail" key={id}>
            <header>
              <div className="rt-row">
                <h2>{active?.name ?? id}</h2>
              </div>
              <div className="rt-segment" role="group" aria-label={t('roleView')}>
                {(['chatOnly', 'splitView', 'settingsOnly'] as const).map((mode) => (
                  <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>
                    {t(mode)}
                  </button>
                ))}
              </div>
              {active && (
                <MoreMenu name={active.name} actions={{ deleteRole: () => setDeleting(active) }} />
              )}
            </header>
            {active?.error && (
              <Notice>
                {active.error.file} · {t('line')} {active.error.line} · {active.error.message}
              </Notice>
            )}
            <div className="rt-split" data-view={view}>
              <TrainingPanel
                key={id + (session?.roleId === id ? session.trainingId : '')}
                roleId={id}
                empty={active?.empty}
                hasRole={active?.revision != null}
                initialId={session?.roleId === id ? session.trainingId : undefined}
                changed={changed}
              />
              <Documents roleId={id} revision={active?.revision ?? null} changed={changed} />
            </div>
          </div>
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
              setSession(undefined)
            }
            setStartError('')
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
            setRole(id)
            setSession(undefined)
            changed()
            setModal('')
            // Keep a successfully created role visible even if its first conversation cannot start.
            try {
              const row = await call('createTraining', { roleId: id, mode: 'coach' })
              setSession(row)
            } catch (error) {
              setStartError(String(error))
            }
          }}
        />
      )}
    </section>
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
