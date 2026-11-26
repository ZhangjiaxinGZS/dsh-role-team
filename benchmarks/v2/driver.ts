import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { TrialClock, V2Scenario, V2Arm } from '../types.ts'
import { parseLogs, splitWallClock, type Trace } from '../log-parser.ts'
import {
  Budget,
  sponsorTurn,
  writable,
  systemHeader,
  redact,
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
    toolOutcome: Budget['toolOutcome']
    emit: (event: Event) => void
  }): Promise<void>
  ask(prompt: string): Promise<string>
  compactReset(team: boolean): Promise<void>
  fresh(): Promise<void>
  reviseBrief(text: string): Promise<void>
  fixtureTime?(): number
  resolveActor?(key: string): string
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
  const clockNow = port.fixtureTime ?? (() => performance.now())
  const clockStart = clockNow(),
    budget = new Budget(limits)
  const spans: { kind: keyof Omit<TrialClock, 'agentWallMs'>; start: number; end: number }[] = []
  const events: AuditEvent[] = [],
    raw = new Map<string, string[]>()
  const snapshots: Record<string, string>[] = []
  const decisions: unknown[] = []
  let denied = 0,
    setup = true,
    finalText = '',
    sequence = 0
  const now = () => clockNow() - clockStart
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
    budget.charge(Number(e.type === 'step/start'), e.usage)
  }
  const collect = async () => {
    const p = projects.find((p) => p.id === s.id)
    if (!p) {
      if (s.id === 'L3') decisions.push(await document(workspace))
      return
    }
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
      header:
        s.id === 'S2'
          ? 'Trial ' + job.nonce + '\nRead-only lookup. Reply directly without writing notes.'
          : systemHeader(job.nonce),
      emit,
      toolOutcome: budget.toolOutcome.bind(budget),
      signal,
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
      const disclosed = new Set<string>()
      while (disclosed.size < s.card.length) {
        const start = now()
        let action
        try {
          action = await sponsorTurn(provider, sponsor, s.card, finalText, signal)
        } finally {
          spans.push({ kind: 'simUserMs', start, end: now() })
        }
        action.slots.forEach((key) => disclosed.add(key))
        const complete = disclosed.size === s.card.length
        const confirmation = 'That completes the requested facts.'
        const reply = complete ? action.reply + '\n' + confirmation : action.reply
        emit({
          actor: 'sponsor',
          type: 'sponsor/' + (action.state === 'TASK_DONE' ? 'done' : 'answer'),
          slots: action.slots,
          text: reply,
        })
        if (action.state === 'TASK_DONE') break
        if (action.correction) emit({ actor: 'user', type: 'user/correction', text: action.reply })
        if (complete) emit({ actor: 'sponsor', type: 'sponsor/done', text: confirmation })
        await ask(reply)
      }
    }
    await collect()
    for (const stage of s.stages) {
      signal.throwIfAborted()
      if (stage.action === 'controlled-brief' && ['v0.2.0-prefix-brief', 'v0.2.0-full'].includes(arm))
        await port.reviseBrief(stage.instruction)
      if (stage.action === 'compact-reset' || stage.action === 'compact')
        await port.compactReset(stage.action === 'compact-reset' && team)
      if (stage.action === 'fresh-team') await port.fresh()
      emit({ actor: 'user', type: 'pivot', text: stage.instruction })
      await ask(stage.instruction)
      await collect()
    }
  }
  let end = 0
  try {
    await Promise.race([run(), interrupted])
    budget.charge(0)
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
  const grouped = new Map<string, string[]>()
  for (const [key, rows] of raw) {
    const actor = port.resolveActor?.(key) ?? key
    grouped.set(actor, (grouped.get(actor) ?? []).concat(rows))
  }
  for (const event of events) event.actor = port.resolveActor?.(event.actor) ?? event.actor
  const traces: Trace[] = [...grouped].map(([actor, rows]) => ({
    leader: actor === 'lead',
    text: rows.join('\n'),
  }))
  // Detect violations even when an adapter failed to surface a guard denial.
  const modifiedInputs: string[] = []
  for (const [name, initial] of Object.entries(s.files)) {
    if (!writable(s, 'lead', name) && (await artifact(workspace, name)) !== initial) modifiedInputs.push(name)
  }
  const name = s.id === 'S1' ? 'config.json' : 'delivery.json'
  const submitted = s.id === 'S2' ? { duration: finalText.trim() } : await document(workspace, name)
  const rawSubmission = s.id === 'S2' ? finalText : await artifact(workspace, name)
  const verification = await verify(
    s,
    {
      artifact: submitted,
      snapshots,
      decisions,
      events,
      denied: denied + modifiedInputs.length,
      capped: signal.aborted,
    },
    team,
  )
  return {
    startedAt: port.fixtureTime ? 0 : budget.started,
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
    weightedCostUnits: budget.weightedCostUnits,
    steps: budget.steps,
    metrics: parseLogs(traces),
    verification,
    submission: s.facts.length
      ? {
          name: s.id === 'S2' ? 'reply' : name,
          sha256: createHash('sha256').update(rawSubmission).digest('hex'),
          excerpt: redact(rawSubmission).slice(0, 4096),
        }
      : null,
    finalText,
  }
}
export type Trial = Awaited<ReturnType<typeof runProtocol>>
