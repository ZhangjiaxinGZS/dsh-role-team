import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import en from '../../locales/en-US.json' with { type: 'json' }
import zh from '../../locales/zh-CN.json' with { type: 'json' }
import css from './ui.css'
import { TYPERT_REMOTE } from '../shared/remote.js'
import { Client, unwrap, type Labels, type Ui } from './ui.js'
import { App, LibrarySettings } from './App.js'
import { SessionChat } from './workbench/SessionPane.js'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'roleTeam.chat': { kind: 'single'; scope: 'session' }
  }
  interface LocaleNamespaceMap {
    roleTeam: Labels
  }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    roleTeam: unknown
  }
}
export const inject = ['remote', 'sessions', 'slots', 'locale']
export async function apply(ctx: Context) {
  await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => ctx.locale.register('roleTeam', { en: en.ui, zh: zh.ui }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  })
  const t = ctx.locale.bind('roleTeam')
  const workspace = ctx.get('uiWorkspace') as
    | { pickDirectory?: () => Promise<string | null> }
    | undefined
  const desktop = (
    globalThis as typeof globalThis & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }
  ).__DSH_DIRECTORY_PICKER__
  const options = { source: 'roleTeam' as const, facets: { conversation: true } }
  const settings = (
    ctx.remote as typeof ctx.remote & {
      settings?: import('@deepseek-ai/dsh-typert-protocol').TypertRemoteNamespaceMap['settings']
    }
  ).settings
  const shared: Ui = {
    t,
    retain: (target) => ctx.sessions.retain(target, options),
    call: (async (method, ...args) =>
      unwrap(await Reflect.apply(ctx.remote.roleTeam[method], ctx.remote.roleTeam, args))) as Ui['call'],
    SessionProvider: ({ children }) => children,
    chat: () => null,
    pick: desktop?.pick
      ? () => desktop.pick()
      : workspace?.pickDirectory
        ? () => workspace.pickDirectory!()
        : undefined,
    settings: settings && {
      async read() {
        const view = unwrap(await settings.describe())
        const row = view.namespaces.find((n) => n.ns === 'role-team')
        return { writable: view.writable && !!row, revision: row?.revision ?? 0 }
      },
      async write(path, revision) {
        unwrap(await settings.update('role-team', { roleStoreDir: path }, revision))
      },
    },
  }
  function Main({
    SessionProvider,
    renderSlot,
    t,
  }: PropsRenderSlots<'roleTeam.chat'> & PropsLocale<'roleTeam'>) {
    return (
      <Client.Provider
        value={{ ...shared, t, SessionProvider, chat: () => renderSlot('roleTeam.chat', {}) }}
      >
        <App />
      </Client.Provider>
    )
  }
  function Settings({ t }: PropsLocale<'roleTeam'>) {
    return (
      <Client.Provider value={{ ...shared, t }}>
        <LibrarySettings />
      </Client.Provider>
    )
  }
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'role-team',
        order: 12,
        locale: 'roleTeam',
        label: () => t('title'),
      },
      ({ size }: PropsRuntime<'sidebar.panellist'>) => (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20v-2a6 6 0 0112 0v2M16 5a3 3 0 010 6m1 3a5 5 0 014 5" />
        </svg>
      ),
    ),
  )
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: 'role-team',
        locale: 'roleTeam',
        children: { 'roleTeam.chat': { kind: 'single', scope: 'session' } },
      },
      Main,
    ),
  )
  ctx.slots.inject('roleTeam.chat', () => ctx.slots.register({ name: 'roleTeam.chat' }, SessionChat))
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'role-team', locale: 'roleTeam', label: () => t('title') },
      Settings,
    ),
  )
}
