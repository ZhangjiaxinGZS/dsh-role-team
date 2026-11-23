import { z } from 'zod'
import type { RuntimeRpc } from './runtime.js'
export type { Input, RuntimeRpc } from './runtime.js'

export const fileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, 'Expected a lowercase file identifier')
  .refine((id) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id), 'Reserved filename')
export const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const revision = z.number().int().positive()
const timestamp = z.iso.datetime({ offset: true })
const names = z.array(z.string().min(1))
export const roleNameKey = (name: string) => name.trim().toLowerCase()
export const duplicateRoleName = '已存在同名角色，请重新输入'
export const roleMeta = z.strictObject({
  id: fileId,
  name: z.string().trim().min(1),
  summary: z
    .string()
    .trim()
    .max(160)
    .regex(/^[^\r\n]*$/)
    .optional(),
  version: revision.optional(),
  model: z.string().min(1).optional(),
  skills: names.optional(),
  tools: z.strictObject({ allow: names.optional(), deny: names.optional() }).optional(),
  updatedAt: timestamp.optional(),
})
export const memoryMeta = z.strictObject({
  id: fileId,
  title: z.string().trim().min(1),
  scope: z.literal('role_long_term'),
  // Older files may carry a status; every saved experience is active.
  status: z.enum(['draft', 'published', 'archived']).optional(),
  source: z.string().optional(),
  createdAt: timestamp,
})
export type RoleMeta = z.infer<typeof roleMeta>
export type MemoryMeta = z.infer<typeof memoryMeta>
export const fileRef = z.strictObject({ roleId: fileId, memoryId: fileId.optional() })
export type FileRef = z.infer<typeof fileRef>
export const editRequest = fileRef.extend({ expectedHash: hash.nullable(), text: z.string() })
export const deleteRequest = fileRef.extend({ expectedHash: hash })
export type EditRequest = z.infer<typeof editRequest>
export type DeleteRequest = z.infer<typeof deleteRequest>
export const fileContents = z.strictObject({ text: z.string(), hash })
export const diagnostic = z.strictObject({
  file: z.string(),
  line: z.int().positive(),
  message: z.string(),
})
export const roleStatus = z.strictObject({
  roleId: fileId,
  publishedRevision: revision.nullable(),
  error: diagnostic.nullable(),
})
export type FileContents = z.infer<typeof fileContents>
export type Diagnostic = z.infer<typeof diagnostic>
export type RoleStatus = z.infer<typeof roleStatus>
export const snapshotSchema = z.strictObject({
  roleId: fileId,
  publishedRevision: revision,
  sourceHash: hash,
  publishedAt: timestamp,
  role: z.strictObject({ meta: roleMeta, body: z.string() }),
  memories: z.array(z.strictObject({ meta: memoryMeta, body: z.string() })),
})
export type Snapshot = z.infer<typeof snapshotSchema>
export const editResult = z.union([
  z.strictObject({ ok: z.literal(true), status: roleStatus, hash: hash.nullable() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal('conflict'),
    current: fileContents.nullable(),
    proposed: z.string().nullable(),
  }),
  z.strictObject({ ok: z.literal(false), code: z.literal('invalid'), error: diagnostic }),
])
export type EditResult = z.infer<typeof editResult>
export interface RoleTeamRpc extends RuntimeRpc {
  listRoles(): Promise<RoleStatus[]>
  listMemories(roleId: string): Promise<string[]>
  readDocument(ref: FileRef): Promise<FileContents | null>
  saveDocument(request: EditRequest): Promise<EditResult>
  deleteDocument(request: DeleteRequest): Promise<EditResult>
  readSnapshot(roleId: string, publishedRevision: number): Promise<Snapshot>
  rescan(): Promise<RoleStatus[]>
}

export const proposal = z.strictObject({
  id: fileId,
  memoryId: fileId.optional(),
  before: z.string().nullable(),
  text: z.string(),
  expectedHash: hash.nullable(),
  diff: z.string(),
  status: z.enum(['pending', 'confirmed', 'rejected']),
})
const key = z.string().min(1)
export const conversationLocale = z.enum(['zh', 'en'])
export const modelChoice = z.strictObject({ provider: key, model: key, reasoningEffort: key.optional() })
export type ModelChoice = z.infer<typeof modelChoice>
export const indexRecords = {
  role_models: z.strictObject({ roleId: fileId, selection: modelChoice }),
  team_runs: z.strictObject({
    runId: key,
    title: key,
    locale: conversationLocale.optional(),
    rootSessionId: key,
    permissionPreset: key.optional(),
    agentPreset: key.optional(),
    leaderSeatId: key,
    workspaceCwd: key,
    status: z.enum(['creating', 'active', 'archived', 'failed']),
    createdAt: timestamp,
  }),
  team_seats: z.strictObject({
    seatId: key,
    runId: key,
    parentSeatId: key.nullable(),
    roleId: fileId,
    displayName: key,
    currentGeneration: revision,
    currentSessionId: key,
    selection: modelChoice.optional(),
    nativeAgentName: key,
    adoptedRoleRev: revision,
    adoptedMemoryRev: revision,
    approved: z.strictObject({ revision, afterTurn: z.int().nonnegative() }).optional(),
    seenRevision: revision.optional(),
    joining: z.literal(true).optional(),
    reset: z
      .strictObject({ sessionId: key, revision, handoff: z.string(), startedAt: timestamp })
      .optional(),
    pendingRoleRev: revision.nullable(),
    pendingMemoryRev: revision.nullable(),
    status: z.enum(['active', 'resetting', 'archived']),
  }),
  seat_generations: z.strictObject({
    seatId: key,
    generation: revision,
    sessionId: key,
    nativeAgentName: key,
    roleSnapshotHash: hash,
    memoryIds: z.array(fileId),
    handoffNote: z.string().nullable(),
    archivedAt: timestamp.nullable(),
  }),
  training_sessions: z.strictObject({
    trainingId: key,
    locale: conversationLocale.optional(),
    roleId: fileId,
    sessionId: key,
    mode: z.enum(['create', 'coach', 'debrief']),
    sourceRunId: key.nullish(),
    initializing: z.literal(true).optional(),
    replaces: z.array(key).optional(),
    proposals: z.array(proposal).optional(),
  }),
}
export type IndexRecord<T extends keyof typeof indexRecords> = z.infer<(typeof indexRecords)[T]>
