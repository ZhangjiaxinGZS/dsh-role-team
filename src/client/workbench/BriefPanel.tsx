import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useImperativeHandle, useState, type RefObject } from 'react'
import type { TeamBrief } from '../../shared/index.js'
import { Modal, Notice, useAction, useLoad, useUi, type Run } from '../ui.js'

export type BriefGuard = (leave: () => void) => void

export function BriefPanel({ run, guard }: { run: Run; guard: RefObject<BriefGuard> }) {
  const { t, call } = useUi()
  const loaded = useLoad('brief:' + run.runId, () => call('getTeamBrief', { runId: run.runId }), 2500)
  const action = useAction()
  const [draft, setDraft] = useState<{ text: string; original: string; hash: string | null }>()
  const [conflict, setConflict] = useState<TeamBrief | null>()
  const [departure, setDeparture] = useState<() => void>()
  const active = run.status === 'active'
  const brief = loaded.data
  const template = run.locale === 'en' ? '## Current goal\n\n## Decisions and guardrails\n\n## Stage and artifact paths\n'
    : '## 当前主线目标\n\n## 已拍板决定与红线\n\n## 当前阶段与产物路径\n'

  useImperativeHandle(guard, () => leave => {
    if (action.busy) return
    if (draft && draft.text !== draft.original) setDeparture(() => leave)
    else leave()
  })

  function edit(current: TeamBrief | null) {
    const text = current?.text ?? template
    setDraft({ text, original: text, hash: current?.hash ?? null })
    setConflict(undefined)
  }

  function save(expectedHash: string | null, leave?: () => void) {
    if (!draft || !active) return
    void action.run(async () => {
      setDeparture(undefined)
      const result = await call('saveTeamBrief', { runId: run.runId, text: draft.text, expectedHash })
      if (!result.ok) {
        setConflict(result.current)
        return
      }
      setDraft(undefined)
      setConflict(undefined)
      loaded.refresh()
      leave?.()
    })
  }

  return <section className="rt-brief-panel" aria-label={t('teamBrief')}>
    <Notice>{loaded.error || action.error}</Notice>
    {draft && active ? <>
      {conflict !== undefined && <div className="rt-brief-conflict" role="alert">
        {t('briefConflict')}
        <button disabled={action.busy} onClick={() => edit(conflict)}>{t('briefUseLatest')}</button>
        <button disabled={action.busy} onClick={() => save(conflict?.hash ?? null)}>{t('briefOverwrite')}</button>
      </div>}
      <textarea autoFocus aria-label={t('teamBrief')} maxLength={4000} value={draft.text} disabled={action.busy}
        onChange={e => setDraft({ ...draft, text: e.target.value })}/>
      {draft.text.length > 1500 && <small className="rt-brief-warning">{t('briefLengthHint')}</small>}
      <footer><small data-warning={draft.text.length > 1500 || undefined}>{draft.text.length} / 1500</small>
        <button disabled={action.busy} onClick={() => { setDraft(undefined); setConflict(undefined); action.clear() }}>{t('cancel')}</button>
        <button className="rt-primary" disabled={action.busy || conflict !== undefined} onClick={() => save(draft.hash)}>{t('save')}</button>
      </footer>
    </> : brief === undefined ? !loaded.error && t('loading') : brief ? <>
      <header><small><time dateTime={brief.updatedAt}>{new Date(brief.updatedAt).toLocaleString()}</time> · {t(brief.updatedBy === 'leader' ? 'briefUpdatedByLeader' : 'briefUpdatedByUser')}</small>
        {active && <button onClick={() => edit(brief)}>{t('edit')}</button>}</header>
      <div className="rt-brief-body">
        <MarkdownText text={brief.text} omitHtml labels={{ code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes') }}/>
      </div>
    </> : <>
      <strong>{t('emptyBrief')}</strong><p>{t('emptyBriefHint')}</p>
      {active && <button className="rt-primary" onClick={() => edit(null)}>{t('createBrief')}</button>}
    </>}
    {departure && draft && <Modal title={t('briefUnsaved')} close={() => setDeparture(undefined)}>
      <footer><button autoFocus onClick={() => setDeparture(undefined)}>{t('keepEditing')}</button>
        <button onClick={departure}>{t('briefDiscard')}</button>
        <button disabled={!active} onClick={() => save(draft.hash, departure)}>{t('briefSaveAndLeave')}</button>
      </footer>
    </Modal>}
  </section>
}
