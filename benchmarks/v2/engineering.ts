import type { Role, V2Scenario } from '../types.ts'

export interface ModuleSpec {
  name: string
  signature: string
  body: string
}
export interface Example {
  name: string
  input: unknown
  expected: unknown
  stage?: number
}
export interface Project {
  id: 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6'
  title: string
  types: string
  modules: ModuleSpec[]
  cases: Example[]
  requirements: Record<string, string>
  changes: string[]
}
const mod = (name: string, signature: string, body: string): ModuleSpec => ({ name, signature, body })
const check = (name: string, input: unknown, expected: unknown, stage?: number): Example => ({
  name,
  input,
  expected,
  stage,
})
const sales = [
  { id: 'a', value: 30, region: 'east' },
  { id: 'a', value: 99, region: 'east' },
  { id: 'b', value: 6, region: 'west' },
]
export const projects: Project[] = [
  {
    id: 'E1',
    title: 'Publish a consent-aware directory',
    types: 'export type Row = { name:string; email:string; consent?:boolean }',
    requirements: {
      'privacy.txt': 'Only explicit opt-in can be published. Never return email addresses.',
      'compat.txt':
        'Return trimmed display names in input order, removing blank names and case-insensitive duplicates. Preserve the first spelling.',
    },
    modules: [
      mod('eligible', '(rows:Row[]):Row[]', 'return rows.filter(r=>r.consent===true)'),
      mod(
        'display',
        '(rows:Row[]):string[]',
        'const seen=new Set<string>(); return rows.map(r=>r.name.trim()).filter(n=>{const key=n.toLowerCase(); if(!n||seen.has(key))return false; seen.add(key); return true})',
      ),
    ],
    cases: [
      check('consent', [{ name: 'Lee', email: 'private' }], []),
      check(
        'compatibility',
        [
          { name: ' Ada ', email: 'a', consent: true },
          { name: 'ADA', email: 'b', consent: true },
          { name: '', email: 'c', consent: true },
        ],
        ['Ada'],
      ),
      check(
        'ordering',
        [
          { name: 'Z', email: 'z', consent: true },
          { name: 'B', email: 'b', consent: true },
        ],
        ['Z', 'B'],
      ),
    ],
    changes: [],
  },
  {
    id: 'E2',
    title: 'Reconcile a metered billing feed',
    types: 'export type Row = { id:string; value:number; region:string }',
    requirements: {
      'operations.txt':
        'Deduplicate by id before summing. Keep the first event, including a zero charge. Process the feed in one pass per module.',
      'billing.txt':
        'Ignore negative charges. Group by region in lexicographic order and return pairs [region,total].',
    },
    modules: [
      mod(
        'unique',
        '(rows:Row[]):Row[]',
        'const seen=new Set<string>(); return rows.filter(r=>!seen.has(r.id)&&!!seen.add(r.id))',
      ),
      mod(
        'totals',
        '(rows:Row[]):[string,number][]',
        'const m=new Map<string,number>(); for(const r of rows) if(r.value>=0)m.set(r.region,(m.get(r.region)??0)+r.value); return [...m].sort(([a],[b])=>a.localeCompare(b))',
      ),
    ],
    cases: [
      check('dedup', sales, [
        ['east', 30],
        ['west', 6],
      ]),
      check(
        'signed and zero',
        [
          { id: '1', value: -3, region: 'w' },
          { id: '2', value: 0, region: 'e' },
        ],
        [['e', 0]],
      ),
      check(
        'throughput',
        Array.from({ length: 2400 }, (_, i) => ({ id: String(i % 1200), value: 1, region: 'z' })),
        [['z', 1200]],
      ),
    ],
    changes: [],
  },
  {
    id: 'E3',
    title: 'Migrate the shipping quotation API',
    types: 'export type Row = { kg:number; zone:string }',
    requirements: {
      'rates.txt':
        'Quote shipments from mass in kg. Each started kg costs 3 units. Initially return the total as a number.',
    },
    changes: [
      'Revision 1: exclude cancelled shipments (zone void).',
      'Revision 2: return {units, count} including only eligible shipments.',
    ],
    modules: [
      mod('select', '(rows:Row[]):Row[]', "return rows.filter(r=>r.zone!=='void')"),
      mod(
        'quote',
        '(rows:Row[])',
        'return {units:rows.reduce((n,r)=>n+3*Math.ceil(r.kg),0),count:rows.length}',
      ),
    ],
    cases: [
      check('initial', [{ kg: 1.5, zone: 'active' }], 6, 0),
      check('cancelled', [{ kg: 2, zone: 'void' }], 0, 1),
      check(
        'final API',
        [
          { kg: 2, zone: 'void' },
          { kg: 1.5, zone: 'ok' },
        ],
        { units: 6, count: 1 },
      ),
      check('empty', [], { units: 0, count: 0 }),
    ],
  },
  {
    id: 'E4',
    title: 'Revise the telemetry aggregation contract',
    types: 'export type Row = { site:string; ms:number }',
    requirements: {
      'telemetry.txt': 'Initially report the maximum latency in milliseconds, or zero for an empty feed.',
    },
    changes: [
      'Revision 1: discard negative observations; round valid observations to integer milliseconds.',
      'Revision 2: return a map from site to maximum valid latency, excluding sites without a valid observation.',
    ],
    modules: [
      mod(
        'valid',
        '(rows:Row[]):Row[]',
        'return rows.filter(r=>r.ms>=0).map(r=>({...r,ms:Math.round(r.ms)}))',
      ),
      mod(
        'peak',
        '(rows:Row[])',
        'const data=new Map<string,number>(); for(const r of rows)data.set(r.site, Math.max(data.get(r.site)??0,r.ms)); return Object.fromEntries(data)',
      ),
    ],
    cases: [
      check(
        'initial',
        [
          { site: 'a', ms: 1 },
          { site: 'b', ms: 4 },
        ],
        4,
        0,
      ),
      check(
        'rounding',
        [
          { site: 'a', ms: 2.7 },
          { site: 'b', ms: -4 },
        ],
        3,
        1,
      ),
      check(
        'per site',
        [
          { site: 'a', ms: 2 },
          { site: 'a', ms: 4.7 },
          { site: 'b', ms: 0 },
          { site: 'c', ms: -1 },
        ],
        { a: 5, b: 0 },
      ),
      check('empty', [], {}),
    ],
  },
  {
    id: 'E5',
    title: 'Integrate a municipal ticket queue',
    types: 'export type Row = { key:string; priority:number; open:boolean }',
    requirements: {
      'ingest.txt': 'Keep open tickets only.',
      'triage.txt': 'Desc priority, then ascending key; sorting must preserve input.',
      'output.txt': 'Publish the top three distinct ticket keys after ranking.',
    },
    modules: [
      mod('ingest', '(rows:Row[]):Row[]', 'return rows.filter(r=>r.open)'),
      mod(
        'rank',
        '(rows:Row[]):Row[]',
        'return [...rows].sort((a,b)=>b.priority-a.priority||a.key.localeCompare(b.key))',
      ),
      mod('publish', '(rows:Row[]):string[]', 'return [...new Set(rows.map(r=>r.key))].slice(0,3)'),
    ],
    cases: [
      check(
        'integration',
        ['d', 'a', 'b', 'c', 'd', 'x'].map((key, i) => ({
          key,
          priority: i === 0 ? 2 : 1,
          open: key !== 'x',
        })),
        ['d', 'a', 'b'],
      ),
      check('closed', [{ key: 'done', priority: 9, open: false }], []),
      check(
        'ties',
        ['b', 'a'].map((key) => ({ key, priority: 0, open: true })),
        ['a', 'b'],
      ),
    ],
    changes: [],
  },
  {
    id: 'E6',
    title: 'Transfer the reconciliation routine to a second depot',
    types: 'export type Row = { key:string; revision:number; depot:string; active:boolean }',
    requirements: {
      'depot.txt':
        'T1: reconcile north depot, keeping only each key’s latest revision (last event wins ties), then publish sorted active keys.',
    },
    changes: [
      'T2: apply the reconciliation lesson in a fresh session at the south depot. Now publish sorted [key,revision] pairs.',
    ],
    modules: [
      mod(
        'latest',
        '(rows:Row[]):Row[]',
        "const m=new Map<string,Row>(); for(const r of rows)if(r.depot==='south' && r.revision >= (m.get(r.key)?.revision??-Infinity))m.set(r.key,r); return [...m.values()]",
      ),
      mod(
        'active',
        '(rows:Row[])',
        'return rows.filter(r=>r.active).sort((a,b)=>a.key.localeCompare(b.key)).map(r=>[r.key,r.revision])',
      ),
    ],
    cases: [
      check(
        'north',
        [
          { key: 'a', depot: 'north', revision: 1, active: true },
          { key: 'a', depot: 'north', revision: 0, active: false },
        ],
        ['a'],
        0,
      ),
      check(
        'depot and revisions',
        [
          { key: 'a', depot: 'north', revision: 9, active: true },
          { key: 'a', depot: 'south', revision: 2, active: true },
          { key: 'a', depot: 'south', revision: 1, active: false },
        ],
        [['a', 2]],
      ),
      check(
        'last tie',
        [
          { key: 'a', depot: 'south', revision: 2, active: true },
          { key: 'a', depot: 'south', revision: 2, active: false },
        ],
        [],
      ),
    ],
  },
]
export function role(id: string, duty: string): Role {
  return { id, name: id, duty }
}
export function projectSources(p: Project, solution = false, stage = p.changes.length) {
  const files: Record<string, string> = { 'types.ts': p.types }
  for (const m of p.modules) {
    let body = m.body
    if (p.id === 'E3' && stage < 2 && m.name === 'quote')
      body = 'return rows.reduce((n,r)=>n+3*Math.ceil(r.kg),0)'
    if (p.id === 'E3' && stage === 0 && m.name === 'select') body = 'return rows'
    if (p.id === 'E4' && stage < 2 && m.name === 'peak') body = 'return Math.max(0,...rows.map(r=>r.ms))'
    if (p.id === 'E4' && stage === 0 && m.name === 'valid') body = 'return rows'
    if (p.id === 'E6' && stage === 0)
      body = body.replace("'south'", "'north'").replace('[r.key,r.revision]', 'r.key')
    files[m.name + '.ts'] =
      "import type { Row } from './types.js'\nexport function " +
      m.name +
      m.signature +
      ' { ' +
      (solution ? body : "throw new Error('TODO')") +
      ' }\n'
  }
  const imports = p.modules.map((m) => 'import { ' + m.name + " } from './" + m.name + ".js'")
  files['index.ts'] = [
    ...imports,
    "import type { Row } from './types.js'",
    'export function run(rows:Row[]) { return ' +
      p.modules.reduce((arg, m) => m.name + '(' + arg + ')', 'rows') +
      ' }',
  ].join('\n')
  return files
}
export function engineeringScenario(p: Project): V2Scenario {
  return {
    id: p.id,
    title: p.title,
    split: ['E2', 'E4'].includes(p.id) ? 'holdout' : 'dev',
    archetype:
      p.id === 'E6'
        ? 'long-horizon-continuity'
        : p.changes.length
          ? 'sequential-pivot'
          : 'multi-module-isolation',
    roles: [
      role('lead', 'Integrate and verify the complete API.'),
      ...p.modules.map((m) => role(m.name, 'Own ' + m.name + '.ts')),
    ],
    prompt:
      'Implement the TypeScript project and its run(rows) entry point using the shared requirements. 保持导出接口与类型约束。',
    files: { ...p.requirements, ...projectSources(p) },
    facts: [],
    stages: p.changes.map((instruction) => ({
      instruction,
      ...(p.id === 'E6' && { action: 'fresh-team' as const }),
    })),
  }
}
