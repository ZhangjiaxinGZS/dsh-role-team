import { createHash } from 'node:crypto'
export { DocumentError, parseMarkdown, serializeMarkdown } from '../../shared/markdown.js'

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
