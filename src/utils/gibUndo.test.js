import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Bytes, Timestamp } from 'firebase/firestore'
import {
  GIB_UNDO_PAYLOAD_MAX_BYTES,
  buildGibUndoPatch,
  buildGibUndoPayload,
  durableUndoSupportedForRole,
  gibUndoSurfaceId,
  operationHasDurableUndo,
  parseGibUndoPayload,
  recentAppliedFromOperation,
  undoHeadMatchesOperation,
  undoManifestDocumentMatches,
  undoManifestTargetsMatchOperation,
  undoReceiptMatches,
} from './gibUndo.js'

const manifestBase = {
  operationId: 'gib_12345678901234567890123456789012',
  ownerUid: 'owner-1',
  roRestores: [{
    roId: 'ro-1',
    patch: {
      values: { notes: 'before', partsOrders: [{ orderedAt: new Timestamp(10, 20) }] },
      deleteFields: ['eta'],
    },
    resultRevision: 4,
  }],
  createdTasks: [{
    taskId: 'created-1',
    resultRevision: 0,
    expectedAfterFingerprint: '{"taskRevision":0}',
  }],
  taskRestores: [{
    taskId: 'task-1',
    patch: { values: { status: 'pending' }, deleteFields: ['completedAt'] },
    resultRevision: 8,
    expectedAfterFingerprint: '{"status":"completed","taskRevision":8}',
  }],
}

describe('durable GIB Undo payload', () => {
  it('round-trips patches and Firestore timestamps with a stable hash', async () => {
    const built = await buildGibUndoPayload(manifestBase)
    const parsed = await parseGibUndoPayload({
      payload: built.payload,
      payloadHash: built.payloadHash,
      operationId: manifestBase.operationId,
      ownerUid: manifestBase.ownerUid,
      itemCount: built.itemCount,
    })
    assert.equal(parsed.itemCount, 3)
    assert.deepEqual(parsed.roRestores[0].patch.deleteFields, ['eta'])
    assert.equal(parsed.roRestores[0].patch.values.partsOrders[0].orderedAt.seconds, 10)
    assert.equal(parsed.roRestores[0].patch.values.partsOrders[0].orderedAt.nanoseconds, 20)
  })

  it('rejects tampering, owner mismatches, duplicate patch fields, and oversized payloads', async () => {
    const built = await buildGibUndoPayload(manifestBase)
    const tamperedBytes = new Uint8Array([...built.payload.toUint8Array(), 32])
    await assert.rejects(() => parseGibUndoPayload({
      payload: Bytes.fromUint8Array(tamperedBytes),
      payloadHash: built.payloadHash,
      operationId: manifestBase.operationId,
      ownerUid: manifestBase.ownerUid,
      itemCount: built.itemCount,
    }), /integrity/)
    await assert.rejects(() => parseGibUndoPayload({
      payload: built.payload,
      payloadHash: built.payloadHash,
      operationId: manifestBase.operationId,
      ownerUid: 'other-owner',
      itemCount: built.itemCount,
    }), /does not match/)
    await assert.rejects(() => buildGibUndoPayload({
      ...manifestBase,
      roRestores: [{
        ...manifestBase.roRestores[0],
        patch: { values: { eta: 'old' }, deleteFields: ['eta'] },
      }],
    }), /duplicate field paths/)
    await assert.rejects(() => buildGibUndoPayload({
      ...manifestBase,
      taskRestores: [{
        ...manifestBase.taskRestores[0],
        patch: { values: { roId: 'another-ro' }, deleteFields: [] },
      }],
    }), /cannot restore/)
    await assert.rejects(() => buildGibUndoPayload({
      ...manifestBase,
      roRestores: [{
        ...manifestBase.roRestores[0],
        patch: { values: { notes: 'x'.repeat(GIB_UNDO_PAYLOAD_MAX_BYTES) }, deleteFields: [] },
      }],
    }), /Split the GIB update/)
    await assert.rejects(() => buildGibUndoPayload({
      ...manifestBase,
      roRestores: [],
      taskRestores: [],
      createdTasks: Array.from({ length: 448 }, (_, index) => ({
        taskId: `task-${index}`,
        resultRevision: 0,
        expectedAfterFingerprint: '{}',
      })),
    }), /item count/)
  })

  it('builds inverse patches without serializing delete sentinels', () => {
    assert.deepEqual(
      buildGibUndoPatch({ notes: 'old', nested: { value: 3 } }, ['notes', 'missing', 'nested.value']),
      { values: { 'nested.value': 3, notes: 'old' }, deleteFields: ['missing'] },
    )
  })
})

it('derives stable, distinct Firestore-safe surface head IDs', async () => {
  const board = await gibUndoSurfaceId('ro-board')
  assert.match(board, /^surface_[0-9a-f]{64}$/)
  assert.equal(board, await gibUndoSurfaceId('ro-board'))
  assert.notEqual(board, await gibUndoSurfaceId('parts-manager'))
})

it('recognizes only matching durable roots and exactly-once receipts', () => {
  const operation = {
    kind: 'gib_apply',
    operationId: manifestBase.operationId,
    ownerUid: 'owner-1',
    schemaVersion: 3,
    undoSchemaVersion: 1,
    undoManifestHash: 'a'.repeat(64),
    undoManifestBytes: 100,
    undoItemCount: 3,
    targetRoIds: ['ro-1'],
    createdTaskIds: ['created-1'],
    updatedTaskIds: ['task-1'],
    resultRoRevisions: { 'ro-1': 4 },
    surface: 'ro-board',
    surfaceId: `surface_${'b'.repeat(64)}`,
    summary: 'RO#1 note',
    actionCount: 1,
  }
  assert.equal(operationHasDurableUndo(operation, 'owner-1', 'ro-board'), true)
  assert.equal(operationHasDurableUndo(operation, 'owner-1', 'parts'), false)
  assert.equal(undoReceiptMatches({
    kind: 'gib_undo',
    ownerUid: 'owner-1',
    operationId: manifestBase.operationId,
    manifestHash: 'a'.repeat(64),
    itemCount: 3,
    surfaceId: `surface_${'b'.repeat(64)}`,
    createdTaskIds: ['created-1'],
  }, operation, 'owner-1'), true)
  assert.equal(undoHeadMatchesOperation({
    kind: 'gib_undo_head',
    ownerUid: 'owner-1',
    surface: 'ro-board',
    surfaceId: `surface_${'b'.repeat(64)}`,
    operationId: manifestBase.operationId,
    manifestHash: 'a'.repeat(64),
    itemCount: 3,
  }, operation, 'owner-1', `surface_${'b'.repeat(64)}`), true)
  assert.equal(undoManifestTargetsMatchOperation({ ...manifestBase, itemCount: 3 }, operation), true)
  assert.equal(undoManifestDocumentMatches({
    kind: 'gib_undo_manifest',
    operationId: manifestBase.operationId,
    ownerUid: 'owner-1',
    schemaVersion: 1,
    payloadHash: 'a'.repeat(64),
    payloadBytes: 100,
    itemCount: 3,
    payload: { toUint8Array: () => new Uint8Array(100) },
  }, operation, 'owner-1'), true)
  assert.deepEqual(recentAppliedFromOperation(operation, 'draft-key', 'shop_manager').summary, ['RO#1 note'])
  assert.equal(durableUndoSupportedForRole(operation, 'shop_manager'), true)
  assert.equal(durableUndoSupportedForRole(operation, 'parts_manager'), false)
  assert.equal(durableUndoSupportedForRole({ ...operation, createdTaskIds: [], updatedTaskIds: [] }, 'parts_manager'), true)
  assert.equal(durableUndoSupportedForRole({ ...operation, updatedTaskIds: [] }, 'parts_manager'), false)
})
