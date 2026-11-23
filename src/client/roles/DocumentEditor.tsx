import { z } from 'zod'
import { createContext, useContext, useEffect, useState } from 'react'
import {
  memoryMeta,
  roleMeta,
  type EditResult,
  type FileContents,
  type FileRef,
  type MemoryMeta,
  type RoleMeta,
} from '../../shared/index.js'
import { DocumentError, parseMarkdown, serializeMarkdown } from '../../shared/markdown.js'
import { Modal, Notice, useAction, useLoad, useUi } from '../ui.js'

// Allow intermediate empty or trailing-space names in the form, while the write contract stays strict.
type Conflict = Extract<EditResult, { code: 'conflict' }>
type Buffer = { text: string; base: FileContents | null; source: boolean; conflict?: Conflict }
export const EditorBuffers = createContext<Map<string, Buffer> | null>(null)
const roleForm = roleMeta.extend({ name: z.string(), summary: z.string().optional() })
const memoryForm = memoryMeta.extend({ title: z.string() })
export function Documents({
  roleId,
  revision,
  changed,
}: {
  roleId: string
  revision: number | null
  changed: () => void
}) {
  const { call, t } = useUi()
  const [version, refresh] = useState(0)
  const [entry, setEntry] = useState<{ id: string; file: FileContents; remove: boolean }>()
  const [historyHash, showHistory] = useState('')
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
  const role = useLoad(JSON.stringify([roleId, revision, version]), () =>
    call('readDocument', { roleId }),
  )
  return (
    <aside className="rt-docs">
      <header>
        <h3>{t('card')}</h3>
        <button
          className="rt-text-button"
          disabled={!role.data}
          onClick={() => showHistory(role.data!.hash)}
        >
          {t('roleHistory')}
        </button>
      </header>
      <Notice>{role.error || memories.error}</Notice>
      {role.data !== undefined && (
        <DocumentEditor key={roleId} file={{ roleId }} initial={role.data} changed={updated} />
      )}
      {historyHash && (
        <RoleHistory
          roleId={roleId}
          hash={historyHash}
          close={() => showHistory('')}
          dirty={() => !!buffers?.has(roleId + '/role.md')}
          done={() => {
            showHistory('')
            updated()
          }}
        />
      )}
      <section className="rt-experiences">
        <header className="rt-row">
          <h3>{t('memories')}</h3>
          <button onClick={() => setAdding(true)}>{t('newMemory')}</button>
        </header>
        {memories.data?.map(
          (m) =>
            m && (
              <article key={m.id} className="rt-experience-card">
                {m.meta.title !== m.body && <strong>{m.meta.title}</strong>}
                <p>{m.body}</p>
                <footer className="rt-row">
                  <button onClick={() => setEntry({ ...m, remove: false })}>{t('edit')}</button>
                  <button
                    onClick={() => {
                      action.clear()
                      setEntry({ ...m, remove: true })
                    }}
                  >
                    {t('deleteMemory')}
                  </button>
                </footer>
              </article>
            ),
        )}
        {!memories.data?.some(Boolean) && <small>{t('rememberHint')}</small>}
      </section>
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
  close,
  dirty,
  done,
}: {
  roleId: string
  hash: string
  close: () => void
  dirty: () => boolean
  done: () => void
}) {
  const { call, t } = useUi(),
    action = useAction()
  const rows = useLoad(roleId, () => call('roleHistory', { roleId }))
  const [revision, select] = useState<number>()
  const entry = rows.data?.find((r) => r.publishedRevision === revision) ?? rows.data?.[0]
  return (
    <Modal title={t('roleHistory')} close={close} locked={action.busy}>
      <Notice>{rows.error || action.error}</Notice>
      {entry ? (
        <>
          <label>
            {t('revision')}
            <select value={entry.publishedRevision} onChange={(e) => select(Number(e.target.value))}>
              {rows.data?.map((r) => (
                <option key={r.publishedRevision} value={r.publishedRevision}>
                  {new Date(r.publishedAt).toLocaleString()} · {r.role.meta.summary || r.role.meta.name}
                </option>
              ))}
            </select>
          </label>
          <article className="rt-history-preview">
            <h3>{entry.role.meta.name}</h3>
            <p>{entry.role.meta.summary}</p>
            <pre>{entry.role.body}</pre>
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
    </Modal>
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
}: {
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
    [source, setSource] = useState(draft?.source ?? false),
    [conflict, setConflict] = useState<Conflict | undefined>(draft?.conflict),
    [saved, setSaved] = useState(false)
  useEffect(() => {
    if (text !== (base?.text ?? template) || conflict)
      buffers?.set(path, { text, base, source, conflict })
    else buffers?.delete(path)
  }, [buffers, path, text, base, source, conflict, template])
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
  const doc = parsed
  const dirty = text !== (base?.text ?? template)
  const readable = (value: string) => {
    if (source) return value
    try {
      const data = file.memoryId
        ? parseMarkdown(value, memoryMeta, id, path)
        : parseMarkdown(value, roleMeta, id, path)
      return ['name' in data.meta ? data.meta.name : data.meta.title, data.body].join('\n')
    } catch {
      return value
    }
  }
  const raw = source || !parsed,
    edit = (value: string) => {
      write(value)
      setSaved(false)
    }
  return (
    <div className="rt-editor">
      <div className="rt-row">
        <div className="rt-segment">
          {(['visual', 'source'] as const).map((k) => (
            <button
              key={k}
              aria-pressed={(k === 'source') === raw}
              disabled={k === 'visual' && !parsed}
              onClick={() => setSource(k === 'source')}
            >
              {t(k)}
            </button>
          ))}
        </div>
      </div>
      {raw ? (
        <label>
          {t('source')}
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
