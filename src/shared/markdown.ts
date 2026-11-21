import { LineCounter, parseDocument, stringify } from 'yaml'
import type { z } from 'zod'
import type { Diagnostic } from './index.js'

export class DocumentError extends Error {
  constructor(readonly detail: Diagnostic) {
    super(detail.message)
  }
}
export function parseMarkdown<T extends { id: string }>(
  text: string,
  schema: z.ZodType<T>,
  expectedId: string,
  file: string,
) {
  const fail = (line: number, message: string): never => {
    throw new DocumentError({ file, line, message })
  }
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text)
  if (!match || match.index !== 0)
    throw new DocumentError({ file, line: 1, message: 'Expected YAML frontmatter between --- lines' })
  const counter = new LineCounter()
  const yaml = parseDocument(match[1], { lineCounter: counter, prettyErrors: false })
  const problem = yaml.errors[0] ?? yaml.warnings[0]
  if (problem) return fail(counter.linePos(problem.pos[0]).line + 1, problem.message)
  let value: unknown
  try {
    value = yaml.toJS({ maxAliasCount: 32 })
  } catch (error) {
    return fail(2, String(error))
  }
  const parsed = schema.safeParse(value)
  const fieldLine = (field: string) => {
    const node = yaml.get(field, true)
    return typeof node === 'object' && node && 'range' in node && Array.isArray(node.range)
      ? counter.linePos(node.range[0]).line + 1
      : 2
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(fieldLine(String(issue.path[0])), issue.path.join('.') + ' ' + issue.message)
  }
  if (parsed.data.id !== expectedId)
    return fail(fieldLine('id'), 'id must match its filename or role directory')
  return { meta: parsed.data, body: text.slice(match[0].length) }
}
export function serializeMarkdown(meta: Record<string, unknown>, body: string): string {
  return '---\n' + stringify(meta) + '---\n' + body
}
