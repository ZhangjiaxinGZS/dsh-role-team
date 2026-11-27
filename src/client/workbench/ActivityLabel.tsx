import { useUi } from '../ui.js'
import { useActivity } from './activity.js'

export function ActivityLabel({ title, ids, leader }: { title: string; ids: readonly string[]; leader?: string }) {
  const { t } = useUi()
  const status = useActivity(ids, leader ?? '', leader !== undefined)
  return <span className="rt-activity-label" data-unread={status === 'seatUnread' || undefined}>
    {status !== 'seatIdle' && <span role="img" aria-label={t(status)} title={t(status)} className="rt-seat-dot" data-status={status} />}
    <span>{title}</span>
  </span>
}
