import { z } from 'zod'
import { hash } from './index.js'

export const briefSource = z.enum(['user', 'leader'])
export const teamBrief = z.strictObject({
  text: z.string(),
  get hash() { return hash },
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: briefSource,
})
export const briefSaveResult = z.union([
  z.strictObject({ ok: z.literal(true), brief: teamBrief.nullable() }),
  z.strictObject({ ok: z.literal(false), code: z.literal('conflict'), current: teamBrief.nullable() }),
])
export type TeamBrief = z.infer<typeof teamBrief>
export type BriefSaveResult = z.infer<typeof briefSaveResult>
