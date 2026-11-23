import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import { expect, it } from 'vitest'
import { generationKey, repository, teamDomain } from '../src/host/storage/index.js'

it('validates native table updates and restores a pinned seat after reopening', async () => {
  const root = await mkdtemp(join(process.cwd(), 'node_modules', '.role-index-test-'))
  const ctx = new Context()
  const now = new Date().toISOString()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(Json, { root })
    await ctx.plugin(Domains, { backend: 'json' })
    const domain = await ctx.storageDomain.open(teamDomain)
    const repo = repository(domain)
    await repo.runs.put({
      runId: 'A',
      title: '甲',
      rootSessionId: 'r',
      leaderSeatId: 'lead',
      workspaceCwd: '/project',
      status: 'active',
      createdAt: now,
    })
    await repo.seats.put({
      seatId: 's',
      runId: 'A',
      parentSeatId: 'lead',
      roleId: 'review',
      displayName: 'Review',
      currentGeneration: 1,
      currentSessionId: 'c',
      nativeAgentName: 'review',
      adoptedRoleRev: 1,
      adoptedMemoryRev: 1,
      pendingRoleRev: null,
      pendingMemoryRev: null,
      status: 'active',
    })
    await repo.generations.put({
      seatId: 's',
      generation: 1,
      sessionId: 'c',
      nativeAgentName: 'review',
      roleSnapshotHash: 'a'.repeat(64),
      memoryIds: ['check'],
      handoffNote: null,
      archivedAt: null,
    })
    await repo.training.put({
      trainingId: 't',
      roleId: 'review',
      sessionId: 'training',
      mode: 'coach',
      sourceRunId: 'A',
    })
    expect(repo.generations.get(generationKey('s', 1))?.sessionId).toBe('c')
    expect(repo.runs.get('A')?.title).toBe('甲')
    expect(repo.training.list()).toHaveLength(1)
    await expect(repo.seats.update('s', (row) => ({ ...row, seatId: 'another' }))).rejects.toThrow()
    await repo.seats.update('s', (row) => ({ ...row, pendingMemoryRev: 2 }))
    await domain.close()
    const reopened = await ctx.storageDomain.open(teamDomain)
    const restored = repository(reopened)
    expect(restored.seats.get('s')).toMatchObject({
      parentSeatId: 'lead',
      adoptedMemoryRev: 1,
      pendingMemoryRev: 2,
    })
    await reopened.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
