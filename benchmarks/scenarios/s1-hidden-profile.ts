import { document, seedFiles, verdict, type ScenarioSpec } from '../types.ts'

// Only the workspace sources and role cards are visible to the model.
const facts = { region: 'EU', budget: 80, retention: 7, latency: 120, export: 'CSV' }
export const s1: ScenarioSpec = {
  id: 'S1',
  title: 'Select an offline release plan',
  category: 'Hidden profile',
  theoreticalBasis: 'Stasser & Titus (1985)',
  roles: [
    { id: 'lead', name: 'Release lead', duty: 'Select one feasible offer.' },
    {
      id: 'privacy',
      name: 'Privacy',
      duty: 'Review residency and retention.',
      privateContext: 'EU residency is mandatory.',
    },
    {
      id: 'ops',
      name: 'Operations',
      duty: 'Review service performance.',
      privateContext: 'The p95 latency ceiling is 120 ms.',
    },
  ],
  seedWorkspace: (dir) =>
    seedFiles(dir, {
      'finance.txt': 'Maximum cost: 80 credits.',
      'retention.txt': 'Retention: seven days.',
      'customer.txt': 'CSV export is mandatory.',
      'offers.csv':
        'offer,region,cost,retentionDays,latencyMs,export\nAlpha,EU,75,7,110,CSV\nBeta,US,60,7,90,CSV\nGamma,EU,85,14,100,PDF',
    }),
  initialPrompt:
    'Choose an offer that respects every stakeholder and memo. Write delivery.json with offer and the required constraints: region, budget, retention, latency, export. Preserve release-policy.txt.',
  async verify(ctx) {
    const d = await document(ctx.workspace)
    const checks = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, d[k] === v]))
    const pooled = Object.values(checks).filter(Boolean).length
    return {
      ...(await verdict(
        ctx,
        { ...checks, feasibleOffer: d.offer === 'Alpha' },
        Number(['Beta', 'Gamma'].includes(String(d.offer))),
      )),
      hiddenFactsPooled: pooled,
      hiddenFactsTotal: 5,
    }
  },
}
