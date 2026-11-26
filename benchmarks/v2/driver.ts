import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { TrialClock, V2Scenario, V2Arm } from '../types.ts'
import { parseLogs, splitWallClock, type Trace } from '../log-parser.ts'
import {
  Budget,
  sponsorTurn,
  writable,
  systemHeader,
  type AuditEvent,
  type SponsorModel,
  type Limits,
} from './protocol.ts'
import { projects, projectSources } from './engineering.ts'
import { verify } from './verifier.ts'
import { artifact, document } from '../types.ts'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

export type Job = { scenario: V2Scenario; repeat: number; arm: V2Arm; nonce: string }
export type Event = Omit<AuditEvent, 'seq' | 'time'> & { args?: unknown; retryMs?: number; metered?: boolean }
export interface Port {
  start(options: {
    job: Job
    workspace: string
    header: string
    signal: AbortSignal
    reserve: (maximum: number) => (used: number) => void
    emit: (event: Event) => void
  }): Promise<void>
  ask(prompt: string): Promise<string>
  compactReset(team: boolean): Promise<void>
  fresh(): Promise<void>
  reviseBrief(text: string): Promise<void>
  close(): Promise<void>
}
export async function runProtocol(
  job: Job,
  workspace: string,
  port: Port,
  sponsor: SponsorModel,
  provider: string,
  limits: Limits,
) {
  const { scenario: s, arm } = job,
    team = arm !== 'single-agent'
  const clockStart = performance.now(),
    budget = new Budget(limits)
  const spans: { kind: keyof Omit<TrialClock, 'agentWallMs'>; start: number; end: number }[] = []
  const events: AuditEvent[] = [],
    raw = new Map<string, string[]>()
  const snapshots: Record<string, string>[] = []
  let denied = 0,
    setup = true,
    finalText = '',
    sequence = 0
  const now = () => performance.now() - clockStart
  const emit = (e: Event) => {
    const time = now(),
      seq = ++sequence
    const { args, retryMs, metered, ...kept } = e
    const resource =
      args &&
      typeof args === 'object' &&
      ['read', 'read_file', 'glob', 'grep', 'list_files', 'search_files'].includes(e.tool ?? '')
        ? createHash('sha256')
            .update(JSON.stringify(args, Object.keys(args).sort()))
            .digest('hex')
            .slice(0, 20)
        : undefined
    events.push({ ...kept, ...(resource && { target: 'read-' + resource }), time, seq })
    if (e.type === 'llm/retry' && retryMs)
      spans.push({ kind: 'retryBackoffMs', start: time, end: time + retryMs })
    if (e.type === 'tool/denied') denied++
    const rows = raw.get(e.actor) ?? []
    rows.push(
      JSON.stringify({
        type: e.type === 'team-brief' ? 'user/message' : e.type,
        time,
        seq,
        data: {
          name: e.tool,
          arguments: args,
          usage: e.usage,
          ...(e.type === 'team/task' && { task: { id: e.target, status: e.text } }),
          source: {
            kind: e.type === 'team-brief' ? 'team-brief' : e.type === 'team/report' ? 'team-message' : 'user',
          },
          content: e.text ?? '',
        },
      }),
    )
    raw.set(e.actor, rows)
    if (e.type === 'team/report') {
      const leadRows = raw.get('lead') ?? []
      leadRows.push(
        JSON.stringify({
          type: 'user/message',
          data: { source: { kind: 'team-message' }, content: e.text ?? '' },
        }),
      )
      raw.set('lead', leadRows)
    }
    budget.charge(
      Number(e.type === 'step/start'),
      e.usage && !metered
        ? (e.usage.totalTokens ??
            e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens + e.usage.outputTokens)
        : 0,
    )
  }
  const collect = async () => {
    const p = projects.find((p) => p.id === s.id)
    if (!p) return
    const files: Record<string, string> = {}
    for (const name of Object.keys(projectSources(p))) files[name] = await artifact(workspace, name)
    snapshots.push(files)
  }
  const ask = async (text: string) => {
    emit({ actor: 'user', type: 'user/input', text })
    finalText = await port.ask(text)
  }
  const signal = budget.controller.signal
  let abort!: () => void
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  const run = async () => {
    for (const [name, value] of Object.entries({ ...s.files, 'scratchpad.md': '' }))
      await writeFile(join(workspace, name), value, { flag: 'wx' })
    await port.start({
      job,
      workspace,
      header: systemHeader(job.nonce),
      emit,
      signal,
      reserve: (maximum) => budget.reserve(maximum),
    })
    spans.push({ kind: 'setupMs', start: 0, end: now() })
    setup = false
    await ask(
      s.prompt +
        '\nWorkspace: ' +
        Object.keys(s.files).join(', ') +
        (s.files['ledger.txt'] ? '\n' + s.files['ledger.txt'] : ''),
    )
    if (s.card) {
      for (;;) {
        const start = now()
        let action
        try {
          action = await sponsorTurn(provider, sponsor, s.card, finalText, signal)
        } finally {
          spans.push({ kind: 'simUserMs', start, end: now() })
        }
        emit({
          actor: 'sponsor',
          type: 'sponsor/' + (action.state === 'TASK_DONE' ? 'done' : 'answer'),
          slots: action.slots,
          text: action.reply,
        })
        if (action.state === 'TASK_DONE') break
        if (action.correction) emit({ actor: 'user', type: 'user/correction', text: action.reply })
        await ask(action.reply)
      }
    }
    await collect()
    for (const stage of s.stages) {
      signal.throwIfAborted()
      if (stage.action === 'controlled-brief' && ['v0.2.0-prefix-brief', 'v0.2.0-full'].includes(arm))
        await port.reviseBrief(stage.instruction)
      if (stage.action === 'compact-reset') await port.compactReset(team)
      if (stage.action === 'fresh-team') await port.fresh()
      emit({ actor: 'user', type: 'pivot', text: stage.instruction })
      await ask(stage.instruction)
      await collect()
    }
  }
  let end = 0
  try {
    await Promise.race([run(), interrupted])
    budget.charge(0, 0)
  } catch (err) {
    if (!signal.aborted) throw err
  } finally {
    end = now()
    budget.close()
    signal.removeEventListener('abort', abort)
    await port.close()
  }
  if (setup) spans.push({ kind: 'setupMs', start: 0, end })
  const clock = splitWallClock(
    0,
    end,
    spans.filter((p) => p.start <= end).map((p) => ({ ...p, end: Math.min(end, p.end) })),
  )
  const traces: Trace[] = [...raw].map(([actor, rows]) => ({
    leader: actor === 'lead',
    text: rows.join('\n'),
  }))
  // Detect violations even when an adapter failed to surface a guard denial.
  const modifiedInputs: string[] = []
  for (const [name, initial] of Object.entries(s.files)) {
    if (!writable(s, 'lead', name) && (await artifact(workspace, name)) !== initial) modifiedInputs.push(name)
  }
  const verification = await verify(
    s,
    {
      artifact: await document(workspace),
      snapshots,
      events,
      denied: denied + modifiedInputs.length,
      capped: signal.aborted,
    },
    team,
  )
  return {
    startedAt: budget.started,
    scenario: s.id,
    split: s.split,
    archetype: s.archetype,
    arm,
    repeat: job.repeat,
    nonce: job.nonce,
    events,
    clock,
    clockSpans: spans.map((p) => ({ ...p, end: Math.min(end, p.end) })),
    modifiedInputs,
    status: signal.aborted ? 'budget_exceeded' : 'finished',
    cap: signal.aborted ? String(signal.reason) : null,
    tokenStop: budget.tokenStop ?? null,
    steps: budget.steps,
    metrics: parseLogs(traces),
    verification,
    finalText,
  }
}
export type Trial = Awaited<ReturnType<typeof runProtocol>>
