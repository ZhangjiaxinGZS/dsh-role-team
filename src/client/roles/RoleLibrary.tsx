import { useState } from 'react'
import type { Diagnostic } from '../../shared/index.js'
import { Avatar, Notice, useUi } from '../ui.js'
import type { RoleChoice } from '../team-setup/TeamSetup.js'
import { Documents, IdentifierModal } from './DocumentEditor.js'
import { TrainingDialog, TrainingPanel } from './Training.js'
export type LibraryRole = RoleChoice & { error?: Diagnostic | null }
export function RoleLibrary({
  roles,
  path,
  changed,
}: {
  roles: LibraryRole[]
  path?: string
  changed: () => void
}) {
  const { t } = useUi(),
    [role, setRole] = useState(''),
    [session, setSession] = useState(''),
    [modal, setModal] = useState(''),
    id = role || roles[0]?.id
  const active = roles.find((r) => r.id === id)
  return (
    <section className="rt-library">
      <header className="rt-toolbar">
        <div>
          <h2>{t('library')}</h2>
          <small title={path}>{path}</small>
        </div>
        <div className="rt-row">
          <button onClick={() => setModal('manual')}>{t('newRole')}</button>
          <button className="rt-primary" onClick={() => setModal('chat')}>
            {t('trainNew')}
          </button>
        </div>
      </header>
      <div className="rt-library-grid">
        <aside className="rt-rolelist">
          {roles.map((r) => (
            <button
              key={r.id}
              aria-pressed={id === r.id}
              onClick={() => {
                setRole(r.id)
                setSession('')
              }}
            >
              <Avatar name={r.name} />
              <span>
                <strong>{r.name}</strong>
                <small>{r.revision ? 'r' + r.revision : t('trainingDraft')}</small>
              </span>
            </button>
          ))}
        </aside>
        {id ? (
          <div className="rt-detail" key={id}>
            <header>
              <h2>{active?.name ?? id}</h2>
              <small>{id}</small>
            </header>
            {active?.error && (
              <Notice>
                {active.error.file} · {t('line')} {active.error.line} · {active.error.message}
              </Notice>
            )}
            <div className="rt-split">
              <Documents roleId={id} revision={active?.revision ?? null} changed={changed} />
              <TrainingPanel
                key={id + session}
                roleId={id}
                hasRole={active?.revision != null}
                initialId={session}
                changed={changed}
              />
            </div>
          </div>
        ) : (
          <div className="rt-empty">
            <h2>{t('emptyRoles')}</h2>
            <p>{t('emptyRoleHint')}</p>
          </div>
        )}
      </div>
      {modal === 'manual' && (
        <IdentifierModal
          title={t('newRole')}
          label={t('roleId')}
          close={() => setModal('')}
          submit={async (value) => {
            if (roles.some((r) => r.id === value)) throw new Error(t('conflict'))
            setRole(value)
            setSession('')
            setModal('')
          }}
        />
      )}
      {modal === 'chat' && (
        <TrainingDialog
          close={() => setModal('')}
          done={(row) => {
            setRole(row.roleId)
            setSession(row.trainingId)
            setModal('')
            changed()
          }}
        />
      )}
    </section>
  )
}
