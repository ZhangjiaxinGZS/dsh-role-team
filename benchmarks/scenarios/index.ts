import { s1 } from './s1-hidden-profile.ts'
import { s2 } from './s2-grounding.ts'
import { s3 } from './s3-pivot.ts'
import { s4 } from './s4-compaction.ts'
import { s5 } from './s5-dense-reports.ts'
import { s6 } from './s6-cross-task.ts'
import type { Capability, ScenarioId, ScenarioSpec } from '../types.ts'

export const scenarios: Record<ScenarioId, ScenarioSpec> = {
  S1: s1,
  S2: s2,
  S3: s3,
  S4: s4,
  S5: s5,
  S6: s6,
}
export const requiredCapabilities: Record<ScenarioId, Capability[]> = {
  S1: [],
  S2: ['clarification'],
  S3: ['pivots'],
  S4: ['compaction', 'reset'],
  S5: ['parallel-reports'],
  S6: ['pivots', 'training'],
}
