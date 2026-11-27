import { structuredPatch } from 'diff'
import { z } from 'zod'
import type { Snapshot } from './index.js'

type Role = Snapshot['role']
export const bilingual = z.strictObject({ en: z.string(), zh: z.string() })
const field = z.enum(['name', 'summary', 'body', 'defaultModel', 'defaultPermission', 'otherSettings'])
const hunk = z.strictObject({ start: z.number(), lines: z.array(z.string()) })
const fieldChange = z.strictObject({ field, hunks: z.array(hunk) })
export type FieldChange = z.infer<typeof fieldChange>
const memoryChange = z.strictObject({ field: z.enum(['newExperience', 'revisedExperience']), title: z.string(), body: z.string() })
export const trainingReceipt = z.strictObject({
  kind: z.literal('role-team-change'), revision: z.number().int().positive(),
  summary: bilingual, changes: z.array(z.union([fieldChange, memoryChange])),
})
export type TrainingReceipt = z.infer<typeof trainingReceipt>
const labels = {
  name: ['name', '名称'], summary: ['duty summary', '职责简介'], body: ['instructions', '正文'],
  defaultModel: ['default model', '默认模型'], defaultPermission: ['default permissions', '默认权限'],
  otherSettings: ['other settings', '其他设置'],
} as const

function fields(role?: Role): Record<FieldChange['field'], string> {
  const { name, summary, defaultModel, defaultPermission, id, ...rest } = role?.meta ?? {}
  return {
    name: name ?? '', summary: summary ?? '', body: role?.body ?? '',
    defaultModel: defaultModel ? [defaultModel.provider, defaultModel.model, defaultModel.reasoningEffort].filter(Boolean).join(' / ') : '',
    defaultPermission: defaultPermission ?? '', otherSettings: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '',
  }
}

// Track the enclosing Markdown heading for each line, ignoring examples inside fences.
function sections(text: string) {
  let heading = '', fence = ''
  const lines = text.split('\n')
  return lines.map((line, i) => {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
    } else if (!fence) {
      const match = /^ {0,3}#{1,6}\s+(.+?)\s*$/.exec(line)
      if (match) heading = match[1].replace(/\s+#+$/, '')
      else if (/^ {0,3}\S/.test(line) && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1] ?? '')) heading = line.trim()
    }
    return heading
  })
}

export function roleDiff(before: Role | undefined, after: Role) {
  const previous = fields(before), next = fields(after), changes: FieldChange[] = []
  const oldSections = sections(previous.body), newSections = sections(next.body)
  const touched = new Set<string>()
  let added = 0, removed = 0
  for (const key of field.options) {
    if (previous[key] === next[key]) continue
    const patch = structuredPatch('', '', previous[key], next[key], undefined, undefined, { context: 1 })
    const hunks = patch.hunks.map(h => {
      let oldLine = h.oldStart - 1, newLine = h.newStart - 1
      const lines = h.lines.filter(line => !line.startsWith('\\'))
      for (const line of lines) {
        if (key === 'body' && line[0] === '+') { added++; touched.add(newSections[newLine]) }
        if (key === 'body' && line[0] === '-') { removed++; touched.add(oldSections[oldLine]) }
        if (line[0] !== '+') oldLine++
        if (line[0] !== '-') newLine++
      }
      return { start: h.newStart, lines }
    })
    changes.push({ field: key, hunks })
  }
  const prior = new Set(oldSections), current = new Set(newSections)
  const addedSections = [...touched].filter(s => s && !prior.has(s) && current.has(s))
  const changedSections = [...touched].filter(s => s && prior.has(s) && current.has(s))
  const summarize = (lang: 'en' | 'zh') => {
    if (!before) return lang === 'zh' ? '初始版本' : 'Initial version'
    if (!changes.length) return lang === 'zh' ? '角色设定无变化' : 'No profile changes'
    return changes.map(({ field: key }) => {
      if (key !== 'body') return lang === 'zh' ? '更新' + labels[key][1] : 'Updated ' + labels[key][0]
      const title = addedSections[0] || changedSections[0] || ''
      const section = title.length > 50 ? title.slice(0, 49) + '…' : title
      const heading = section ? (lang === 'zh' ? '「' + section + '」' : ' “' + section + '”') : ''
      const verb = addedSections.length ? ['Added section', '正文新增'] : ['Updated instructions', '更新正文']
      return verb[lang === 'zh' ? 1 : 0] + heading + ' (+' + added + '/-' + removed + (lang === 'zh' ? ' 行)' : ' lines)')
    }).join(lang === 'zh' ? '；' : ' · ')
  }
  return { changes, added, removed, addedSections, changedSections, summary: { en: summarize('en'), zh: summarize('zh') } }
}
