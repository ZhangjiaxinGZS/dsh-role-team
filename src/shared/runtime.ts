import { z } from 'zod'
import {
  fileId,
  teamBrief,
  briefSaveResult,
  indexRecords,
  editResult,
  revision,
  conversationLocale,
  modelChoice,
  permissionPresetId,
  leaderPolicy,
  snapshotSchema,
  hash,
} from './index.js'

import { scheduleDraft, scheduleChange, scheduleHistory, scheduleRow } from './schedules.js'

const id = z.string().min(1).max(256)
const workspaceCwd = z.string().min(1)
const title = z.string().trim().min(1).max(160)
const run = z.strictObject({ runId: id })
const seat = z.strictObject({ seatId: id })
const training = z.strictObject({ trainingId: id })
const team = z.strictObject({ run: indexRecords.team_runs, seats: z.array(indexRecords.team_seats) })
export const runtimeMethods = {
  createRole: [z.strictObject({
    name: title,
    summary: z.string().trim().max(160).optional(),
    defaultModel: modelChoice.optional(),
    defaultPermission: permissionPresetId.optional(),
  }), editResult],
  deleteRole: [z.strictObject({ roleId: fileId, expectedHash: hash.nullable() }), editResult],
  roleHistory: [
    z.strictObject({ roleId: fileId }),
    z.array(snapshotSchema.pick({ publishedRevision: true, publishedAt: true, role: true })).max(10),
  ],
  restoreRole: [z.strictObject({ roleId: fileId, revision, expectedHash: hash }), editResult],
  createTeam: [
    z.strictObject({
      title,
      roleId: fileId,
      workspaceCwd,
      agentPreset: id.optional(),
      locale: conversationLocale.optional(),
    }),
    team,
  ],
  listTeams: [
    z.strictObject({ includeMemberCounts: z.boolean().optional() }),
    z.array(indexRecords.team_runs.extend({ memberCount: z.int().nonnegative().optional(), memberSessionIds: z.array(id).optional() })),
  ],
  teamSchedules: [run, z.array(scheduleRow)],
  createTeamSchedule: [scheduleDraft.extend({ runId: id }), scheduleRow],
  changeTeamSchedule: [scheduleChange.extend({ runId: id }), z.boolean()],
  teamScheduleHistory: [run.extend({ id, before: id.optional() }), scheduleHistory],
  updateLeaderPolicy: [run.extend({ policy: leaderPolicy.refine(
    p => p.mode !== 'custom' || !!p.customText?.trim(), 'Custom policy text is required',
  ) }), indexRecords.team_runs],
  getTeamBrief: [run, teamBrief.nullable()],
  saveTeamBrief: [run.extend({ text: z.string().max(4000), expectedHash: hash.nullable() }), briefSaveResult],
  getTeam: [run, team.extend({ capabilities: z.strictObject({ schedules: z.boolean() }).optional(), formalSessionIds: z.array(id).optional() })],
  teamMentionRoster: [
    z.strictObject({ sessionId: id }),
    z.strictObject({
      runId: id,
      members: z.array(z.strictObject({ seatId: id, name: z.string(), address: z.string(), duty: z.string(), leader: z.boolean() })),
    }).nullable(),
  ],
  teamMessageSender: [
    z.strictObject({ sessionId: id, senderId: id.optional(), senderName: id.optional() }),
    z.strictObject({ name: title.nullable(), fromParent: z.boolean().optional() }).nullable(),
  ],
  renameTeam: [run.extend({ title }), indexRecords.team_runs],
  teamArchiveImpact: [run, z.int().nonnegative()],
  archiveTeam: [run.extend({ expectedActiveSchedules: z.int().nonnegative().optional() }), indexRecords.team_runs],
  deleteTeam: [run, z.boolean()],
  addMember: [
    run.extend({ roleId: fileId, parentSeatId: id.optional(), displayName: title.optional() }),
    indexRecords.team_seats,
  ],
  versionDecision: [
    seat.extend({ revision, decision: z.enum(['next-turn', 'keep']) }),
    indexRecords.team_seats,
  ],
  seatModels: [
    z.strictObject({}),
    z.array(
      z.strictObject({
        provider: id,
        model: id,
        name: title,
        defaultEffort: id.optional(),
        efforts: z.array(z.strictObject({ id, name: title })),
        isDefault: z.boolean().optional(),
      }),
    ),
  ],
  selectSeatModel: [
    seat.extend({ generation: revision, selection: modelChoice }),
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
  rememberExperience: [
    z.strictObject({
      roleId: fileId,
      title: title.optional(),
      body: z.string().trim().min(1).max(24000),
    }),
    fileId,
  ],
  openTraining: [
    z.strictObject({ roleId: fileId, locale: conversationLocale.optional() }),
    indexRecords.training_sessions,
  ],
  createTraining: [
    z.strictObject({
      roleId: fileId,
      locale: conversationLocale.optional(),
      mode: indexRecords.training_sessions.shape.mode,
      expectedTrainingId: id.optional(),
      workspaceCwd: workspaceCwd.optional(),
      sourceRunId: id.optional(),
    }),
    indexRecords.training_sessions,
  ],
  getTraining: [training, indexRecords.training_sessions],
  listTrainings: [
    z.strictObject({ roleId: fileId.optional() }),
    z.array(indexRecords.training_sessions),
  ],
  libraryInfo: [
    z.strictObject({}),
    z.strictObject({ activePath: z.string(), configuredPath: z.string() }),
  ],
  rejectProposal: [training.extend({ proposalId: fileId }), indexRecords.training_sessions],
  confirmProposal: [training.extend({ proposalId: fileId }), editResult],
} as const
export type Method = keyof typeof runtimeMethods
export type Input<K extends Method> = z.infer<(typeof runtimeMethods)[K][0]>
export type RuntimeRpc = {
  [K in Method]: (request: Input<K>) => Promise<z.infer<(typeof runtimeMethods)[K][1]>>
}
