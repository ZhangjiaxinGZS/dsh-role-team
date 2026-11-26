import type { Fact, V2Scenario } from '../types.ts'
import { gradeProject } from './code-judge.ts'
import { projects } from './engineering.ts'
import type { AuditEvent } from './protocol.ts'

export function factChecks(facts: Fact[], artifact: unknown) {
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
        const text = norm(String(v))
        if (!f.unit) return expected.includes(text)
        const quantity = /^([+-]?\d+(?:\.\d+)?)\s*([^\d]*)$/u.exec(text)
        return (
          !!quantity &&
          (!quantity[2] || f.unit.map(norm).includes(quantity[2])) &&
          expected.some((n) => Number(n) === Number(quantity[1]))
        )
      }
      return [f.key, values.length > 0 && values.every(valid)]
    }),
  )
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
  else stages.push(factChecks(s.facts, e.artifact))
  const final = Object.values(stages.at(-1)!)
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
    checks.push(e.events.some((t) => t.type === 'compaction/summary'))
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
