import { z } from 'zod'

const text = z.string().trim().min(1)
const clock = z.strictObject({ time: text, time_zone: text })
export const timing = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('after'), after_seconds: z.int().positive() }),
  z.strictObject({ kind: z.literal('at'), at: text }),
  z.strictObject({ kind: z.literal('daily'), daily: clock }),
  z.strictObject({
    kind: z.literal('weekly'),
    weekly: clock.extend({ weekdays: z.array(z.int().min(1).max(7)).min(1).max(7) }),
  }),
  z.strictObject({
    kind: z.literal('cron'),
    cron: z.strictObject({ expression: text, time_zone: text }),
  }),
  z.strictObject({ kind: z.literal('every'), every_seconds: z.int().min(60) }),
  z.strictObject({ kind: z.literal('rrule'), rrule: text }),
])
export const scheduleDraft = z.strictObject({ title: text.max(120), prompt: text, timing })
export const scheduleChange = z.strictObject({
  id: text,
  action: z.enum(['update', 'pause', 'resume', 'run', 'delete']),
  expectedUpdatedAt: z.string().nullable(),
  title: text.max(120).optional(),
  prompt: text.optional(),
  timing: timing.optional(),
})
export const scheduleRow = scheduleDraft.extend({
  id: text,
  status: z.enum(['active', 'paused', 'ended']),
  scheduledAt: text,
  updatedAt: z.string().nullable(),
})
export const scheduleHistory = z.strictObject({
  records: z.array(
    z.strictObject({ messageId: text, deliveredAt: text, prompt: z.string().optional() }),
  ),
  nextBefore: text.nullable(),
})
export type ScheduleRow = z.infer<typeof scheduleRow>
export type Timing = z.infer<typeof timing>
