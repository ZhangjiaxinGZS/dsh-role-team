import {
  Button,
  IconEditOutlineRegular,
  MarkdownText,
  IconCloseOutlineRegular,
  Tooltip,
  IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { z } from 'zod'
import { createContext, useContext, useEffect, useState } from 'react'
import {
  duplicateRoleName,
  memoryMeta,
  roleMeta,
  type EditResult,
  type FileContents,
  type FileRef,
  type MemoryMeta,
  type RoleMeta,
} from '../../shared/index.js'
import { DocumentError, parseMarkdown, serializeMarkdown } from '../../shared/markdown.js'
import { MoreMenu, Modal, Notice, useAction, useLoad, useUi } from '../ui.js'

// Allow intermediate empty or trailing-space names in the form, while the write contract stays strict.
type Conflict = Extract<EditResult, { code: 'conflict' }>
type Buffer = { text: string; base: FileContents | null; conflict?: Conflict }
export const EditorBuffers = createContext<Map<string, Buffer> | null>(null)
const roleForm = roleMeta.extend({ name: z.string(), summary: z.string().optional() })
const memoryForm = memoryMeta.extend({ title: z.string() })
const iconPaths = {
    back: 'M13 4l-6 6 6 6M7 10h10',
    history: 'M2 3v5h5M2.5 8a7.5 7.5 0 1 1 .7 6M10 5.5V10l3 2',
    expand: 'M11 3h6v6M17 3l-6 6M9 17H3v-6M3 17l6-6',
    restore: 'M17 3l-6 6m0-5v5h5M3 17l6-6m-5 0h5v5',
}
function ProfileIcon({ kind }: { kind: keyof typeof iconPaths }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={iconPaths[kind]} />
  </svg>
}

function Markdown({ text }: { text: string }) {
  const { t } = useUi()
  return <MarkdownText text={text} omitHtml labels={{
    code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') },
    footnotes: t('footnotes'),
  }} />
}

function ProfileText({ meta, body }: { meta: RoleMeta; body: string }) {
  return <>
    <h2>{meta.name}</h2>
    {meta.summary && <p className="rt-duty">{meta.summary}</p>}
    {body && <Markdown text={body} />}
  </>
}

export function Documents({
  roleId,
  revision,
  changed,
  nameTaken,
  fullscreen,
  toggleSize,
  collapse,
}: {
  roleId: string
  nameTaken?: (name: string) => boolean
  fullscreen?: boolean
  toggleSize?: () => void
  collapse?: () => void
  revision: number | null
  changed: () => void
}) {
  const { call, t } = useUi()
  const [version, refresh] = useState(0)
  const [entry, setEntry] = useState<{ id: string; file: FileContents; remove: boolean }>()
  const [panel, setPanel] = useState<{ mode: 'read' | 'edit' } | { mode: 'history'; hash: string }>({ mode: 'read' })
  const buffers = useContext(EditorBuffers)
  const [adding, setAdding] = useState(false)
  const action = useAction()
  const updated = () => {
    refresh((n) => n + 1)
    changed()
  }
  const memories = useLoad(JSON.stringify([roleId, revision, version]), async () => {
    if (!revision) return []
    return Promise.all(
      (await call('listMemories', roleId)).map(async (id) => {
        const file = await call('readDocument', { roleId, memoryId: id })
        if (!file) return null
        const parsed = parseMarkdown(file.text, memoryMeta, id, id + '.md')
        return { id, file, ...parsed }
      }),
    )
  })
  const role = useLoad(JSON.stringify([roleId, revision, version]), async () => {
    const file = await call('readDocument', { roleId })
    if (!file) return { file, profile: { meta: { id: roleId, name: roleId }, body: '' } }
    try {
      return { file, profile: parseMarkdown(file.text, roleMeta, roleId, roleId + '/role.md') }
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error
      return { file, error: error.detail.file + ' · ' + t('line') + ' ' + error.detail.line + ' · ' + error.message }
    }
  })
  const edit = () => setPanel({ mode: 'edit' })
  const read = () => setPanel({ mode: 'read' })
  return (
    <aside className="rt-docs">
      <header>
        <div className="rt-row">
          {panel.mode === 'history' ? (
            <Button size="sm" variant="outline" icon={<ProfileIcon kind="back" />} onClick={read}>
              {t('back')}
            </Button>
          ) : <>
            <h3>{t('card')}</h3>
            {panel.mode === 'read' && <Button size="sm" variant="outline" icon={<IconEditOutlineRegular size={14} />}
              disabled={!role.data} onClick={edit}>{t('edit')}</Button>}
          </>}
        </div>
        <div className="rt-row">
          {panel.mode === 'read' && <Button size="sm" variant="outline" icon={<ProfileIcon kind="history" />}
            disabled={!role.data?.file} onClick={() => {
              if (role.data?.file) setPanel({ mode: 'history', hash: role.data.file.hash })
            }}>{t('roleHistory')}</Button>}
          {toggleSize && (
            <Tooltip label={t(fullscreen ? 'restoreSplit' : 'expandProfile')} side="bottom">
              <button className="rt-icon" onClick={toggleSize} aria-label={t(fullscreen ? 'restoreSplit' : 'expandProfile')}>
                <ProfileIcon kind={fullscreen ? 'restore' : 'expand'} />
              </button>
            </Tooltip>
          )}
          {collapse && !fullscreen && (
            <Tooltip label={t('collapseProfile')} side="bottom">
              <button className="rt-icon" onClick={collapse} aria-label={t('collapseProfile')}>
                <IconCloseOutlineRegular size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <Notice>{role.error || memories.error || (panel.mode === 'read' && role.data?.error)}</Notice>
      {panel.mode === 'read' && role.data?.profile && (
        <article className="rt-profile-text" onDoubleClick={edit}>
          <ProfileText {...role.data.profile} />
        </article>
      )}
      {panel.mode === 'edit' && role.data && (
        <DocumentEditor
          key={roleId}
          nameTaken={nameTaken}
          file={{ roleId }}
          initial={role.data.file}
          cancel={read}
          changed={() => {
            read()
            updated()
          }}
        />
      )}
      {panel.mode === 'history' && (
        <RoleHistory
          roleId={roleId}
          hash={panel.hash}
          dirty={() => !!buffers?.has(roleId + '/role.md')}
          done={() => {
            read()
            updated()
          }}
        />
      )}
      {panel.mode === 'read' && (
        <section className="rt-experiences">
          <header className="rt-row">
            <h3>{t('memories')}</h3>
            <Button
              size="sm"
              variant="outline"
              icon={<IconPlusOutlineRegular size={14} />}
              onClick={() => setAdding(true)}
            >
              {t('newMemory')}
            </Button>
          </header>
          {memories.data?.map(
            (m) =>
              m && (
                <article key={m.id} className="rt-experience-card">
                  <div>
                    {m.meta.title !== m.body && <strong>{m.meta.title}</strong>}
                    <Markdown text={m.body} />
                  </div>
                  <MoreMenu
                    name={m.meta.title}
                    actions={{
                      edit: () => setEntry({ ...m, remove: false }),
                      deleteMemory: () => {
                        action.clear()
                        setEntry({ ...m, remove: true })
                      },
                    }}
                  />
                </article>
              ),
          )}
          {!memories.data?.some(Boolean) && <small>{t('rememberHint')}</small>}
        </section>
      )}
      {adding && (
        <ExperienceForm
          roleId={roleId}
          close={() => setAdding(false)}
          done={() => {
            setAdding(false)
            updated()
          }}
        />
      )}
      {entry &&
        (entry.remove ? (
          <Modal title={t('deleteMemory')} locked={action.busy} close={() => setEntry(undefined)}>
            <p>{t('deleteHint')}</p>
            <Notice>{action.error}</Notice>
            <button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  const result = await call('deleteDocument', {
                    roleId,
                    memoryId: entry.id,
                    expectedHash: entry.file.hash,
                  })
                  if (!result.ok) {
                    updated()
                    throw new Error(t('conflict'))
                  }
                  setEntry(undefined)
                  updated()
                })
              }
            >
              {t('deleteMemory')}
            </button>
          </Modal>
        ) : (
          <Modal title={t('editExperience')} close={() => setEntry(undefined)}>
            <DocumentEditor
              file={{ roleId, memoryId: entry.id }}
              initial={entry.file}
              changed={() => {
                setEntry(undefined)
                updated()
              }}
            />
          </Modal>
        ))}
    </aside>
  )
}
function RoleHistory({
  roleId,
  hash,
  dirty,
  done,
}: {
  roleId: string
  hash: string
  dirty: () => boolean
  done: () => void
}) {
  const { call, t } = useUi(),
    action = useAction()
  const rows = useLoad(roleId, () => call('roleHistory', { roleId }))
  const [revision, select] = useState<number>()
  const entry = rows.data?.find((r) => r.publishedRevision === revision) ?? rows.data?.[0]
  return (
    <section className="rt-history" aria-label={t('roleHistory')}>
      <Notice>{rows.error || action.error}</Notice>
      {entry ? (
        <>
          <ol className="rt-history-list" aria-label={t('revision')}>
            {rows.data?.map((r) => (
              <li key={r.publishedRevision}>
                <button
                  aria-pressed={r.publishedRevision === entry.publishedRevision}
                  onClick={() => select(r.publishedRevision)}
                >
                  {t('revision')} {r.publishedRevision} · {new Date(r.publishedAt).toLocaleString()}
                  <small>{r.role.meta.summary || r.role.meta.name}</small>
                </button>
              </li>
            ))}
          </ol>
          <article className="rt-history-preview">
            <ProfileText {...entry.role} />
          </article>
          <footer>
            <button
              className="rt-primary"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  if (dirty()) throw new Error(t('finishEditing'))
                  const result = await call('restoreRole', {
                    roleId,
                    revision: entry.publishedRevision,
                    expectedHash: hash,
                  })
                  if (!result.ok)
                    throw new Error(
                      result.code === 'conflict' ? t('restoreConflict') : result.error.message,
                    )
                  if (result.status.error) throw new Error(result.status.error.message)
                  done()
                })
              }
            >
              {t('restoreRole')}
            </button>
          </footer>
        </>
      ) : (
        <p>{t(rows.data ? 'noVersions' : 'loading')}</p>
      )}
    </section>
  )
}
function ExperienceForm({
  roleId,
  close,
  done,
}: {
  roleId: string
  close: () => void
  done: () => void
}) {
  const { call, t } = useUi(),
    action = useAction()
  const [body, setBody] = useState(''),
    [title, setTitle] = useState('')
  return (
    <Modal title={t('newMemory')} locked={action.busy} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            await call('rememberExperience', {
              roleId,
              body: body.trim(),
              ...(title.trim() && { title: title.trim() }),
            })
            done()
          })
        }}
      >
        <label>
          {t('experienceBody')}
          <textarea
            required
            data-modal-autofocus
            maxLength={24000}
            rows={4}
            value={body}
            placeholder={t('experienceExample')}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <details>
          <summary>{t('optionalTitle')}</summary>
          <label>
            {t('memoryTitle')}
            <input maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </details>
        <Notice>{action.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={action.busy || !body.trim()}>
            {t('remember')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
export function DocumentEditor({
  file,
  initial,
  changed,
  cancel,
  nameTaken,
}: {
  nameTaken?: (name: string) => boolean
  cancel?: () => void
  file: FileRef
  initial: FileContents | null
  changed: () => void
}) {
  const { call, t } = useUi(),
    a = useAction(),
    id = file.memoryId ?? file.roleId,
    path = file.roleId + '/' + (file.memoryId ? 'memories/' + id + '.md' : 'role.md')
  const [template] = useState(() =>
    serializeMarkdown(
      file.memoryId
        ? {
            id,
            title: '',
            scope: 'role_long_term',
            createdAt: new Date().toISOString(),
          }
        : { id, name: id },
      '',
    ),
  )
  const buffers = useContext(EditorBuffers),
    [draft] = useState(() => buffers?.get(path))
  const [base, setBase] = useState(draft ? draft.base : initial),
    [text, write] = useState(draft?.text ?? initial?.text ?? template),
    [conflict, setConflict] = useState<Conflict | undefined>(draft?.conflict),
    [saved, setSaved] = useState(false)
  useEffect(() => {
    if (text !== (base?.text ?? template) || conflict)
      buffers?.set(path, { text, base, conflict })
    else buffers?.delete(path)
  }, [buffers, path, text, base, conflict, template])
  // Refresh a clean editor after external saves or approved proposals. A dirty buffer retains its CAS base.
  const [observed, setObserved] = useState(initial?.hash)
  if (initial?.hash !== observed) {
    setObserved(initial?.hash)
    if (!conflict && text === (base?.text ?? template)) {
      setBase(initial)
      write(initial?.text ?? template)
    }
  }
  let parsed: { meta: RoleMeta | MemoryMeta; body: string } | undefined,
    diagnosis = ''
  try {
    parsed = file.memoryId
      ? parseMarkdown(text, memoryForm, id, path)
      : parseMarkdown(text, roleForm, id, path)
    const check = (file.memoryId ? memoryMeta : roleMeta).safeParse(parsed.meta)
    if (!check.success)
      parseMarkdown<RoleMeta | MemoryMeta>(text, file.memoryId ? memoryMeta : roleMeta, id, path)
  } catch (e) {
    diagnosis =
      e instanceof DocumentError
        ? e.detail.file + ' · ' + t('line') + ' ' + e.detail.line + ' · ' + e.message
        : String(e)
  }
  if (!diagnosis && parsed && 'name' in parsed.meta && nameTaken?.(parsed.meta.name)) diagnosis = t('duplicateRole')
  const doc = parsed
  const dirty = text !== (base?.text ?? template)
  const readable = (value: string) => {
    try {
      const data = file.memoryId
        ? parseMarkdown(value, memoryMeta, id, path)
        : parseMarkdown(value, roleMeta, id, path)
      return ['name' in data.meta ? data.meta.name : data.meta.title, data.body].join('\n')
    } catch {
      return value
    }
  }
  const edit = (value: string) => {
    write(value)
    setSaved(false)
  }
  return (
    <div className="rt-editor">
      {!parsed ? (
        <label>
          {t('repairFile')}
          <textarea
            className="rt-code"
            value={text}
            spellCheck={false}
            onChange={(e) => edit(e.target.value)}
          />
        </label>
      ) : (
        doc && (
          <>
            <label>
              {t(file.memoryId ? 'memoryTitle' : 'name')}
              <input
                value={'name' in doc.meta ? doc.meta.name : doc.meta.title}
                onChange={(e) =>
                  edit(
                    serializeMarkdown(
                      { ...doc.meta, [file.memoryId ? 'title' : 'name']: e.target.value },
                      doc.body,
                    ),
                  )
                }
              />
            </label>
            {'name' in doc.meta && (
              <label>
                {t('duty')}
                <input
                  maxLength={160}
                  value={doc.meta.summary ?? ''}
                  onChange={(e) =>
                    edit(serializeMarkdown({ ...doc.meta, summary: e.target.value }, doc.body))
                  }
                />
              </label>
            )}
            <label>
              {t(file.memoryId ? 'experienceBody' : 'body')}
              <textarea
                value={doc.body}
                onChange={(e) => edit(serializeMarkdown(doc.meta, e.target.value))}
              />
            </label>
          </>
        )
      )}
      <Notice>{diagnosis || a.error}</Notice>
      {conflict && (
        <section className="rt-conflict" role="alert">
          <h4>{t('conflict')}</h4>
          <div className="rt-diff">
            <div>
              {t('disk')}
              <pre>{conflict.current ? readable(conflict.current.text) : t('deleted')}</pre>
            </div>
            <div>
              {t('mine')}
              <pre>{readable(text)}</pre>
            </div>
          </div>
          <button
            onClick={() => {
              setBase(conflict.current)
              write(conflict.current?.text ?? template)
              setConflict(undefined)
            }}
          >
            {t('useDisk')}
          </button>
          <button
            onClick={() => {
              setBase(conflict.current)
              setConflict(undefined)
            }}
          >
            {t('merge')}
          </button>
        </section>
      )}
      <footer>
        <small>{t(saved ? 'saved' : dirty ? 'savedDirty' : 'editNext')}</small>
        {cancel && <Button size="sm" variant="outline" disabled={a.busy} onClick={() => {
          buffers?.delete(path)
          cancel()
        }}>{t('cancel')}</Button>}
        <button
          className="rt-primary"
          disabled={a.busy || !dirty || !!diagnosis || !!conflict}
          onClick={() =>
            a.run(async () => {
              const result = await call('saveDocument', {
                ...file,
                text,
                expectedHash: base?.hash ?? null,
              })
              if (!result.ok) {
                if (result.code === 'conflict') setConflict(result)
                else if (result.error.message === duplicateRoleName) throw new Error(t('duplicateRole'))
                else
                  throw new Error(
                    result.error.file +
                      ' · ' +
                      t('line') +
                      ' ' +
                      result.error.line +
                      ' · ' +
                      result.error.message,
                  )
                return
              }
              buffers?.delete(path)
              setBase(result.hash ? { text, hash: result.hash } : null)
              setSaved(true)
              changed()
            })
          }
        >
          {t('save')}
        </button>
      </footer>
    </div>
  )
}
