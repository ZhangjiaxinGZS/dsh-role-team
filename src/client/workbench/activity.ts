import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useSyncExternalStore } from 'react'
import { useUi, type Ui } from '../ui.js'

type StatusStore = NonNullable<Ui['sessionStatus']>
const read = new WeakMap<StatusStore, Set<SessionId>>()
const views = new Set<() => void>()

// rc.5 acknowledges only the host main view. Embedded team panes keep a read
// receipt for this completion until the host starts a new turn or clears it.
export function observeCompletions(store: StatusStore) {
  const acknowledged = read.get(store) ?? new Set<SessionId>()
  read.set(store, acknowledged)
  return store.subscribe(() => {
    for (const id of acknowledged) {
      if (!store.getSnapshot().get(id)?.completionUnread) acknowledged.delete(id)
    }
  })
}

function activity(store: StatusStore | undefined, id: string) {
  const key = id as SessionId
  const value = store?.getSnapshot().get(key)
  if (value?.pendingInteraction?.kind === 'approval') return 'seatApproval'
  if (value?.running) return 'seatWorking'
  if (store && value?.completionUnread && !read.get(store)?.has(key)) return 'seatUnread'
  return 'seatIdle'
}

export function useActivity(ids: readonly string[], leader: string, aggregate: boolean) {
  const { sessionStatus: store } = useUi()
  return useSyncExternalStore(listener => {
    views.add(listener)
    const stop = store?.subscribe(listener)
    return () => { views.delete(listener); stop?.() }
  }, () => {
    let result: ReturnType<typeof activity> = 'seatIdle'
    for (const id of ids) {
      const state = activity(store, id)
      if (state === 'seatApproval') return state
      if (state === 'seatWorking') result = state
      if (state === 'seatUnread' && result === 'seatIdle' && (!aggregate || id === leader)) result = state
    }
    return result
  })
}

export function useReadReceipt(id: string | undefined) {
  const { sessionStatus: store } = useUi()
  useEffect(() => {
    if (!store || !id) return
    const key = id as SessionId
    const mark = () => {
      if (document.hidden || !document.hasFocus() || !store.getSnapshot().get(key)?.completionUnread) return
      const seen = read.get(store) ?? new Set<SessionId>()
      if (seen.has(key)) return
      seen.add(key)
      read.set(store, seen)
      for (const notify of views) notify()
    }
    mark()
    const stop = store.subscribe(mark)
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('focus', mark)
    return () => { stop(); document.removeEventListener('visibilitychange', mark); window.removeEventListener('focus', mark) }
  }, [id, store])
}
