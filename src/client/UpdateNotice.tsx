import { useState } from 'react'
import { CopyButton, Modal, useLoad, useUi } from './ui.js'

export function UpdateNotice() {
  const { call, t } = useUi()
  const { data, error } = useLoad('release-update', () => call('checkUpdate', {}), 6 * 60 * 60 * 1000)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState('')
  const version = data?.latestVersion
  if (error || !data?.enabled || !data.hasUpdate || !version || dismissed === version) return null
  const key = 'dsh-role-team:ignored-release:' + version
  try { if (localStorage.getItem(key)) return null } catch { /* Storage can be disabled. */ }
  const ignore = () => {
    try { localStorage.setItem(key, '1') } catch { /* Dismiss for this mount. */ }
    setDismissed(version)
    setOpen(false)
  }
  const file = `"$PWD/dsh-role-team-${version}.tgz"`
  return <>
    <button type="button" className="rt-update-badge" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {t('updateAvailable')} v{version}
    </button>
    {open && <Modal title={t('updateTitle')} close={() => setOpen(false)}>
      <div className="rt-update-details">
        <dl>
          <div><dt>{t('updateCurrent')}</dt><dd>v{data.currentVersion}</dd></div>
          <div><dt>{t('updateLatest')}</dt><dd>v{version}</dd></div>
        </dl>
        <a href={data.releaseUrl} target="_blank" rel="noreferrer">{t('updateRelease')}</a>
        <p>{t('updateInstructions')}</p>
        {([
          ['Web', 'dsh plugin --profile web'],
          ['Desktop (macOS)', '"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop'],
        ] as const).map(([platform, cli]) => {
          const command = `shasum -a 256 -c SHA256SUMS.txt && ${cli} add ${file}`
          return <section key={platform}>
            <div><strong>{platform}</strong><CopyButton text={command} label={t('updateCopy') + ' · ' + platform} /></div>
            <code>{command}</code>
          </section>
        })}
        <button type="button" onClick={ignore}>{t('updateIgnore')}</button>
      </div>
    </Modal>}
  </>
}
