import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { parse } from 'yaml'
import { z } from 'zod'
import { hash, teamBrief, type BriefSaveResult, type TeamBrief } from '../../shared/index.js'
import { directory, readFileText, stageText } from '../role-store/files.js'
import { digest } from '../role-store/markdown.js'
import { generationKey } from '../storage/index.js'
import type { TeamRuntime } from './index.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-brief': {
      kind: 'team-brief'
      form: 'notice'
      summary: string
      briefHash: string
      updatedAt: string
      updatedBy: 'user' | 'leader'
    }
  }
}

export function briefNotice(brief: TeamBrief, english: boolean) {
  return createUserMessage({
    source: {
      kind: 'team-brief', form: 'notice', briefHash: brief.hash,
      summary: boundContextSummary(english ? 'Team brief updated' : '团队简报已更新'),
      updatedAt: brief.updatedAt, updatedBy: brief.updatedBy,
    },
    content: [{ type: 'text', text: [
      `<team-brief-update updated_at="${brief.updatedAt}" updated_by="${brief.updatedBy}">`,
      english ? 'Note: The user’s latest direct instruction always overrides this brief.' : '说明：用户最新直接指令的优先级始终高于本简报。',
      brief.text, '</team-brief-update>',
    ].join('\n') }],
  })
}

export class TeamBriefs {
  constructor(private readonly team: TeamRuntime) {}

  private async dir(runId: string, create = false) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('Invalid team identifier')
    const root = join(dirname(this.team.roles.root), 'teams')
    const path = join(root, runId)
    return await directory(root, create) && await directory(path, create) ? path : null
  }

  async read(runId: string): Promise<TeamBrief | null> {
    const dir = await this.dir(runId)
    const file = dir && await readFileText(join(dir, 'brief.md'))
    if (!file) return null
    const header = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(file.text)
    if (!header || header.index !== 0) throw new Error('Invalid team brief frontmatter')
    return teamBrief.parse({ ...parse(header[1]), hash: file.hash, text: file.text.slice(header[0].length) })
  }

  private async locked<T>(dir: string, work: () => Promise<T>) {
    // The lock lives beside the directory, so deleting an archived team cannot unlink a held lock.
    const release = await lockfile.lock(dir, { retries: { retries: 40, minTimeout: 10, maxTimeout: 200 } })
    try { return await work() } finally { await release() }
  }

  async remove(runId: string) {
    const dir = await this.dir(runId)
    if (dir) await this.locked(dir, () => rm(dir, { recursive: true, force: true }))
  }

  save(runId: string, text: string, expectedHash: string | null | undefined, updatedBy: TeamBrief['updatedBy']): Promise<BriefSaveResult> {
    return this.team.ordered('brief/' + runId, async () => {
      const run = this.team.active(runId)
      const dir = await this.dir(runId, true)
      if (!dir) throw new Error('Team brief directory is unavailable')
      return this.locked(dir, async (): Promise<BriefSaveResult> => {
        const result = await this.publish(dir, runId, text, expectedHash, updatedBy)
        if (result.ok && result.brief && updatedBy === 'leader') {
          const seat = this.team.seat(run.leaderSeatId)
          const seenBriefHash = result.brief.hash
          await this.team.ordered('seen/' + run.rootSessionId, () => this.team.index.generations.update(
            generationKey(seat.seatId, seat.currentGeneration), g => ({ ...g, seenBriefHash }),
          ))
        }
        return result
      })
    })
  }

  private async publish(dir: string, runId: string, text: string, expectedHash: string | null | undefined,
    updatedBy: TeamBrief['updatedBy']): Promise<BriefSaveResult> {
    const current = await this.read(runId)
    if (expectedHash !== undefined && expectedHash !== (current?.hash ?? null))
      return { ok: false, code: 'conflict', current }
    if (updatedBy === 'leader') {
      text = text.trim()
      if (!text) throw new Error('Team brief cannot be blank')
      if (text.length > 1500) throw new Error(`Team brief exceeds 1500 characters (got ${text.length}). Summarize decisions and use file paths instead of pasting long reports.`)
    }
    if (text.length > 4000) throw new Error('Team brief exceeds 4000 characters')
    if (!text.trim()) {
      if (current) await rm(join(dir, 'brief.md'))
      return { ok: true, brief: null }
    }
    const updatedAt = new Date().toISOString()
    const body = `---\nupdatedAt: "${updatedAt}"\nupdatedBy: "${updatedBy}"\n---\n${text}`
    const stage = await stageText(join(dir, 'brief.md'), body)
    try { await stage.commit(false) } finally { await stage.discard() }
    const brief = { text, hash: digest(body), updatedAt, updatedBy }
    return { ok: true, brief }
  }

  install(agent: Agent, runId: string, isLeader: boolean, scope: Context) {
    const output = { schema: { type: 'string' as const }, render: (_: unknown, value: string) => [{ type: 'text' as const, text: value }] }
    scope.tools.register({
      name: 'read_team_brief', description: 'Read the current shared team brief and revision hash.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      execute: async (_, exec) => {
        this.team.active(runId)
        if (exec.agent !== agent) throw new Error('Team brief is session scoped')
        const brief = await this.read(runId)
        return JSON.stringify(brief ? { exists: true, ...brief } : { exists: false, text: '', hash: null, updatedAt: null, updatedBy: null })
      },
    })
    if (!isLeader) return
    scope.tools.register({
      name: 'update_team_brief', description: 'Update this team’s shared brief.',
      parameters: { type: 'object', properties: {
        text: { type: 'string', description: 'Concise Markdown team brief (max 1500 chars). Keep current goal, locked decisions/guardrails, and artifact file paths; never paste long reports.' },
        expectedHash: { type: 'string', description: 'Optional SHA-256 hash from the last read_team_brief call for conflict detection. Omit to update the latest revision.' },
      }, required: ['text'], additionalProperties: false }, output,
      execute: async (args, exec) => {
        if (exec.agent !== agent || this.team.active(runId).rootSessionId !== agent.id)
          throw new Error('Only the team leader can update the team brief')
        const input = z.strictObject({ text: z.string(), expectedHash: hash.optional() }).parse(args)
        return JSON.stringify(await this.save(runId, input.text, input.expectedHash, 'leader'))
      },
    })
  }
}
