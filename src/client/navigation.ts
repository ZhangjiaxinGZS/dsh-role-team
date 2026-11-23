import { useState } from 'react'

type Navigation = {
  page: 'teams' | 'library'
  role: string
  team: string
  roleView: 'chatOnly' | 'splitView' | 'settingsOnly'
}

const defaults: Navigation = { page: 'teams', role: '', team: '', roleView: 'splitView' }
const memory = { ...defaults }

export function useNavigation<K extends keyof Navigation>(key: K) {
  const storageKey = 'dsh.roleTeam.navigation.' + key
  const [value, update] = useState<Navigation[K]>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (
        saved !== null &&
        (key === 'role' ||
          key === 'team' ||
          (key === 'page' ? ['teams', 'library'] : ['chatOnly', 'splitView', 'settingsOnly']).includes(
            saved,
          ))
      ) {
        return saved as Navigation[K]
      }
    } catch {
      /* The current window still remembers its selection when storage is unavailable. */
    }
    return memory[key]
  })
  return [
    value,
    (next: Navigation[K]) => {
      memory[key] = next
      try {
        localStorage.setItem(storageKey, next)
      } catch {
        /* Storage can be disabled in an embedded client. */
      }
      update(next)
    },
  ] as const
}
