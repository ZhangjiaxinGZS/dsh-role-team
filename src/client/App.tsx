import { useNavigation } from './navigation.js'
import { Button, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useRef, useSyncExternalStore } from 'react'
import { type WorkspacePreview, Notice, useAction, useLoad, useUi } from './ui.js'
import { RoleLibrary, type LibraryRole } from './roles/RoleLibrary.js'
import { EditorBuffers } from './roles/DocumentEditor.js'
import { Workbench } from './workbench/Workbench.js'
export function PreviewToggle({ preview }: { preview: WorkspacePreview }) {
  const { t } = useUi()
  const state = useSyncExternalStore(preview.subscribe, preview.state)
  const shortcut = useSyncExternalStore(preview.subscribe, preview.shortcut)
  const label = t(state === 'open' ? 'closePreview' : 'openPreview')
  return (
    <div className="rt-preview-toggle">
      <Tooltip label={label} shortcutKeys={shortcut?.keys} side="bottom" delayMs={500}>
        <Button size="sm" aria-label={label} aria-keyshortcuts={shortcut?.aria}
          aria-expanded={state === 'open'} disabled={state === 'unavailable'} onClick={preview.toggle}>
          <IconPanelLeftOutlineRegular size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  )
}

export function App() {
  const { call, t, preview } = useUi(),
    [view, open] = useNavigation('page')
  const [buffers] = useState(() => new Map()),
    names = useRef(new Map<string, { name: string; revision: number; empty: boolean }>())
  const catalog = useLoad(
    'library',
    async () => {
      const [files, trainings] = await Promise.all([call('listRoles'), call('listTrainings', {})])
      const rows: LibraryRole[] = await Promise.all(
        files.map(async (f) => {
          let name = f.roleId
          if (f.publishedRevision) {
            const cached = names.current.get(f.roleId)
            if (cached?.revision !== f.publishedRevision) {
              const snap = await call('readSnapshot', f.roleId, f.publishedRevision)
              names.current.set(f.roleId, {
                name: snap.role.meta.name,
                revision: f.publishedRevision,
                empty: !snap.role.body.trim(),
              })
            }
            name = names.current.get(f.roleId)!.name
          }
          return {
            id: f.roleId,
            name,
            revision: f.publishedRevision,
            error: f.error,
            empty: names.current.get(f.roleId)?.empty,
          }
        }),
      )
      for (const { roleId } of trainings)
        if (!rows.some((r) => r.id === roleId)) rows.push({ id: roleId, name: roleId, revision: null })
      return rows
    },
    6000,
  )
  return (
    <main className="rt-app">
      <header className="rt-top" data-window-drag>
        <h1>{t('title')}</h1>
        <nav>
          {(['teams', 'library'] as const).map((k) => (
            <button key={k} aria-current={view === k ? 'page' : undefined} onClick={() => open(k)}>
              {t(k)}
            </button>
          ))}
        </nav>
        {preview && <PreviewToggle preview={preview} />}
      </header>
      <Notice>{catalog.error}</Notice>
      {view === 'teams' ? (
        <Workbench roles={catalog.data ?? []} />
      ) : (
        <EditorBuffers.Provider value={buffers}>
          <RoleLibrary roles={catalog.data ?? []} changed={catalog.refresh} />
        </EditorBuffers.Provider>
      )}
    </main>
  )
}
export function LibrarySettings() {
  const { call, t, settings, pick } = useUi(),
    info = useLoad('settings', () => call('libraryInfo', {})),
    access = useLoad('settings-access', async () => settings?.read()),
    a = useAction(),
    [value, setValue] = useState<string>()
  const data = info.data,
    path = value ?? data?.configuredPath ?? ''
  return (
    <section className="rt-settings">
      <h2>{t('libraryPath')}</h2>
      <code>{data?.activePath}</code>
      <p>{t('pathHint')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void a.run(async () => {
            if (!access.data?.writable || !settings) return
            try {
              await settings.write(path.trim(), access.data.revision)
            } finally {
              access.refresh()
              info.refresh()
            }
            setValue(undefined)
          })
        }}
      >
        <label>
          {t('configured')}
          <span className="rt-inline">
            <input
              required
              disabled={!access.data?.writable}
              value={path}
              onChange={(e) => setValue(e.target.value)}
            />
            {pick && (
              <button
                type="button"
                disabled={!access.data?.writable}
                onClick={() =>
                  a.run(async () => {
                    const p = await pick()
                    if (p) setValue(p)
                  })
                }
              >
                {t('browse')}
              </button>
            )}
          </span>
        </label>
        {data && !access.data?.writable && <small>{t('settingsUnavailable')}</small>}
        <Notice>{a.error || info.error || access.error}</Notice>
        <button
          className="rt-primary"
          disabled={a.busy || !access.data?.writable || !path.trim() || path === data?.configuredPath}
        >
          {t('save')}
        </button>
      </form>
    </section>
  )
}
