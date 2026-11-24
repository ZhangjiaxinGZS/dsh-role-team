import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-fs'
import { realpath, stat } from 'node:fs/promises'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export const trainingTools = ['update_role', 'remember_experience', 'revise_experience'] as const

function inside(base: string, target: string) {
  const tail = relative(base, target)
  return tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
}

export async function workspacePath(path: string, roles: string) {
  if (!isAbsolute(path)) throw new Error('Select an absolute workspace directory')
  const cwd = await realpath(path)
  if (inside(roles, cwd) || inside(cwd, roles) || !(await stat(cwd)).isDirectory())
    throw new Error('Workspace must be a directory separate from the role library')
  return cwd
}

// Native references expand during pre-step, independently of the tool registry.
export function safeInput(message: UserMessage) {
  const kind: string = message.source.kind
  return (
    kind !== 'session-reference' &&
    !message.content.some((block) => block.type === 'text' && block.text.includes('dsh-session:'))
  )
}
// DSH's session-query and workspace-list plugins expose logs and identities outside the current tree.
const crossSession = new Set([
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'session_reference',
  'list_workspace',
  'list_session',
])
function blockedTool(name: string) {
  return crossSession.has(name.replaceAll('-', '_'))
}

function fileTargets(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
      return typeof args.file_path === 'string' ? [args.file_path] : []
    case 'glob':
    case 'grep':
    case 'str_replace_editor':
      return [typeof args.path === 'string' ? args.path : '.']
    case 'apply_patch':
      if (typeof args.input !== 'string') return []
      return parsePatch(args.input).flatMap((op) =>
        op.kind === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path],
      )
    default:
      return []
  }
}
// Minimal mode owns a complete system prompt. Required context still reaches its model.
export function installRolePrompt(agent: Agent, text: () => string) {
  agent.ctx.systemPrompt.section({ name: 'role-team-role', order: 0, interpolate: false, text })
  agent.ctx.systemPrompt.context({
    name: 'role-team-minimal-profile',
    order: 0,
    interpolate: false,
    required: true,
    text: () => (agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) === 'minimal' ? text() : ''),
  })
}

export function isolate(agent: Agent, roles: string, active: () => boolean, locale: 'zh' | 'en' = 'zh', team?: 'leader' | 'member') {
  const tools = agent.ctx.tools
  // Mask inherited lookup tools for both native and PTC executors, including late registrations.
  const blocked = (name: string) => blockedTool(name) || (!!team && name.startsWith('schedule_')) || (team === 'member' && name.startsWith('team_schedule_'))
  const masked = new Set<string>()
  const restrictLookup = () => {
    const names = tools
      .definitions(scopeParentOf(agent))
      .map((t) => t.name)
      .filter((name) => blocked(name) && !masked.has(name))
    if (!names.length) return
    for (const name of names) masked.add(name)
    tools.restrict({ deny: names })
  }
  restrictLookup()
  agent.ctx.on('tools/change', restrictLookup)
  tools.guard((exec) => {
    if (exec.agent === agent && (!active() || blocked(exec.name)))
      return locale === 'en'
        ? 'Capability unavailable in this role session'
        : '当前角色会话无法使用此工具。'
  })
  // Preserve on-demand MCP catalogs alongside the role's own instructions.
  agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.scope !== agent) return result
    return {
      ...result,
      sections: result.sections.filter(
        (s) =>
          s.name === 'role-team-role' ||
          s.name === 'deployment:persona-prefix' ||
          s.name === 'deployment:persona-suffix' ||
          s.name.startsWith('mcp:') ||
          s.name.startsWith('tools:') ||
          (s.name.startsWith('tool:') && s.name !== 'tool:session-query' && !(team && s.name === 'tool:schedule')),
      ),
    }
  })
  agent.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== agent) return next()
    const targets = fileTargets(exec.name, exec.arguments as Record<string, unknown>)
    if (!targets.length) return next()
    const deny = {
      kind: 'deny' as const,
      reason:
        locale === 'en'
          ? 'This path contains private role or session data.'
          : '此路径包含受保护的角色或会话数据。',
    }
    const dirs = agent.ctx.get('workingDirectory'),
      fs = agent.ctx.get('fs')
    if (!dirs || !fs) return deny
    const cwd = await dirs.ensure(agent, exec.signal)
    const home = resolve(process.env.DSH_HOME?.trim() || resolve(homedir(), '.dsh'))
    const protectedRoots = [
      roles,
      await realpath(home).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return home
        throw e
      }),
    ]
    const sandboxes = roles + '.training-sandboxes'
    for (const file of targets) {
      const physical = fs.processPath(await fs.resolve(file, { cwd, signal: exec.signal }))
      if (!physical || !isAbsolute(physical)) return deny
      if (protectedRoots.some((root) => inside(root, physical) || inside(physical, root))) return deny
      if (
        inside(physical, sandboxes) ||
        (inside(sandboxes, physical) && !(inside(sandboxes, cwd) && inside(cwd, physical)))
      )
        return deny
      const info = await stat(physical).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined
        throw e
      })
      if (info?.isFile() && info.nlink > 1) return deny
    }
    return next()
  })
  // Prepend and inspect both ends. A plugin can have prepared its reference before inbox admission.
  agent.ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      if (payload.agent !== agent) return next()
      if (!active() || payload.messages.some((message) => !safeInput(message))) return { kind: 'reject' }
      const result = await next()
      if (result.kind === 'reject') return result
      if (result.messages.some((message) => !safeInput(message))) return { kind: 'reject' }
      return result
    },
    { prepend: true },
  )
}
