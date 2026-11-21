import { z } from 'zod'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  fileId,
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
  const { call, t } = useUi(),
    [memoryId, select] = useState(''),
    [creating, setCreating] = useState(false)
  const memories = useLoad(roleId + ':' + revision, () =>
    revision ? call('listMemories', roleId) : Promise.resolve([]),
  )
  const file: FileRef = { roleId, ...(memoryId && { memoryId }) }
  const content = useLoad(JSON.stringify(file), () => call('readDocument', file))
  const previousRevision = useRef(revision)
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision
      content.refresh()
    }
  }, [revision, content.refresh])
  const [stamp, setStamp] = useState(0)
  return (
    <section className="rt-docs">
      <header>
        <h3>{t('documents')}</h3>
        <button disabled={!revision} onClick={() => setCreating(true)}>
          ＋ {t('newMemory')}
        </button>
      </header>
      <select aria-label={t('documents')} value={memoryId} onChange={(e) => select(e.target.value)}>
        <option value="">role.md</option>
        {[...new Set([...(memories.data ?? []), ...(memoryId ? [memoryId] : [])])].map((id) => (
          <option key={id} value={id}>
            memories/{id}.md
          </option>
        ))}
      </select>
      <Notice>{content.error || memories.error}</Notice>
      {content.data !== undefined && (
        <DocumentEditor
          key={JSON.stringify(file) + ':' + stamp}
          file={file}
          initial={content.data}
          changed={() => {
            changed()
            memories.refresh()
            content.refresh()
          }}
        />
      )}
      {creating && (
        <IdentifierModal
          title={t('newMemory')}
          label={t('entryId')}
          close={() => setCreating(false)}
          submit={async (id) => {
            if ((await call('listMemories', roleId)).includes(id)) throw new Error(t('conflict'))
            select(id)
            setStamp((n) => n + 1)
            setCreating(false)
          }}
        />
      )}
    </section>
  )
}
export function IdentifierModal({
  title,
  label,
  close,
  submit,
}: {
  title: string
  label: string
  close: () => void
  submit: (id: string) => Promise<void>
}) {
  const { t } = useUi(),
    a = useAction(),
    [id, setId] = useState('')
  return (
    <Modal title={title} close={close} locked={a.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void a.run(() => submit(fileId.parse(id)))
        }}
      >
        <label>
          {label}
          <input
            required
            minLength={1}
            maxLength={128}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <small>{t('idHint')}</small>
        <Notice>{a.error}</Notice>
        <footer>
          <button className="rt-primary" disabled={a.busy}>
            {t('create')}
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
            title: id,
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
              {t('name')}
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
              {t('body')}
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
