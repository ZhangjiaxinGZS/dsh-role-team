import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useState } from 'react'
import { useUi } from '../ui.js'
import { useActivity } from './activity.js'
import { SessionPane } from './SessionPane.js'

function ChildRow({ child, selected, onClick }: {
  child: SubagentCatalogEntry; selected: boolean; onClick: () => void
}) {
  const { t } = useUi()
  const status = useActivity([child.id], '', false)
  const name = child.label || ('name' in child && child.name) || child.id
  return <button aria-pressed={selected} className="rt-child-row" onClick={onClick}>
    <span className="rt-seat-dot" data-status={status} title={t(status)} aria-label={t(status)} role="img" />
    <span title={name}>{name}</span>
  </button>
}

export function SubagentPanel({ parent, children }: { parent: SessionId; children: SubagentCatalogEntry[] }) {
  const { t } = useUi()
  const [id, select] = useState<SessionId>()
  const selected = children.find(c => c.id === id) ?? children[0]
  return <section className="rt-child-panel" aria-label={t('subagents')}>
    <div className="rt-child-list">
      {children.map(child => <ChildRow key={child.id} child={child} selected={child === selected} onClick={() => select(child.id)} />)}
    </div>
    {selected?.mode === 'external' ? <p>{t('externalChild')}</p> : selected && <SessionPane readOnly defaultPreview={false} target={{
      parentSessionId: parent, childSessionId: selected.id, mode: selected.mode,
    }} />}
  </section>
}
