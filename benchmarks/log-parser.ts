type Row = Record<string, unknown>
export interface Trace {
  text: string
  leader: boolean
  hasBrief?: boolean
}
const coordination = new Set([
  'send_message',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'read_team_brief',
  'update_team_brief',
])
const reports = new Set(['agent-message', 'team-message', 'subagent-settled'])
function record(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
}
function signature(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(signature).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + signature(record(value)[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? ''
}

export function parseLogs(traces: readonly Trace[]) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    briefSyncCount: 0,
    compactionCount: 0,
    resyncEligible: 0,
    resynced: 0,
    coordinationSteps: 0,
    taskWorkSteps: 0,
    leaderAnswerChars: 0,
    rawTeammateReportChars: 0,
    compactTeammateReportChars: 0,
    deniedToolCalls: 0,
    staleInProgressTasks: 0,
    repeatedIdenticalToolCalls: 0,
  }
  const reads: { resource: string; actor: number; time: number; seq: number }[] = []
  for (const [actor, trace] of traces.entries()) {
    const tasks = new Map<string, unknown>()
    let last = '',
      repetitions = 0,
      hasBrief = trace.hasBrief ?? false
    let window: { synced: boolean; stepped: boolean } | undefined
    function finishWindow() {
      if (window?.stepped) {
        totals.resyncEligible++
        if (window.synced) totals.resynced++
      }
    }
    for (const [i, line] of trace.text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      let raw: Row
      try {
        raw = record(JSON.parse(line))
      } catch {
        throw new Error('Invalid JSONL at line ' + (i + 1))
      }
      const e = record(raw.event ?? raw),
        d = record(e.data),
        msg = record(d.message ?? d)
      if (typeof e.type !== 'string') throw new Error('Missing event type at line ' + (i + 1))
      const content = textOf(msg.content)
      if (e.type === 'assistant/message' || e.type === 'provider/usage') {
        const u = record(d.usage)
        const count = (k: string) => {
          const value = u[k] ?? 0
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw new Error('Invalid token count at line ' + (i + 1))
          return value
        }
        for (const key of [
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'reasoningTokens',
        ] as const)
          totals[key] += count(key)
        totals.totalTokens +=
          u.totalTokens == null
            ? count('inputTokens') +
              count('cacheReadTokens') +
              count('cacheWriteTokens') +
              count('outputTokens')
            : count('totalTokens')
        if (trace.leader) totals.leaderAnswerChars += Array.from(content).length
      }
      if (e.type === 'user/message') {
        const source = String(record(msg.source).kind)
        if (source === 'team-brief') {
          totals.briefSyncCount++
          hasBrief = true
          if (window) window.synced = true
        }
        if (trace.leader && reports.has(source)) {
          totals.rawTeammateReportChars += Array.from(content).length
          totals.compactTeammateReportChars += Math.min(
            80,
            Array.from(content.replace(/\s+/g, ' ').trim()).length,
          )
        }
      }
      if (e.type === 'compaction/summary') {
        finishWindow()
        totals.compactionCount++
        window = hasBrief ? { synced: false, stepped: false } : undefined
      }
      if (
        window &&
        ['step/start', 'assistant/message', 'tool/call', 'tool/ptc-dispatch-start'].includes(e.type)
      )
        window.stepped = true
      if (e.type === 'tool/call' || e.type === 'tool/ptc-dispatch-start') {
        if (coordination.has(String(d.name))) totals.coordinationSteps++
        else totals.taskWorkSteps++
        let args = d.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            /* Malformed arguments are compared literally. */
          }
        }
        const key = JSON.stringify([d.name, signature(args)])
        const read = ['read', 'read_file'].includes(String(d.name))
        const target = read ? (record(args).file_path ?? record(args).path) : undefined
        const query = ['list_files', 'search_files', 'grep', 'glob'].includes(String(d.name))
        if ((typeof target === 'string' && target.length) || (query && args != null)) {
          const resource = read ? JSON.stringify(['file', target]) : key
          reads.push({
            resource,
            actor,
            time: typeof e.time === 'number' ? e.time : 0,
            seq: typeof e.seq === 'number' ? e.seq : i,
          })
        }
        repetitions = last === key ? repetitions + 1 : 1
        if (repetitions >= 3) totals.repeatedIdenticalToolCalls++
        last = key
      }
      if (
        e.type === 'tool/result' &&
        (msg.isError === true || d.isError === true) &&
        /denied|forbidden|not permitted|permission required|isolation|权限|拒绝|隔离/i.test(
          content + ' ' + JSON.stringify(d.error ?? ''),
        )
      )
        totals.deniedToolCalls++
      if (e.type === 'team/task') {
        const task = record(d.task ?? d)
        if (typeof task.id === 'string') tasks.set(task.id, task.status)
      }
    }
    finishWindow()
    totals.staleInProgressTasks += [...tasks.values()].filter((x) => x === 'in_progress').length
  }
  const firstReader = new Map<string, number>()
  const shared = new Set<string>()
  let redundantReads = 0
  for (const read of reads.sort((a, b) => a.time - b.time || a.seq - b.seq || a.actor - b.actor)) {
    const first = firstReader.get(read.resource)
    if (first === undefined) firstReader.set(read.resource, read.actor)
    else if (first !== read.actor || shared.has(read.resource)) {
      shared.add(read.resource)
      redundantReads++
    }
  }
  const t = totals,
    denominator = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
  const noise = (chars: number) => chars / Math.max(1, chars + t.leaderAnswerChars)
  return {
    ...t,
    readCalls: reads.length,
    redundantReads,
    kvCacheHitRate: denominator ? t.cacheReadTokens / denominator : null,
    postCompactionResyncRate: t.resyncEligible ? t.resynced / t.resyncEligible : null,
    coordinationRatio: t.coordinationSteps / Math.max(1, t.coordinationSteps + t.taskWorkSteps),
    defaultExpandedNoiseRatio: noise(t.rawTeammateReportChars),
    compactCollapsedNoiseRatio: noise(t.compactTeammateReportChars),
  }
}
export type LogMetrics = ReturnType<typeof parseLogs>

// Intersecting retry sleeps from parallel agents count once. Setup and sponsor
// intervals take precedence so the four wall-clock components never overlap.
export function splitWallClock(
  start: number,
  end: number,
  spans: readonly { kind: 'setupMs' | 'simUserMs' | 'retryBackoffMs'; start: number; end: number }[],
) {
  if (
    ![start, end].every(Number.isFinite) ||
    end < start ||
    spans.some(
      (s) =>
        !Number.isFinite(s.start) ||
        !Number.isFinite(s.end) ||
        s.start < start ||
        s.end > end ||
        s.end < s.start,
    )
  )
    throw new Error('Invalid trial clock interval')
  const times = [...new Set([start, end, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b)
  const clock = { agentWallMs: 0, setupMs: 0, simUserMs: 0, retryBackoffMs: 0 }
  for (let i = 1; i < times.length; i++) {
    const active = spans.filter((s) => s.start <= times[i - 1] && s.end >= times[i])
    const kind = (['setupMs', 'simUserMs', 'retryBackoffMs'] as const).find((k) =>
      active.some((s) => s.kind === k),
    )
    clock[kind ?? 'agentWallMs'] += times[i] - times[i - 1]
  }
  return clock
}
