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
const roleForm = roleMeta.extend({ name: z.string() })
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
  const [memoryId, select] = useState('')
  const [version, refresh] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
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
        if (!file) return { id, title: id }
        try {
          const { meta } = parseMarkdown(file.text, memoryMeta, id, id + '.md')
          return { id, title: meta.title, status: meta.status }
        } catch {
          return { id, title: id }
        }
      }),
    )
  })
  const role = useLoad(JSON.stringify([roleId, revision, version]), () =>
    call('readDocument', { roleId }),
  )
  const memory = useLoad(JSON.stringify([roleId, memoryId, revision, version]), () =>
    memoryId ? call('readDocument', { roleId, memoryId }) : Promise.resolve(null),
  )
  return (
    <aside className="rt-docs">
      <header>
        <h3>{t('card')}</h3>
      </header>
      <Notice>{role.error || memories.error || memory.error || action.error}</Notice>
      {role.data !== undefined && (
        <DocumentEditor key={roleId} file={{ roleId }} initial={role.data} changed={updated} />
      )}
      <section className="rt-experiences">
        <h3>{t('memories')}</h3>
        {memories.data?.map((m) => (
          <button
            key={m.id}
            aria-pressed={memoryId === m.id}
            onClick={() => {
              select(memoryId === m.id ? '' : m.id)
              setConfirmDelete(false)
            }}
          >
            {m.title} {m.status && <small>{t(m.status)}</small>}
          </button>
        ))}
        {memoryId && memory.data !== undefined && (
          <>
            <DocumentEditor
              key={memoryId}
              file={{ roleId, memoryId }}
              initial={memory.data}
              changed={updated}
            />
            {memory.data && <button onClick={() => setConfirmDelete(true)}>{t('deleteMemory')}</button>}
          </>
        )}
        <button
          className="rt-text-button"
          disabled={!revision}
          onClick={() => {
            select('memory-' + crypto.getRandomValues(new Uint32Array(2)).join('-'))
            setConfirmDelete(false)
          }}
        >
          ＋ {t('newMemory')}
        </button>
      </section>
      {confirmDelete && (
        <Modal title={t('deleteMemory')} locked={action.busy} close={() => setConfirmDelete(false)}>
          <p>{t('deleteHint')}</p>
          <Notice>{action.error}</Notice>
          <button
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                if (!memory.data) return
                const result = await call('deleteDocument', {
                  roleId,
                  memoryId,
                  expectedHash: memory.data.hash,
                })
                if (!result.ok) throw new Error(t('conflict'))
                select('')
                setConfirmDelete(false)
                updated()
              })
            }
          >
            {t('deleteMemory')}
          </button>
        </Modal>
      )}
    </aside>
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
            status: 'draft',
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
        {parsed && 'status' in parsed.meta && <span className="rt-tag">{t(parsed.meta.status)}</span>}
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
            {'status' in doc.meta && (
              <label>
                {t('status')}
                <select
                  value={doc.meta.status}
                  onChange={(e) =>
                    edit(serializeMarkdown({ ...doc.meta, status: e.target.value }, doc.body))
                  }
                >
                  {(['draft', 'published', 'archived'] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(k)}
                    </option>
                  ))}
                </select>
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
              <pre>{conflict.current?.text ?? t('deleted')}</pre>
            </div>
            <div>
              {t('mine')}
              <pre>{text}</pre>
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
              setSource(true)
              setConflict(undefined)
            }}
          >
            {t('merge')}
          </button>
        </section>
      )}
      <footer>
        <small>{t(saved ? 'saved' : text !== base?.text ? 'savedDirty' : 'editNext')}</small>
        <button
          className="rt-primary"
          disabled={a.busy || !!diagnosis || !!conflict}
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
