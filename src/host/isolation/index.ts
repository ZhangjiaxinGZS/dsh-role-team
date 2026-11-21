import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
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

export async function workspacePath(path: string, roles: string) {
  if (!isAbsolute(path)) throw new Error('Select an absolute workspace directory')
  const cwd = await realpath(path)
  const inside = (base: string, target: string) => {
    const tail = relative(base, target)
    return tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
  }
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
export function isolate(agent: Agent, training: boolean, active: () => boolean) {
  const allowed = new Set<string>(training ? trainingTools : collaboration)
  const tools = agent.ctx.tools
  const native = new NativeToolExecutor(agent.ctx)
  tools.setExecutor({
    describe: (definitions) => native.describe(definitions.filter((tool) => allowed.has(tool.name))),
    execute: (input) => native.execute(input),
  })
  // Preset-local tools bypass registry restrictions. Filter the actual model schemas and dispatch.
  tools.guard((exec) => {
    if (exec.agent !== agent) return
    if (!active() || !allowed.has(exec.name)) return 'Capability unavailable in this role session'
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
