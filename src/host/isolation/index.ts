import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

const collaboration = [
  'list_agents',
  'send_message',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_update',
  'team_task_get',
]
export const trainingTools = [
  'propose_role_update',
  'propose_role_memory',
  'record_temporary_note',
] as const

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
const files = ['read', 'read_image', 'write', 'edit']
export function isolate(
  agent: Agent,
  training: boolean,
  active: () => boolean,
  locale: 'zh' | 'en' = 'zh',
  workspace?: string,
) {
  const allowed = new Set<string>(training ? trainingTools : [...collaboration, ...files])
  const tools = agent.ctx.tools
  const native = new NativeToolExecutor(agent.ctx)
  tools.setExecutor({
    describe: (definitions) => native.describe(definitions.filter((tool) => allowed.has(tool.name))),
    execute: (input) => native.execute(input),
  })
  // Preset-local tools bypass registry restrictions. Filter the actual model schemas and dispatch.
  tools.guard((exec) => {
    if (exec.agent !== agent) return
    if (!active() || !allowed.has(exec.name))
      return locale === 'en'
        ? 'Capability unavailable in this role session'
        : '当前角色会话无法使用此工具。'
  })
  if (workspace)
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== agent || !files.includes(exec.name)) return next()
      const file = (exec.arguments as { file_path?: unknown }).file_path
      const deny = {
        kind: 'deny' as const,
        reason:
          locale === 'en'
            ? 'File must be inside the shared workspace.'
            : '仅允许访问团队工作目录内的文件。',
      }
      if (typeof file !== 'string') return deny
      const dirs = agent.ctx.get('workingDirectory'),
        fs = agent.ctx.get('fs')
      if (!dirs || !fs) return deny
      const cwd = await dirs.ensure(agent, exec.signal)
      const target = await fs.resolve(file, { cwd, signal: exec.signal })
      const physical = fs.processPath(target)
      if (!physical || !isAbsolute(physical)) return deny
      const home = resolve(process.env.DSH_HOME?.trim() || resolve(homedir(), '.dsh'))
      const privateHome = await realpath(home).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return home
        throw e
      })
      if (!inside(workspace, physical) || inside(privateHome, physical)) return deny
      try {
        const info = await stat(physical)
        if (!info.isFile() || info.nlink > 1) return deny
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || exec.name !== 'write') return deny
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
      return {
        ...result,
        messages: result.messages.filter(({ source }) =>
          ['user', 'agent-message', 'subagent-settled', 'runtime-context'].includes(source.kind),
        ),
      }
    },
    { prepend: true },
  )
}
