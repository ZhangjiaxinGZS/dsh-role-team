import { useState } from 'react'

type Navigation = {
  page: 'teams' | 'library'
  role: string
  team: string | null
}

type RoleView = 'chatOnly' | 'splitView' | 'settingsOnly'
const defaults: Navigation = { page: 'teams', role: '', team: null }
const memory = new Map<string, string>()

function read(key: string) {
  try {
    return localStorage.getItem('dsh.roleTeam.navigation.' + key) ?? memory.get(key)
  } catch {
    return memory.get(key)
  }
}

function remember(key: string, value: string) {
  memory.set(key, value)
  try {
    localStorage.setItem('dsh.roleTeam.navigation.' + key, value)
  } catch {
    /* The current window still remembers its selection when storage is unavailable. */
  }
}

export function useNavigation<K extends keyof Navigation>(key: K) {
  const [value, update] = useState<Navigation[K]>(() => {
    const saved = read(key)
    if (saved !== undefined && (key !== 'page' || saved === 'teams' || saved === 'library')) {
      return saved as Navigation[K]
    }
    return defaults[key]
  })
  return [
    value,
    (next: NonNullable<Navigation[K]>) => {
      remember(key, next)
      update(next)
    },
  ] as const
}

export function rememberRoleView(id: string, view: RoleView) {
  remember('roleView.' + id, view)
}

// RoleDetail is keyed by id. Existing installations used one shared view preference.
export function useRoleView(id: string) {
  const [view, update] = useState<RoleView>(() => {
    const saved = read('roleView.' + id) ?? read('roleView')
    return saved === 'chatOnly' || saved === 'settingsOnly' ? saved : 'splitView'
  })
  return [
    view,
    (next: RoleView) => {
      rememberRoleView(id, next)
      update(next)
    },
  ] as const
}
