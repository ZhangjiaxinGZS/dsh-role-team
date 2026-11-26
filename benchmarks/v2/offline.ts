import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Port } from './driver.ts'
import type { SponsorModel } from './protocol.ts'
import { projects, projectSources } from './engineering.ts'

// Fixture executor is deliberately separate from the host driver. Its outputs
// calibrate plumbing only; it cannot be selected for a measured model run.
export const fixtureSponsor: SponsorModel = {
  provider: 'fixture-sponsor',
  async classify({ question, slots }) {
    const selected = slots.filter((s) => question.split('|').slice(1).includes(s.key)).map((s) => s.key)
    return { state: selected.length ? 'NEED_ANSWER' : 'TASK_DONE', slots: selected }
  },
}
export function offlinePort(): Port {
  let state: Parameters<Port['start']>[0],
    asked = false,
    index = -1,
    revision = '',
    previous = ''
  return {
    async start(options) {
      state = options
      options.emit({ actor: 'lead', type: 'request/header', route: 'fixture:offline', text: options.header })
    },
    async ask(text) {
      const {
        job: { scenario: s, arm },
        emit,
        workspace,
        signal,
      } = state
      signal.throwIfAborted()
      emit({ actor: 'lead', type: 'step/start' })
      if (s.card && !asked) {
        asked = true
        const q =
          'Please clarify |' +
          s.card
            .map((f) => f.key)
            .reverse()
            .join('|')
        emit({
          actor: 'lead',
          type: 'assistant/message',
          text: q,
          usage: { inputTokens: 24, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 12 },
        })
        return q
      }
      index++
      const prefix = state.header + (arm === 'v0.2.0-prefix-brief' ? revision : '')
      const cached = previous === prefix ? 24 : 0
      previous = prefix
      if (arm !== 'single-agent')
        for (const r of s.roles.slice(1)) {
          emit({ actor: 'lead', type: 'tool/call', tool: 'send_message', target: r.id, text: r.duty })
          emit({ actor: r.id, type: 'step/start' })
          emit({ actor: r.id, type: 'tool/call', tool: 'read', args: { file_path: Object.keys(s.files)[0] } })
          emit({ actor: r.id, type: 'team/report', text: r.privateContext ?? r.duty })
        }
      emit({ actor: 'lead', type: 'tool/call', tool: 'read', args: { file_path: 'scratchpad.md' } })
      const notes = await readFile(join(workspace, 'scratchpad.md'), 'utf8')
      await writeFile(join(workspace, 'scratchpad.md'), notes + text + '\n')
      const p = projects.find((p) => p.id === s.id)
      if (p) {
        for (const [n, body] of Object.entries(projectSources(p, true, index)))
          await writeFile(join(workspace, n), body)
      } else
        await writeFile(
          join(workspace, 'delivery.json'),
          JSON.stringify(Object.fromEntries(s.facts.map((f) => [f.key, f.values[0]]))),
        )
      const result = p
        ? 'Implemented the requested modules.'
        : s.facts.map((f) => f.label + ' = ' + f.values[0]).join('\n')
      emit({
        actor: 'lead',
        type: 'assistant/message',
        text: result,
        usage: { inputTokens: 32 - cached, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: 12 },
      })
      return result
    },
    async compactReset(team) {
      state.emit({ actor: 'lead', type: 'compaction/summary', text: 'fixture compaction' })
      if (team) state.emit({ actor: state.job.scenario.roles[1].id, type: 'seat/reset' })
    },
    async fresh() {
      previous = ''
      state.emit({ actor: 'lead', type: 'session/new' })
    },
    async reviseBrief(text) {
      revision = text
      state.emit({
        actor: 'lead',
        type: state.job.arm === 'v0.2.0-prefix-brief' ? 'system/brief' : 'suffix/brief',
        text,
      })
    },
    async close() {},
  }
}
