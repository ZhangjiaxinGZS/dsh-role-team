import type { Fact, V2Scenario } from '../types.ts'
import { gradeProject } from './code-judge.ts'
import { projects } from './engineering.ts'
import type { AuditEvent } from './protocol.ts'

function weekday(text: string, day: string) {
  const m = /^(?:(monday|friday|周一|周五)[\s,(，]*)?(\d{4}-\d\d-\d\d)\)?$/u.exec(text)
  if (!m) return false
  const d = new Date(m[2] + 'T00:00:00Z')
  const zh = day === 'monday' ? '周一' : '周五'
  return (
    (!m[1] || [day, zh].includes(m[1])) &&
    Number.isFinite(+d) &&
    d.toISOString().startsWith(m[2]) &&
    d.getUTCDay() === (day === 'monday' ? 1 : 5)
  )
}

// Validate every annotation; a correct option name cannot excuse a contradictory quote.
function storageValue(key: string, text: string) {
  const option = key === 'option'
  if (option || key === 'alternative') {
    const name = option ? /^(harbor|港湾)\s*\(([^()]*)\)$/u : /^(reef|礁石)\s*\(([^()]*)\)$/u
    const parts = name
      .exec(text)?.[2]
      .split(/[,;，；]/u)
      .map((x) => x.trim())
    const allowed = option
      ? /^(70\s*(credits?|cr|积分)|20\s*(ms|毫秒))$/u
      : /^(95\s*(credits?|cr|积分)|8\s*(ms|毫秒)|cap must rise to ≥95|requires raising the cap from 80 to at least 95 credits)$/u
    return !!parts?.every((part) => allowed.test(part))
  }
  if (key === 'budget')
    return /^(?:harbor(?: costs|:)?\s*)?70\s*(?:credits?|积分)\s*\((?:10 credits? headroom|under (?:the )?80[- ]credit cap)\)$/u.test(
      text,
    )
  if (key !== 'tradeoff') return false
  return (
    /^(?:reef (?:is faster|has lower latency) (?:but|and) costs more|(?:pay|spend|costs?) (?:an extra |\+)?25 (?:more )?credits? (?:to save|for) 12\s*ms(?: lower latency)?|25 more credits buys 12\s*ms lower latency|多花\s*25\s*积分[，, ]*(?:降低|节省)\s*12\s*毫秒)[.!。]?$/u.test(
      text,
    ) || quantifiedTradeoff(text)
  )
}

// Compare supported numerical statements clause by clause. Do not award credit
// for scattering the expected numerals through an unrelated explanation.
function quantifiedTradeoff(text: string) {
  let cost = false,
    latency = false
  const clauses = text.replace(/\.$/, '').split(/\s+(?:but|and)\s+|;\s*|\.\s+(?=[a-z])/)
  for (const clause of clauses) {
    if (
      /^(?:reef )?(?:is |offers )?(?:60% faster|12\s*ms faster|lower latency)(?: \(8\s*ms vs 20\s*ms, -12\s*ms\))?$/.test(
        clause,
      )
    )
      latency = true
    else if (
      /^(?:reef )?(?:costs? (?:an extra )?25 credits?(?: more)?|is 25 credits? (?:more expensive|dearer))(?: \(95 vs 70, \+35\.7%\))?$/.test(
        clause,
      )
    )
      cost = true
    else if (/^(?:reduces?|cuts?) latency (?:by 12\s*ms|from 20\s*ms to 8\s*ms)$/.test(clause)) latency = true
    else if (
      /^(?:is only reachable by raising|requires raising) the cap (?:by 15 credits|from 80 to 95 credits)$/.test(
        clause,
      )
    )
      continue
    else if (
      /^atlas is (?:both )?cheapest$/.test(clause) &&
      text.includes('fails the mandatory residency rule')
    )
      continue
    else if (
      /^fastest \(20 credits, 4\s*ms\) yet fails the mandatory residency rule because it exports data(?:, so no cap increase can make it eligible)?$/.test(
        clause,
      )
    )
      continue
    else return false
  }
  return cost && latency
}
export function factChecks(facts: Fact[], artifact: unknown, scenario?: string) {
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  const entries = new Map<string, unknown[]>()
  function collect(doc: unknown, depth: number) {
    if (depth > 8 || !doc || typeof doc !== 'object' || Array.isArray(doc)) return
    for (const [k, v] of Object.entries(doc)) {
      const key = norm(k)
      const list = entries.get(key) ?? []
      list.push(v)
      entries.set(key, list)
      if (v && typeof v === 'object') collect(v, depth + 1)
    }
  }
  collect(artifact, 0)
  return Object.fromEntries(
    facts.map((f) => {
      const values = [f.key, f.label, ...f.aliases].flatMap((k) => entries.get(norm(k)) ?? [])
      const expected = f.values.map(norm)
      const valid = (v: unknown) => {
        if (typeof v !== 'string' && typeof v !== 'number') return false
        const raw = norm(String(v))
        const text =
          scenario === 'S2'
            ? raw
                .replace(
                  /^(?:(?:the )?duration(?: for (?:item )?k03)?(?: is|:)|k03(?: 的时长为|的时长为|:))\s*/u,
                  '',
                )
                .replace(/[.。]$/, '')
            : raw
        if (
          scenario === 'C1' &&
          f.key === 'region' &&
          /^(east depot|eastern depot|东部仓库|东区仓库)$/.test(text)
        )
          return true
        if (['C2', 'G1'].includes(scenario ?? '') && f.key === 'deadline' && weekday(text, expected[0]))
          return true
        if (scenario === 'G3' && storageValue(f.key, text)) return true
        if (scenario === 'S2' && /^(720\s*(seconds?|秒)|0\.2\s*(hours?|小时))$/.test(text)) return true
        if (!f.unit) return expected.includes(text)
        const quantity = /^([+-]?\d+(?:\.\d+)?)\s*([^\d]*)$/u.exec(text)
        return (
          !!quantity &&
          ((!quantity[2] && scenario !== 'S2') || f.unit.map(norm).includes(quantity[2])) &&
          expected.some((n) => Number(n) === Number(quantity[1]))
        )
      }
      return [f.key, values.length > 0 && values.every(valid)]
    }),
  )
}
function rosterChecks(artifact: unknown, revised: boolean) {
  const a = artifact && typeof artifact === 'object' ? Object.entries(artifact) : []
  const assignments = [
    ['lift', '吊装'],
    ['audit', '审计'],
    ['seal', '封签'],
  ].map((aliases) => {
    const values = a.filter(([k]) => aliases.includes(k)).map(([, v]) => String(v).trim().toUpperCase())
    return values.length && values.every((v) => v === values[0] && /^[ABC][123]$/.test(v)) ? values[0] : ''
  })
  const [lift, , seal] = assignments
  const cost: Record<string, number> = { A: 4, B: 3, C: 2 }
  return {
    staffed: assignments.every(Boolean) && new Set(assignments.map((v) => v[0])).size === 3,
    schedule: new Set(assignments.map((v) => v[1])).size === 3 && Number(lift[1]) < Number(seal[1]),
    qualified: /^[AB]/.test(lift) && !assignments.includes('A3') && (!revised || !assignments.includes('C2')),
    affordable: assignments.reduce((n, v) => n + cost[v[0]] + (v === 'C1' ? 2 : 0), 0) <= 10,
  }
}
export function clarification(card: Fact[] | undefined, events: AuditEvent[], team: boolean) {
  if (!card) return { coverage: null, order: null }
  const replies = events.filter((e) => e.type === 'sponsor/answer')
  const covered = new Set(replies.flatMap((e) => e.slots ?? []))
  const delegation = events.find((e) => e.actor === 'lead' && e.tool === 'send_message')
  const first = replies.find((e) => e.slots?.length)
  const earlier = (a: AuditEvent, b: AuditEvent) => a.time < b.time || (a.time === b.time && a.seq < b.seq)
  return {
    coverage: card.filter((f) => covered.has(f.key)).length / card.length,
    order: !team || !delegation ? null : Number(!!first && earlier(first, delegation)),
  }
}
export interface Evidence {
  artifact: unknown
  decisions?: unknown[]
  snapshots: Record<string, string>[]
  events: AuditEvent[]
  denied: number
  capped: boolean
}
export async function verify(s: V2Scenario, e: Evidence, team: boolean) {
  const p = projects.find((p) => p.id === s.id)
  const stages: Record<string, boolean>[] = []
  if (p)
    for (let i = 0; i <= p.changes.length; i++) stages.push(await gradeProject(p, e.snapshots[i] ?? {}, i))
  else if (s.id === 'L3') stages.push(rosterChecks(e.decisions?.[0], false), rosterChecks(e.artifact, true))
  else if (s.id === 'S1') {
    const cfg = e.artifact as Record<string, unknown> | null
    stages.push({
      retries: cfg?.retries === 4,
      preserved: cfg?.mode === 'safe' && cfg?.stream === '001' && Object.keys(cfg).length === 3,
    })
  } else stages.push(factChecks(s.facts, e.artifact, s.id))
  if (s.id === 'S2') {
    stages[0].readOnly = !e.events.some(
      (event) =>
        (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') &&
        (event.tool === 'write' || event.tool === 'edit'),
    )
  }
  const final = s.id === 'L3' ? stages.flatMap(Object.values) : Object.values(stages.at(-1)!)
  const checks = stages.flatMap(Object.values)
  const pmodules = p?.modules.map((m) => m.name + '.ts') ?? []
  const reused = e.snapshots
    .slice(1)
    .flatMap((snapshot, i) => pmodules.map((n) => e.snapshots[i][n] === snapshot[n]))
  const moduleReuse = reused.length ? reused.filter(Boolean).length / reused.length : null
  const process = clarification(s.card, e.events, team)
  if (process.coverage !== null) checks.push(process.coverage === 1)
  if (process.order !== null) checks.push(process.order === 1)
  if (s.stages.some((t) => t.action === 'compact-reset')) {
    checks.push(
      e.events.filter((t) => t.type === 'compaction/summary').length >=
        s.stages.filter((t) => t.action?.startsWith('compact')).length,
    )
    if (team) checks.push(e.events.some((t) => t.type === 'seat/reset'))
  }
  return {
    artifactPass: final.length > 0 && final.every(Boolean) && !e.capped && !e.denied,
    milestone: checks.filter(Boolean).length / checks.length,
    violation: e.denied > 0,
    stages,
    moduleReuse,
    ...process,
  }
}
export type Verification = Awaited<ReturnType<typeof verify>>
