import type {
  ConversationStore,
  ConversationSessionHeaderInjected,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type {
  PermissionSelectProps,
  PermissionSelectInjected,
} from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SlotComponent, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
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
import { ChildControls, ChildPermission, SessionChat } from './workbench/SessionPane.js'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'roleTeam.leadPermission': SlotMap['conversation.input.permission']
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
  ctx.inject(['remote.roleTeam'], mount)
}

function mount(ctx: Context) {
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
  const shared: Ui = {
    t,
    retain: (target) => ctx.sessions.retain(target, options),
    call: (async (method, ...args) => {
      const input =
        method === 'createTeam' || method === 'createTraining' || method === 'openTraining'
          ? [{ ...Object(args[0]), locale: ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en' }]
          : args
      return unwrap(await Reflect.apply(ctx.remote.roleTeam[method], ctx.remote.roleTeam, input))
    }) as Ui['call'],
    SessionProvider: ({ children }) => children,
    chat: () => null,
    pick: desktop?.pick
      ? () => desktop.pick()
      : workspace?.pickDirectory
        ? () => workspace.pickDirectory!()
        : undefined,
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
  // Share the host's per-session view store and selection action. The host owns its header outlet.
  ctx.slots.inject('roleTeam.chat', () => {
    const slot = 'conversation.session.header'
    let active: StoredEntry | undefined
    let remove: (() => void) | undefined
    const sync = () => {
      const entry = ctx.slots.entriesOfSlot(slot)[0]
      if (entry === active) return
      remove?.()
      remove = undefined
      active = entry
      if (!entry?.store || !entry.inject) return
      remove = ctx.slots.register(
        {
          name: 'roleTeam.chat',
          store: entry.store as ConversationStore,
          inject: entry.inject as unknown as (
            id: SessionId,
            actions: BoundActions<ConversationStore>,
          ) => ConversationSessionHeaderInjected,
        },
        SessionChat,
      )
    }
    sync()
    const unsubscribe = ctx.slots.subscribe(slot, sync)
    return () => {
      unsubscribe()
      remove?.()
    }
  })
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'role-team-member-permission',
        children: { 'roleTeam.leadPermission': { kind: 'single', scope: 'session' } },
      },
      ChildPermission,
    ),
  )
  // Reuse the installed permission picker, including its catalog and risk confirmation.
  // Only this outlet is rendered under the lead session; the rest of the composer stays member-scoped.
  ctx.slots.inject('roleTeam.leadPermission', () => {
    const slot = 'conversation.input.permission'
    let active: StoredEntry | undefined
    let remove: (() => void) | undefined
    const sync = () => {
      const entry = ctx.slots.entriesOfSlot(slot)[0]
      if (entry === active) return
      remove?.()
      remove = undefined
      active = entry
      if (entry?.locale !== 'permission.access' || !entry.inject) return
      remove = ctx.slots.register(
        {
          name: 'roleTeam.leadPermission',
          locale: entry.locale,
          inject: entry.inject as unknown as (id: SessionId) => PermissionSelectInjected,
        },
        entry.component as SlotComponent<PermissionSelectProps>,
      )
    }
    sync()
    const unsubscribe = ctx.slots.subscribe(slot, sync)
    return () => {
      unsubscribe()
      remove?.()
    }
  })
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'role-team-member-settings',
      },
      ChildControls,
    ),
  )
  ctx.inject(['remote.settings'], (scope) => {
    const settings = scope.get(
      'remote.settings',
    ) as import('@deepseek-ai/dsh-typert-protocol').TypertRemoteNamespaceMap['settings']
    const settingsFace: Ui['settings'] = {
      async read() {
        const view = unwrap(await settings.describe())
        const row = view.namespaces.find((n) => n.ns === 'role-team')
        return { writable: view.writable && !!row, revision: row?.revision ?? 0 }
      },
      async write(path, revision) {
        unwrap(await settings.update('role-team', { roleStoreDir: path }, revision))
      },
    }
    function Settings({ t }: PropsLocale<'roleTeam'>) {
      return (
        <Client.Provider value={{ ...shared, settings: settingsFace, t }}>
          <LibrarySettings />
        </Client.Provider>
      )
    }
    scope.slots.inject('settings.section', () =>
      scope.slots.register(
        { name: 'settings.section', id: 'role-team', locale: 'roleTeam', label: () => t('title') },
        Settings,
      ),
    )
  })
}
