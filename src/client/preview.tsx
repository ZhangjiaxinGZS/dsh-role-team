// rc.5 mounts the native right sidebar only for the foreground Conversation.
// Keep the workspace in the center while that Conversation supplies its preview surface.
import { useSyncExternalStore, type ComponentType } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionTarget, WorkspacePreview } from './ui.js'

const rolePanel = 'role-team' as MainPanelId

type WorkspaceProps = PropsRenderSlots<'roleTeam.chat'> & PropsLocale<'roleTeam'>

export function registerPreviewWorkspace(ctx: Context, Main: ComponentType<WorkspaceProps>): WorkspacePreview {
  const layout = ctx.get('layout')
  const content = document.createElement('div')
  content.className = 'rt-workspace-host'
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const attached = () => content.isConnected
  type ScrollPosition = { element: Element; top: number; left: number }
  let positions: ScrollPosition[] | undefined
  function rememberScroll() {
    if (positions || !content.isConnected) return
    const snapshot: ScrollPosition[] = []
    const record = (element: Element) => {
      const { scrollTop: top, scrollLeft: left } = element
      if (top || left) snapshot.push({ element, top, left })
    }
    record(content)
    content.querySelectorAll('*').forEach(record)
    positions = snapshot
    // React detaches the old ref and attaches the new one in the same commit.
    // Drop unused offsets if navigation reused the outlet or left the workspace.
    queueMicrotask(() => { if (positions === snapshot) positions = undefined })
  }
  function attach(element: HTMLDivElement | null) {
    if (!element) {
      rememberScroll()
    } else if (element !== content.parentElement) {
      rememberScroll()
      if (
        content.isConnected && element.isConnected && content.ownerDocument === element.ownerDocument &&
        'moveBefore' in element && typeof element.moveBefore === 'function'
      ) {
        element.moveBefore(content, null)
      } else {
        element.append(content)
      }
      for (const { element: scroller, top, left } of positions ?? []) {
        if (scroller.scrollTop !== top || scroller.scrollLeft !== left) {
          scroller.scrollTo({ top, left, behavior: 'instant' })
        }
      }
      positions = undefined
    }
    // A transition between center outlets moves the same portal in this commit.
    // After a genuine departure, unmount the workspace and release its session references.
    queueMicrotask(notify)
  }
  function Center() {
    return <div className="rt-workspace-host" ref={attach} />
  }
  function Workspace(props: WorkspaceProps) {
    return useSyncExternalStore(subscribe, attached) ? createPortal(<Main {...props} />, content) : null
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'role-team-workspace',
        locale: 'roleTeam',
        children: { 'roleTeam.chat': { kind: 'single', scope: 'session' } },
      },
      Workspace,
    ),
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: rolePanel }, Center))

  let removeCenter: (() => void) | undefined
  let current: string | undefined
  let navigation: AbortSignal | undefined
  function release() {
    navigation?.removeEventListener('abort', release)
    navigation = undefined
    current = undefined
    removeCenter?.()
    removeCenter = undefined
    notify()
  }
  ctx.effect(() => release)
  const sidebar = () => ctx.get('sidebarRight') as
    | { isExpanded(): boolean; toggleExpanded(): void }
    | undefined
  type Shortcut = { id: string; keys?: readonly string[]; aria?: string }
  const catalog = (ctx.get('shortcuts') as {
    catalog: { getSnapshot(): readonly Shortcut[]; subscribe(fn: () => void): () => void }
  } | undefined)?.catalog
  let defaultTarget: SessionTarget | undefined

  function activate(target: SessionTarget) {
    const id = typeof target === 'string' ? target : target.childSessionId
    const workspace = ctx.get('uiWorkspace') as { openSession(target: SessionTarget): void } | undefined
    if (!layout || !workspace || !ctx.get('sidebarRight') || current === id) return
    if (!removeCenter && layout.panelInfo.getSnapshot().activePanelId !== rolePanel) return
    // Native click handlers can call openResource synchronously. Commit the native
    // sidebar's session/store before allowing the gesture to reach those handlers.
    rememberScroll()
    flushSync(() => {
      navigation?.removeEventListener('abort', release)
      removeCenter ??= ctx.slots.register({ name: 'main', key: 'conversation', priority: -10 }, Center)
      try {
        workspace.openSession(target)
        current = id
        navigation = layout.beginNavigation()
        navigation.addEventListener('abort', release, { once: true })
      } catch (error) {
        release()
        throw error
      }
    })
    notify()
  }
  return {
    activate,
    setDefault(target) {
      defaultTarget = target
      notify()
      return () => {
        if (defaultTarget === target) {
          defaultTarget = undefined
          notify()
        }
      }
    },
    subscribe(listener) {
      const off = subscribe(listener)
      const offLayout = layout?.panelInfo.subscribe(listener)
      const offKeys = catalog?.subscribe(listener)
      return () => { off(); offLayout?.(); offKeys?.() }
    },
    state() {
      const rail = sidebar()
      if (!rail || (!current && !defaultTarget)) return 'unavailable'
      return current && rail.isExpanded() ? 'open' : 'closed'
    },
    shortcut() {
      // The native shortcut only targets the foreground native session.
      return current ? catalog?.getSnapshot().find(entry => entry.id === 'sidebar.right.toggle') : undefined
    },
    toggle() {
      const rail = sidebar()
      if (!rail) return
      if (!current && defaultTarget) {
        activate(defaultTarget)
        // Returning to a session can itself restore its already expanded sidebar.
        if (!current || rail.isExpanded()) return
      }
      if (current) rail.toggleExpanded()
    },
    leave(id: string) {
      if (layout && current === id) {
        rememberScroll()
        layout.selectPanel(rolePanel)
      }
    },
  }
}
