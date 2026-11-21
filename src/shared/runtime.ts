import { z } from 'zod'
import { fileId, indexRecords, editResult, revision } from './index.js'

const id = z.string().min(1).max(256)
const workspaceCwd = z.string().min(1)
const title = z.string().trim().min(1).max(160)
const note = z.string().trim().min(1).max(8000)
const run = z.strictObject({ runId: id })
const seat = z.strictObject({ seatId: id })
const training = z.strictObject({ trainingId: id })
const team = z.strictObject({ run: indexRecords.team_runs, seats: z.array(indexRecords.team_seats) })
export const runtimeMethods = {
  createTeam: [z.strictObject({ title, roleId: fileId, workspaceCwd }), team],
  listTeams: [z.strictObject({}), z.array(indexRecords.team_runs)],
  getTeam: [run, team],
  renameTeam: [run.extend({ title }), indexRecords.team_runs],
  archiveTeam: [run, indexRecords.team_runs],
  addMember: [
    run.extend({ roleId: fileId, parentSeatId: id.optional(), displayName: title.optional() }),
    indexRecords.team_seats,
  ],
  versionDecision: [
    seat.extend({ revision, decision: z.enum(['next-turn', 'keep']) }),
    indexRecords.team_seats,
  ],
  resetSeat: [
    seat.extend({ generation: revision, handoff: z.string().max(8000) }),
    indexRecords.team_seats,
  ],
  promptSeat: [
    seat.extend({
      generation: revision,
      requestId: id,
      delivery: z.enum(['queue', 'steer']),
      text: z.string().trim().min(1).max(64000),
    }),
    z.strictObject({ accepted: z.literal(true), sessionId: id }),
  ],
  listGenerations: [seat, z.array(indexRecords.seat_generations)],
  addNote: [run.extend({ seatId: id.optional(), content: note }), indexRecords.team_local_notes],
  listNotes: [run, z.array(indexRecords.team_local_notes)],
  createTraining: [
    z.strictObject({
      roleId: fileId,
      mode: indexRecords.training_sessions.shape.mode,
      workspaceCwd,
      sourceRunId: id.optional(),
    }),
    indexRecords.training_sessions,
  ],
  getTraining: [training, indexRecords.training_sessions],
  listTrainings: [z.strictObject({ roleId: fileId }), z.array(indexRecords.training_sessions)],
  confirmProposal: [training.extend({ proposalId: fileId }), editResult],
} as const
export type Method = keyof typeof runtimeMethods
export type Input<K extends Method> = z.infer<(typeof runtimeMethods)[K][0]>
export type RuntimeRpc = {
  [K in Method]: (request: Input<K>) => Promise<z.infer<(typeof runtimeMethods)[K][1]>>
}
