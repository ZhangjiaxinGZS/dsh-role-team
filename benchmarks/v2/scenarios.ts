import type { Fact, V2Scenario } from '../types.ts'
import { engineeringScenario, projects, role } from './engineering.ts'

const fact = (
  key: string,
  label: string,
  values: string[],
  unit?: string[],
  aliases: string[] = [],
): Fact => ({ key, label, aliases, values, unit })
const budget = (n: number) =>
  fact('budget', '预算', [String(n)], ['credits', '积分'], ['经费', 'cost ceiling'])
const deadline = (en: string, zh: string) =>
  fact('deadline', '期限', [en, zh], undefined, ['截止日期', 'due date'])
const owner = (en: string, zh: string) => fact('owner', '责任人', [en, zh], undefined, ['负责人'])
const option = (en: string, zh: string) => fact('option', '方案', [en, zh], undefined, ['choice', '推荐方案'])
const roles = [
  role('lead', 'Deliver the decision.'),
  role('finance', 'Check costs.'),
  role('ops', 'Check service constraints.'),
]
function decision(
  s: Omit<V2Scenario, 'roles' | 'stages' | 'split' | 'archetype'> &
    Partial<Pick<V2Scenario, 'roles' | 'stages' | 'split' | 'archetype'>>,
): V2Scenario {
  const schema = Object.fromEntries(
    s.facts.map((f) => [f.key, f.unit ? 'number or quantity with unit' : 'string']),
  )
  return {
    roles,
    stages: [],
    split: 'dev',
    archetype: 'parallel-read-synthesis',
    ...s,
    prompt:
      s.prompt +
      '\nSubmit delivery.json following this field schema (equivalent bilingual labels and nested groups accepted): ' +
      JSON.stringify(schema) +
      '. Explain the decision, trade-offs and required action to the sponsor. 可用中文或英文。',
  }
}
const g1 = [
  fact('audience', '受众', ['operators', '运维人员', 'operations staff']),
  budget(40),
  deadline('Friday', '周五'),
]
const g2 = [
  owner('procurement', '采购'),
  budget(80),
  deadline('Tuesday', '周二'),
  fact('region', '地区', ['west', '西区']),
]
const reviewRoles = [
  role('finance', 'Report price.'),
  role('privacy', 'Report residency.'),
  role('reliability', 'Report recovery target.'),
  role('support', 'Report launch coverage.'),
]
const g5 = [
  budget(75),
  fact('region', '地区', ['local', '本地']),
  fact('recovery', '恢复时限', ['15'], ['minutes', '分钟']),
  fact('coverage', '支持时段', ['weekends', '周末']),
]
const governance: V2Scenario[] = [
  decision({
    id: 'G1',
    title: 'Scope a pilot',
    facts: g1,
    card: g1,
    files: {
      'request.md':
        'Pilot approval is conditional on audience, spending cap and due date. The sponsor holds the missing values.',
    },
    prompt: 'Prepare the pilot for approval. Clarify missing constraints before allocating work.',
  }),
  decision({
    id: 'G2',
    title: 'Authorize a regional rollout',
    facts: g2,
    card: g2,
    split: 'holdout',
    files: {
      'intake.md': 'The sponsor has not disclosed accountability, geography, funding or the signoff date.',
    },
    prompt: 'Resolve the outstanding rollout constraints with the sponsor and prepare a decision.',
  }),
  decision({
    id: 'G3',
    title: 'Select a compliant storage tier',
    facts: [
      option('Harbor', '港湾'),
      budget(70),
      fact('alternative', '备选', ['Reef', '礁石']),
      fact('tradeoff', '取舍', ['lower latency costs more', '降低延迟需加钱', 'pay for speed']),
    ],
    files: {
      'finance.md': 'Harbor costs 70, Reef 95, Atlas 20 credits. Current cap is 80.',
      'latency.md': 'Harbor 20ms; Reef 8ms; Atlas 4ms. Smaller is better.',
      'residency.md': 'Harbor and Reef satisfy residency. Atlas exports data. Residency is mandatory.',
    },
    prompt:
      'Choose the fastest compliant affordable tier; identify its cost, the faster Pareto alternative under a raised cap, and the trade-off.',
  }),
  decision({
    id: 'G4',
    title: 'Reconcile clinic staffing offers',
    split: 'holdout',
    facts: [
      option('Cedar', '雪松'),
      fact('response', '响应', ['12'], ['minutes', '分钟']),
      fact('alternative', '备选', ['Birch', '白桦']),
      fact('tradeoff', '取舍', ['weekend cover costs more', '周末值班成本更高', 'pay for weekend coverage']),
    ],
    files: {
      'budget.md': 'Operating cap 60. Cedar costs 52, Birch 79, Elm 40.',
      'rota.md': 'Cedar weekdays, 12min response; Birch weekends too, 9min; Elm 5min.',
      'clinical.md':
        'Elm is unlicensed. Choose an affordable licensed weekday service. Document the Pareto alternative for weekend expansion.',
    },
    prompt:
      'Decide the current service, its response time, and the licensed alternative and trade-off for expansion.',
  }),
  decision({
    id: 'G5',
    title: 'Consolidate four specialist facts',
    multiAgentOnly: true,
    facts: g5,
    roles: [
      roles[0],
      ...reviewRoles.map((r, i) => ({
        ...r,
        privateContext: g5[i].label + ' = ' + g5[i].values[0] + (g5[i].unit ? ' ' + g5[i].unit![0] : ''),
      })),
    ],
    files: {
      'review.md':
        'Finance holds the budget, privacy holds the residency requirement, reliability holds the recovery target, and support holds the coverage period. Each specialist can provide their fact directly in a message.',
    },
    prompt:
      'Ask each of the four specialists for their factual value and record all four values in delivery.json. Their replies provide all the confirmation needed. No human signature or launch authorization is required.',
  }),
]
function continuity(
  id: 'C1' | 'C2' | 'C3' | 'C4',
  title: string,
  stages: string[],
  facts: Fact[],
): V2Scenario {
  const reset = id === 'C1' || id === 'C2'
  const archive = Array.from(
    { length: 640 },
    (_, i) => 'Closed item ' + i + ': reconciliation complete; obsolete batch ' + (i % 19) + '.',
  ).join('\n')
  return decision({
    id,
    title,
    facts,
    split: id === 'C4' ? 'holdout' : 'dev',
    archetype: 'long-horizon-continuity',
    files: {
      'ledger.txt': archive,
      'handoff.md':
        'Maintain the current plan across handoffs. Later instructions supersede conflicting earlier facts.',
    },
    prompt: 'Review the historical ledger and record this initial instruction: ' + stages[0],
    stages: stages.slice(1).map((instruction, i) => ({
      instruction,
      action: reset ? (i === stages.length - 2 ? 'compact-reset' : undefined) : 'controlled-brief',
    })),
  })
}
const continuityCases = [
  continuity(
    'C1',
    'Port maintenance handoff',
    [
      'Use east depot, budget 45. Owner is logistics.',
      'The audit changed the budget to 60. Keep the other decisions.',
      'Resume after maintenance. Submit the latest approved region, owner and budget.',
    ],
    [fact('region', '地区', ['east', '东区']), owner('logistics', '物流'), budget(60)],
  ),
  continuity(
    'C2',
    'Night shift recovery',
    [
      'Start with a 30 minute recovery objective; owner is operations.',
      'The deadline is Monday. Reduce the objective to 18 minutes.',
      'Resume the incident after the shift handoff. Deliver the authoritative recovery objective, deadline and owner.',
    ],
    [
      fact('recovery', '恢复时限', ['18'], ['minutes', '分钟']),
      deadline('Monday', '周一'),
      owner('operations', '运维'),
    ],
  ),
  continuity(
    'C3',
    'Capacity plan revision stream',
    [
      'Start at 90 credits for the north site.',
      'Raise the ceiling to 110 credits.',
      'Move the site to west.',
      'Set the final ceiling to 95 credits. Submit the approved envelope.',
    ],
    [budget(95), fact('region', '地区', ['west', '西区'])],
  ),
  continuity(
    'C4',
    'Approval routing revision stream',
    [
      'Initial owner is ops; review is Monday.',
      'Legal takes ownership.',
      'Move the date to Friday.',
      'Compliance takes final responsibility. Submit the effective routing.',
    ],
    [owner('compliance', '合规'), deadline('Friday', '周五')],
  ),
]
export const catalogue: V2Scenario[] = [
  ...projects.map(engineeringScenario),
  ...governance,
  ...continuityCases,
  {
    id: 'S1',
    title: 'Change one configuration value',
    roles,
    archetype: 'sequential-pivot',
    split: 'dev',
    prompt: 'Set retries in config.json to 4. Preserve all other entries. This is the entire change.',
    files: { 'config.json': '{"retries":2,"mode":"safe","stream":"001"}' },
    facts: [
      fact('retries', 'retries', ['4']),
      fact('mode', 'mode', ['safe']),
      fact('stream', 'stream', ['001']),
    ],
    stages: [],
  },
  {
    id: 'S2',
    title: 'Look up one record',
    roles,
    archetype: 'parallel-read-synthesis',
    split: 'dev',
    prompt: 'Read only. Reply with the duration for item K03 as a quantity with units. Do not write files.',
    files: { 'durations.csv': 'id,minutes\nK01,7\nK03,12\nK30,21' },
    facts: [fact('duration', '时长', ['12'], ['minutes', 'min', '分钟'])],
    stages: [],
  },
  decision({
    id: 'S3',
    title: 'Format three inventory codes',
    split: 'holdout',
    files: { 'codes.csv': '001,west\n023,north\n007,east' },
    facts: [fact('codes', '编码', ['001:west|023:north|007:east'])],
    prompt:
      'Return the three codes as one pipe-separated id:region string in original order. Preserve leading zeros.',
  }),
  decision({
    id: 'L2',
    title: 'Hand off a revised cold-chain plan',
    archetype: 'long-horizon-continuity',
    files: {
      'plan.md':
        'Approval A: use north, reserve 6 vans, contact ops. Outstanding: radio check. Record final authority and the open action.',
    },
    facts: [
      owner('logistics', '物流'),
      fact('region', '地区', ['east', '东区']),
      fact('vans', '车辆', ['4']),
      fact('pending', '待办', ['seal check', '封签检查']),
      fact('authority', '依据', ['D']),
    ],
    prompt:
      'Maintain the authoritative dispatch plan and its open action across shift handoffs. plan.md is read-only; do not edit it. Write the final handoff plan to delivery.json.',
    stages: [
      { instruction: 'Approval B overrides north with west, and ops hands ownership to logistics.' },
      {
        instruction: 'Approval C cancels west and sends four vans east; the radio check is complete.',
        action: 'compact',
      },
      {
        instruction:
          'Approval D requires a seal check before dispatch. Deliver the final plan, remaining action and final approval ID.',
        action: 'compact-reset',
      },
    ],
  }),
  decision({
    id: 'L3',
    title: 'Replan a constrained maintenance roster',
    archetype: 'sequential-pivot',
    split: 'holdout',
    files: {
      'skill.md': 'Only A or B may do lift; any worker may do audit or seal.',
      'slots.md': 'Use slots 1,2,3 exactly once. Lift must precede seal.',
      'cost.md':
        'A costs 4, B costs 3, C costs 2 per job. If C works slot 1, add a 2-credit callout. Cap 10; each person works once.',
      'coverage.md': 'A cannot cover slot 3. B can cover any slot.',
    },
    facts: [fact('lift', '吊装', ['A1']), fact('audit', '审计', ['C3']), fact('seal', '封签', ['B2'])],
    stages: [
      {
        instruction:
          'C loses access to slot 2. Replan; every other skill, availability, precedence and cost constraint still holds.',
      },
    ],
    prompt:
      'Assign lift, audit and seal. Encode each assignment as worker followed by slot (e.g. B2). Any feasible roster is accepted.',
  }),
]
