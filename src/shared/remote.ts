import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult, TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'
import {
  deleteRequest,
  editRequest,
  editResult,
  fileContents,
  fileId,
  fileRef,
  revision,
  roleStatus,
  snapshotSchema,
  type RoleTeamRpc,
} from './index.js'

type ClientMethods = {
  [K in keyof RoleTeamRpc]: (
    ...args: Parameters<RoleTeamRpc[K]>
  ) => Promise<RemoteResult<Awaited<ReturnType<RoleTeamRpc[K]>>>>
}
declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface TypertRemoteNamespaceMap {
    roleTeam: ClientMethods
  }
}

// Owner methods on the Host and browser mount share the exact same wire names and validators.
function method(
  name: keyof RoleTeamRpc,
  args: Record<string, z.ZodType>,
  result: z.ZodType,
): TypertRemoteMethodSpec {
  const codec = (field: string, schema: z.ZodType) => ({
    typeSymbol: 'dsh-role-team#' + name + '.' + field,
    mode: 'strict' as const,
    create: () => schema,
  })
  return {
    service: 'roleTeam',
    invocation: { kind: 'direct' },
    parameters: Object.entries(args).map(([field, schema]) => {
      const value = codec(field, schema)
      return { name: field, source: 'json', codec: value, strictCodec: value }
    }),
    result: codec('result', result),
  }
}
const roles = z.array(roleStatus)
export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: 'dsh-role-team',
    methods: {
      'roleTeam/listRoles': method('listRoles', {}, roles),
      'roleTeam/rescan': method('rescan', {}, roles),
      'roleTeam/listMemories': method('listMemories', { roleId: fileId }, z.array(fileId)),
      'roleTeam/readDocument': method('readDocument', { ref: fileRef }, fileContents.nullable()),
      'roleTeam/saveDocument': method('saveDocument', { request: editRequest }, editResult),
      'roleTeam/deleteDocument': method('deleteDocument', { request: deleteRequest }, editResult),
      'roleTeam/readSnapshot': method(
        'readSnapshot',
        { roleId: fileId, publishedRevision: revision },
        snapshotSchema,
      ),
    },
  },
  z,
)
export const TYPERT = {
  package: 'dsh-role-team',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  get invocations() {
    return TYPERT_REMOTE.descriptors
  },
}
