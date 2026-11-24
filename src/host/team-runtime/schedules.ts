import type {} from '@deepseek-ai/dsh-schedule'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryRequest,
  ScheduleId,
} from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Input } from '../../shared/runtime.js'
import {
  scheduleChange,
  scheduleDraft,
  type ScheduleRow,
  type Timing,
} from '../../shared/schedules.js'
import type { TeamRuntime } from './index.js'

function rule(task: ScheduleCatalogEntry): Timing {
  switch (task.kind) {
    case 'after':
      return { kind: 'after', after_seconds: task.afterSeconds }
    case 'at':
      return { kind: 'at', at: task.scheduledAt }
    case 'every':
      return { kind: 'every', every_seconds: task.everySeconds }
    case 'daily':
      return { kind: 'daily', daily: { time: task.time, time_zone: task.timeZone } }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: { time: task.time, time_zone: task.timeZone, weekdays: task.weekdays },
      }
    case 'cron':
      return { kind: 'cron', cron: { expression: task.expression, time_zone: task.timeZone } }
    case 'rrule':
      return { kind: 'rrule', rrule: task.rrule }
  }
}
function nativeTiming(rule: Timing): Timing {
  const seconds = (time: string) => (/^\d{2}:\d{2}$/.test(time) ? time + ':00' : time)
  if (rule.kind === 'daily')
    return { kind: 'daily', daily: { ...rule.daily, time: seconds(rule.daily.time) } }
  if (rule.kind === 'weekly')
    return { kind: 'weekly', weekly: { ...rule.weekly, time: seconds(rule.weekly.time) } }
  return rule
}
function row(task: ScheduleCatalogEntry): ScheduleRow {
  const { id, title, prompt, scheduledAt, status } = task
  return {
    id,
    title,
    prompt,
    scheduledAt,
    status,
    updatedAt: task.updatedAt ?? null,
    timing: rule(task),
  }
}

export class TeamSchedules {
  constructor(private team: TeamRuntime) {}
  private get native() {
    const service = this.team.native.ctx.get('schedule')
    if (!service) throw new Error('Schedule service is unavailable')
    return service
  }
  private belongs(task: ScheduleCatalogEntry, runId: string, root: string) {
    return (
      task.target.kind === 'session' &&
      task.target.sessionId === root &&
      task.involvedSessionIds.every((id) => id === root) &&
      (this.team.index.schedules.get(task.id)?.runId ?? runId) === runId
    )
  }
  async list(runId: string) {
    const { rootSessionId } = this.team.getTeam(runId).run
    const previousLinks = this.team.index.schedules.list().filter((link) => link.runId === runId)
    const catalog = await this.native.catalog()
    const owned = catalog.filter((task) => this.belongs(task, runId, rootSessionId))
    const index = this.team.index.schedules
    // Native UI creation and a process exit between the two writes converge on the same identity.
    for (const task of owned)
      if (!index.get(task.id)) await index.put({ runId, scheduleId: task.id })
    const existing = new Set(catalog.map((task) => String(task.id)))
    for (const link of previousLinks) {
      if (!existing.has(link.scheduleId)) await index.delete(link.scheduleId)
    }
    return owned.map(row)
  }
  private async owned(runId: string, id: string) {
    const root = this.team.getTeam(runId).run.rootSessionId
    const task = await this.native.view({ id: id as ScheduleId })
    if (!('kind' in task) || !this.belongs(task, runId, root))
      throw new Error('Task not found in this team')
    return task
  }
  async create({ runId, title, prompt, timing }: Input<'createTeamSchedule'>) {
    return this.team.ordered(runId, async () => {
      const root = this.team.active(runId).rootSessionId as SessionId
      const task = await this.native.create(
        {
          title,
          prompt,
          timing: nativeTiming(timing),
          target: { kind: 'session', sessionId: root },
        },
        root,
      )
      await this.team.index.schedules.put({ runId, scheduleId: task.id }).catch((error) => {
        this.team.native.ctx.logger.warn(
          'Schedule created; ownership index will reconcile on next read: %s',
          String(error),
        )
      })
      return row(task)
    })
  }
  async change({
    runId,
    id,
    action,
    expectedUpdatedAt,
    title,
    prompt,
    timing,
  }: Input<'changeTeamSchedule'>) {
    return this.team.ordered(runId, async () => {
      const root = this.team.active(runId).rootSessionId as SessionId
      const task = await this.owned(runId, id)
      if (expectedUpdatedAt !== (task.updatedAt ?? null)) throw new Error('schedule_conflict')
      const fields = {
        ...(title !== undefined && { title }),
        ...(prompt !== undefined && { prompt }),
        ...(timing && { timing: nativeTiming(timing) }),
      }
      if ((action === 'update') !== !!Object.keys(fields).length)
        throw new Error('Invalid schedule edit')
      const key = { id: task.id, expectedUpdatedAt }
      const result =
        action === 'run'
          ? await this.runNow(runId, task)
          : await this.native.edit(
              action === 'delete'
                ? { ...key, action }
                : {
                    ...key,
                    action: 'update',
                    patch: action === 'update' ? fields : { active: action === 'resume' },
                  },
              root,
            )
      if ('code' in result) throw new Error(result.code)
      if (action === 'delete') await this.team.index.schedules.delete(id)
      return true
    })
  }
  private async runNow(runId: string, task: ScheduleCatalogEntry) {
    // Native run has no revision parameter. Abort its queued admission if the catalog changes
    // between revalidating the target and acquiring the native scheduler's transaction.
    const cancel = new AbortController()
    const dispose = this.team.native.ctx.on('schedule/changed', () =>
      cancel.abort(new Error('schedule_conflict')),
    )
    try {
      const latest = await this.owned(runId, task.id)
      if (latest.updatedAt !== task.updatedAt) throw new Error('schedule_conflict')
      return await this.native.run({ id: task.id }, cancel.signal)
    } finally {
      dispose()
    }
  }
  async history({ runId, id, before }: Input<'teamScheduleHistory'>) {
    const task = await this.owned(runId, id)
    const page = await this.native.history({
      id: task.id,
      limit: 30,
      before: before as ScheduleDeliveryHistoryRequest['before'],
    })
    if ('code' in page) throw new Error(page.code)
    const root = this.team.getTeam(runId).run.rootSessionId
    return {
      records: page.records
        .filter((r) => r.targetSessionId === root)
        .map(({ messageId, deliveredAt, prompt }) => ({
          messageId,
          deliveredAt,
          ...(prompt !== undefined && { prompt }),
        })),
      nextBefore: page.nextBefore ?? null,
    }
  }
  install(agent: Agent, runId: string, scope: Context) {
    const output = {
      schema: { type: 'string' as const },
      render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    }
    const add = <T extends z.ZodType>(
      name: string,
      description: string,
      schema: T,
      execute: (args: z.infer<T>) => Promise<unknown>,
    ) =>
      scope.tools.register({
        name,
        description,
        parameters: { ...z.toJSONSchema(schema) },
        output,
        execute: async (args, exec) => {
          if (exec.agent !== agent || this.team.active(runId).rootSessionId !== agent.id)
            throw new Error('Only the team leader manages schedules')
          exec.signal.throwIfAborted()
          return JSON.stringify(await execute(schema.parse(args)))
        },
      })
    add(
      'team_schedule_list',
      'List this team’s tasks and edit revisions.',
      z.strictObject({}),
      () => this.list(runId),
    )
    add(
      'team_schedule_create',
      'After explicit user confirmation of time, frequency and instructions, schedule delivery to this team leader.',
      scheduleDraft,
      (args) => this.create({ ...args, runId }),
    )
    add(
      'team_schedule_change',
      'Manage one task from team_schedule_list using its latest updatedAt as expectedUpdatedAt.',
      scheduleChange,
      (args) => this.change({ ...args, runId }),
    )
  }
}
