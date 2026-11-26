import { createHash, randomUUID } from 'node:crypto'
import type { Fact, V2Arm, V2Scenario } from '../types.ts'

export const mainArms: V2Arm[] = ['single-agent', 'v0.1.0', 'v0.2.0-full']
export function armsFor(s: V2Scenario) {
  const arms = mainArms.filter((a) => !(a === 'single-agent' && s.multiAgentOnly))
  if (['C3', 'C4'].includes(s.id)) arms.push('v0.2.0-prefix-brief')
  if (['E1', 'E2', 'G1', 'G2'].includes(s.id)) arms.push('v0.2.0-brief-only')
  return arms
}
export function blocks(scenarios: V2Scenario[], repeats: number, seed: string, fixture = false) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw RangeError('Invalid repeats')
  return scenarios
    .flatMap((s) =>
      Array.from({ length: repeats }, (_, i) => {
        const arms = armsFor(s)
        const rank = (arm: string) =>
          createHash('sha256')
            .update(JSON.stringify([seed, s.id, i + 1, arm]))
            .digest('hex')
        return arms
          .sort((a, b) => rank(a).localeCompare(rank(b)))
          .map((arm) => ({
            scenario: s,
            repeat: i + 1,
            arm,
            nonce: fixture
              ? createHash('sha256')
                  .update(JSON.stringify([seed, s.id, i, arm]))
                  .digest('hex')
                  .slice(0, 32)
                  .replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5')
              : randomUUID(),
          }))
      }),
    )
    .flat()
}
export const commonHeader =
  'When requirements are unclear, ask the sponsor and wait for the answer before starting work. Use scratchpad.md as a persistent external notebook across turns. 需求不明先向用户澄清并等待答复，可跨轮使用持久草稿本。'
export function systemHeader(nonce: string) {
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) throw Error('Invalid trial nonce')
  return 'Trial ' + nonce + '\n' + commonHeader
}
export function writable(s: V2Scenario, actor: string, name: string) {
  if (name === 'scratchpad.md') return true
  if (s.id === 'S2') return false
  if (s.id === 'S1') return name === 'config.json' && actor === 'lead'
  if (!s.id.startsWith('E') && s.id !== 'L1') return actor === 'lead' && name === 'delivery.json'
  return Object.hasOwn(s.files, name) && name.endsWith('.ts')
}
export const defaultLimits = { maxWallMs: 900_000, maxSteps: 100, maxWeightedCostUnits: 1_000_000 }
export const tierOf = (id: V2Scenario['id']) => (id.startsWith('S') ? 'S' : id.startsWith('L') ? 'L' : 'M')
export const stepLimits = { S: 40, M: 100, L: 160 }
export const scenarioLimits = (s: V2Scenario) => ({ ...defaultLimits, maxSteps: stepLimits[tierOf(s.id)] })
export type Limits = typeof defaultLimits
export type StopReason = 'maxWallMs' | 'maxSteps' | 'maxWeightedCostUnits' | 'repeatedFailureLoop'
export class Budget {
  readonly controller = new AbortController()
  readonly started = Date.now()
  steps = 0
  // Twentieths exactly represent all four cost weights.
  private ticks = 0
  get weightedCostUnits() {
    return this.ticks / 20
  }
  readonly timer: ReturnType<typeof setTimeout>
  readonly limits: Limits
  constructor(limits: Limits) {
    this.limits = limits
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1) throw RangeError('Invalid resource cap')
    this.timer = setTimeout(() => this.stop('maxWallMs'), limits.maxWallMs)
  }
  private readonly failed = new Map<string, { key: string; turn: number; step: number; count: number }>()
  toolOutcome(session: string, key: string | undefined, turn: number, step: number) {
    if (!key) {
      this.failed.delete(session)
      return
    }
    const prev = this.failed.get(session)
    // Count distinct consecutive steps in one turn; a parallel batch is one attempt.
    const same = prev?.key === key && prev.turn === turn
    const count =
      same && prev.step === step ? prev.count : same && prev.step + 1 === step ? prev.count + 1 : 1
    this.failed.set(session, { key, turn, step, count })
    if (count >= 4) this.stop('repeatedFailureLoop')
  }
  private stop(reason: StopReason) {
    this.controller.abort(reason)
  }
  charge(steps: number, usage?: AuditEvent['usage']) {
    const counts = usage
      ? [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]
      : [0, 0, 0, 0]
    if (![steps, ...counts].every((v) => Number.isSafeInteger(v) && v >= 0))
      throw Error('Invalid resource observation')
    this.steps += steps
    this.ticks += counts[0] * 20 + counts[1] * 2 + counts[2] * 25 + counts[3] * 80
    if (Date.now() - this.started >= this.limits.maxWallMs) this.stop('maxWallMs')
    if (this.steps >= this.limits.maxSteps) this.stop('maxSteps')
    if (this.weightedCostUnits >= this.limits.maxWeightedCostUnits) {
      this.stop('maxWeightedCostUnits')
    }
    this.controller.signal.throwIfAborted()
  }
  close() {
    clearTimeout(this.timer)
  }
}
export type SponsorAction = { state: 'NEED_ANSWER' | 'TASK_DONE'; slots: string[]; correction?: boolean }
export type SponsorModel = {
  provider: string
  classify(input: {
    temperature: 0
    question: string
    slots: { key: string; label: string; aliases: string[] }[]
    signal: AbortSignal
  }): Promise<SponsorAction>
}
export async function sponsorTurn(
  assistantProvider: string,
  model: SponsorModel,
  card: Fact[],
  question: string,
  signal: AbortSignal,
) {
  if (!model.provider || assistantProvider === model.provider)
    throw Error('Independent sponsor provider required')
  // The interpreter never receives hidden answers. Only validated slot IDs can disclose values.
  const decision = await model.classify({
    temperature: 0,
    question,
    slots: card.map(({ key, label, aliases }) => ({ key, label, aliases })),
    signal,
  })
  if (
    (decision.correction !== undefined && typeof decision.correction !== 'boolean') ||
    !['NEED_ANSWER', 'TASK_DONE'].includes(decision.state) ||
    !Array.isArray(decision.slots) ||
    decision.slots.some((k) => !card.some((f) => f.key === k)) ||
    new Set(decision.slots).size !== decision.slots.length ||
    (decision.state === 'TASK_DONE' && decision.slots.length > 0)
  )
    throw Error('Invalid sponsor state')
  const reply = decision.slots
    .map((key) => {
      const f = card.find((s) => s.key === key)!
      return key + ' = ' + f.values[0] + (f.unit ? ' ' + f.unit[0] : '')
    })
    .join('; ')
  return {
    ...decision,
    reply:
      decision.state === 'NEED_ANSWER'
        ? reply || 'Which decision needs clarification? 请说明需要澄清的事项。'
        : '',
  }
}

export interface AuditEvent {
  seq: number
  time: number
  actor: string
  type: string
  text?: string
  tool?: string
  route?: string
  nativeSeq?: number
  nativeTime?: number
  effort?: string
  slots?: string[]
  target?: string
  usage?: {
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    totalTokens?: number
    reasoningTokens?: number
  }
}
export function redact(text: string) {
  return text
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g,
      '[redacted]',
    )
    .replace(/(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(
      /["']?(?:password|token|secret|api[_-]?key|authorization|cookie|credential)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(/(?:https?:\/\/|file:\/\/|(?:[A-Za-z]:[\\/]|\/|~\/))[^\s"'<>，；]*/g, '[path]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|eyJ)[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]{28,}\b/g, '[redacted]')
}
const identifier = (s: string) => (/^[\w.:-]+(?:\/[\w.:-]+)*$/.test(s) && s.length <= 150 ? s : '[redacted]')
export function auditDigest(events: AuditEvent[]) {
  return events.map((e) => ({
    seq: e.seq,
    time: e.time,
    type: identifier(e.type),
    ...(e.nativeSeq !== undefined && { nativeSeq: e.nativeSeq, nativeTime: e.nativeTime }),
    ...(e.effort && { effort: identifier(e.effort) }),
    actor: identifier(e.actor),
    ...(e.tool && { tool: identifier(e.tool) }),
    ...(e.target && { target: redact(e.target) }),
    ...(e.route && { route: identifier(e.route) }),
    ...(e.usage && {
      usage: Object.fromEntries(
        Object.entries(e.usage).filter(
          ([k, v]) =>
            [
              'inputTokens',
              'cacheReadTokens',
              'cacheWriteTokens',
              'outputTokens',
              'totalTokens',
              'reasoningTokens',
            ].includes(k) && Number.isFinite(v),
        ),
      ),
    }),
    ...(e.text !== undefined && { text: redact(e.text) }),
    ...(e.slots && { slots: e.slots.map(redact) }),
  }))
}
