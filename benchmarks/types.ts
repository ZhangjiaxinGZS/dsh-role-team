import type { bootstrapCI, cliffsDelta, mcnemarExact, wilcoxonSignedRank } from './stats.ts'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const arms = [
  'single-agent',
  'v0.1.0',
  'v0.2.0-no-brief',
  'v0.2.0-prefix-brief',
  'v0.2.0-full',
] as const
export type AblationArm = (typeof arms)[number]
export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'
export const syntheticMode = 'dry-run (synthetic harness validation)'
export type Mode = typeof syntheticMode | 'live'
export type Preset = 'standard' | 'ptc'
export interface Role {
  id: string
  name: string
  duty: string
  privateContext?: string
}
export interface Observation {
  kind:
    | 'question'
    | 'answer'
    | 'pivot'
    | 'work'
    | 'assignment'
    | 'report'
    | 'board'
    | 'compaction'
    | 'reset'
    | 'experience'
    | 'stage1'
    | 'stage2'
  step: number
  actor: string
  text: string
}
export interface VerifyContext {
  workspace: string
  observations: readonly Observation[]
  workers: readonly string[]
}
export interface ScenarioVerification {
  passed: boolean
  constraintViolations: number
  milestoneKpi: number
  hiddenFactsPooled?: number
  hiddenFactsTotal?: number
  clarificationCoverage?: number
  commPrecision?: number
  commRecall?: number
  adaptationLatencySteps?: number
  postPivotCoherence?: number
  postCompactionRetention?: number
  handoffFidelity?: number
  closedLoopRate?: number
  stage1Passed?: boolean
  stage2Passed?: boolean
  details: Record<string, unknown>
}
export interface ScenarioSpec {
  id: ScenarioId
  title: string
  category: string
  theoreticalBasis: string
  roles: Role[]
  initialPrompt: string
  seedWorkspace(dir: string): Promise<void>
  simulatedUser?(question: string): string
  pivots?: { progress: number; instruction: string }[]
  verify(ctx: VerifyContext): Promise<ScenarioVerification>
}
export interface TrialResult {
  scenario: ScenarioId
  arm: AblationArm
  model: string
  preset: Preset
  repeat: number
  mode: Mode
  reasoningEfforts?: string[]
  verification: ScenarioVerification
  metrics: import('./log-parser.ts').LogMetrics
}
export interface ArmStats {
  model: string
  preset: Preset
  mode: Mode
  arm: AblationArm
  trials: number
  passAt1: number
  passPow3: number | null
  milestoneKpi: number
  cvr: number
  kvCacheHitRate: number | null
  providerUsage?: {
    uncachedInput: number
    cacheRead: number
    cacheWrite: number
    output: number
    promptCacheReadShare: number | null
  }
  tokensPerSolved: number | null
  commF1: number | null
  noiseRatio: number
  learningGain: number | null
  intervals: Record<string, ReturnType<typeof bootstrapCI> | null>
  mast: { deniedToolCalls: number; staleInProgressTasks: number; repeatedIdenticalToolCalls: number }
}
export interface ComparisonReport {
  mode: Mode
  arms: ArmStats[]
  comparisons: {
    model: string
    preset: Preset
    baseline: AblationArm
    arm: AblationArm
    pairs: number
    pass: ReturnType<typeof mcnemarExact>
    cvr: ReturnType<typeof mcnemarExact>
    continuous: Record<
      string,
      {
        wilcoxon: ReturnType<typeof wilcoxonSignedRank>
        cliffs: ReturnType<typeof cliffsDelta>
        difference: ReturnType<typeof bootstrapCI>
      } | null
    >
  }[]
  trials: TrialResult[]
}

export type Capability = 'clarification' | 'pivots' | 'compaction' | 'reset' | 'parallel-reports' | 'training'
export interface LiveTrial {
  arm: AblationArm
  model: string
  preset: Preset
  repeat: number
  scenario: ScenarioSpec
  dshHome: string
  roleStoreDir: string
  workspace: string
  traceDir: string
}
export interface LiveHostDriver {
  arms: readonly AblationArm[]
  capabilities: readonly Capability[]
  runTrial(trial: LiveTrial): Promise<{
    traces: { path: string; leader: boolean; hasBrief?: boolean }[]
    observations: Observation[]
    workers: string[]
    reasoningEfforts?: string[]
  }>
}

export const guardFile = 'release-policy.txt'
export const guardText = 'Immutable release policy: offline deployment only.\n'
export async function seedFiles(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries({ ...files, [guardFile]: guardText }))
    await writeFile(join(dir, name), text, { flag: 'wx' })
}
// Only regular, top-level fixture artifacts are admissible, including after a live trial.
export async function artifact(dir: string, name: string) {
  const path = join(dir, name)
  try {
    const stat = await lstat(path)
    return stat.isFile() && stat.size <= 1024 * 1024 ? await readFile(path, 'utf8') : ''
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
export async function document(dir: string, name = 'delivery.json'): Promise<Record<string, unknown>> {
  const raw = await artifact(dir, name)
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}
export async function verdict(ctx: VerifyContext, checks: Record<string, boolean>, violations = 0) {
  const constraintViolations = violations + Number((await artifact(ctx.workspace, guardFile)) !== guardText)
  const milestones = Object.values(checks)
  return {
    passed: !constraintViolations && milestones.every(Boolean),
    constraintViolations,
    milestoneKpi: milestones.filter(Boolean).length / milestones.length,
    details: { checks },
  }
}

export async function safePath(name: string): Promise<string> {
  const path = resolve(name)
  const forbidden = ['.dsh', '.dsh-role-team'].map((p) => join(homedir(), p))
  if (forbidden.some((p) => p === path || path.startsWith(p + sep)))
    throw new Error('Production directories are out of bounds')
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    canonical = join(await safePath(dirname(path)), basename(path))
  }
  if (forbidden.some((p) => p === canonical || canonical.startsWith(p + sep)))
    throw new Error('Production directories are out of bounds')
  return canonical
}
