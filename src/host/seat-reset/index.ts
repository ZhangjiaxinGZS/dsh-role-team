import { randomUUID } from 'node:crypto'
import type { Input } from '../../shared/runtime.js'
import { generationKey } from '../storage/index.js'
import type { TeamRuntime } from '../team-runtime/index.js'

/** The seat row is the write-ahead intent. Retries reuse its reserved identity and snapshot. */
export async function replaceSeat(
  runtime: TeamRuntime,
  { seatId, generation, handoff }: Input<'resetSeat'>,
) {
  const { index, native } = runtime
  let seat = runtime.seat(seatId)
  const run = runtime.active(seat.runId)
  if (!seat.parentSeatId) throw new Error('Only child seats can be replaced')
  if (seat.currentGeneration !== generation || seat.status === 'archived')
    throw new Error('Stale generation')
  if (index.seats.list().some((s) => s.parentSeatId === seatId && s.status !== 'archived'))
    throw new Error('Replace or archive active descendants first')
  const parent = runtime.seat(seat.parentSeatId)
  if (!seat.reset) {
    const snap = await runtime.latest(seat.roleId)
    const intent = {
      sessionId: 'rt-child-' + randomUUID(),
      revision: snap.publishedRevision,
      handoff,
      startedAt: new Date().toISOString(),
    }
    seat = await index.seats.update(seatId, (s) => {
      if (s.status !== 'active' || s.currentGeneration !== generation)
        throw new Error('Generation changed')
      return { ...s, status: 'resetting', reset: intent }
    })
  }
  const intent = seat.reset!
  if (intent.handoff !== handoff) throw new Error('Retry the pending reset with its original handoff')
  await native.archive(seat.currentSessionId)
  await index.generations.update(generationKey(seatId, generation), (g) => ({
    ...g,
    archivedAt: g.archivedAt ?? intent.startedAt,
  }))
  const next = generation + 1
  const name = 's-' + seatId.slice(0, 12) + '-' + next
  const snap = await runtime.snapshot(seat.roleId, intent.revision)
  await index.generations.put({
    seatId,
    generation: next,
    sessionId: intent.sessionId,
    nativeAgentName: name,
    roleSnapshotHash: snap.sourceHash,
    memoryIds: snap.memories.map((m) => m.meta.id),
    handoffNote: intent.handoff,
    archivedAt: null,
  })
  await native.spawn(
    run.rootSessionId,
    parent.currentSessionId,
    intent.sessionId,
    name,
    seat.displayName,
  )
  await native.transfer(run.rootSessionId, seat.currentSessionId, intent.sessionId)
  return index.seats.update(seatId, (row) => {
    if (row.reset?.sessionId !== intent.sessionId) throw new Error('Reset identity changed')
    const { reset, approved, ...rest } = row
    return {
      ...rest,
      status: 'active',
      currentGeneration: next,
      currentSessionId: intent.sessionId,
      nativeAgentName: name,
      adoptedRoleRev: intent.revision,
      adoptedMemoryRev: intent.revision,
      pendingRoleRev: (row.pendingRoleRev ?? 0) > intent.revision ? row.pendingRoleRev : null,
      pendingMemoryRev: (row.pendingMemoryRev ?? 0) > intent.revision ? row.pendingMemoryRev : null,
    }
  })
}
