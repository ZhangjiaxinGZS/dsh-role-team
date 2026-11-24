import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { z } from 'zod'
import { indexRecords } from '../../shared/index.js'

export const teamDomain = defineDomain({
  name: 'role_team',
  version: 1,
  tables: {
    team_schedules: domainTable(indexRecords.team_schedules),
    role_models: domainTable(indexRecords.role_models),
    team_runs: domainTable(indexRecords.team_runs),
    team_seats: domainTable(indexRecords.team_seats),
    seat_generations: domainTable(indexRecords.seat_generations),
    training_sessions: domainTable(indexRecords.training_sessions),
  },
})

function records<T>(table: KvTable<string, T>, schema: z.ZodType<T>, keyOf: (row: T) => string) {
  return {
    get: (key: string) => structuredClone(table.get(key)),
    list: () => Array.from(table.entries(), ([, row]) => structuredClone(row)),
    put(input: T) {
      const row = schema.parse(input)
      return table.put(keyOf(row), row)
    },
    delete: (key: string) => table.delete(key),
    update(key: string, change: (value: T) => T) {
      return table
        .update(key, (row) => {
          const next = schema.parse(change(structuredClone(row)))
          if (keyOf(next) !== key) throw new Error('Record identity cannot change during update')
          return next
        })
        .then((value) => structuredClone(value))
    },
  }
}

export type Index = ReturnType<typeof repository>
export function generationKey(seatId: string, generation: number) {
  return JSON.stringify([seatId, generation])
}

export function repository(domain: Domain<typeof teamDomain>) {
  return {
    schedules: records(domain.table('team_schedules'), indexRecords.team_schedules, r => r.scheduleId),
    models: records(domain.table('role_models'), indexRecords.role_models, (r) => r.roleId),
    runs: records(domain.table('team_runs'), indexRecords.team_runs, (r) => r.runId),
    seats: records(domain.table('team_seats'), indexRecords.team_seats, (r) => r.seatId),
    generations: records(domain.table('seat_generations'), indexRecords.seat_generations, (r) =>
      generationKey(r.seatId, r.generation),
    ),
    training: records(
      domain.table('training_sessions'),
      indexRecords.training_sessions,
      (r) => r.trainingId,
    ),
  }
}
