import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GIB_DRAFT_SCHEMA_VERSION,
  isGibDraftPayloadForOwner,
  isGibDraftLifecycleCurrent,
  isGibDraftMutationLocked,
  isGibPlanStale,
  resultMetadataWithoutActions,
  recoverGibAttemptAfterReload,
  shouldAcceptGibParseResponse,
} from './gibDraftState.js'

describe('GIB draft lifecycle guards', () => {
  it('keeps executable actions out of display-only result metadata', () => {
    assert.deepEqual(
      resultMetadataWithoutActions({ translation: 'hello', actions: [{ type: 'add_note' }] }),
      { translation: 'hello' },
    )
  })

  it('rejects an old parse response after input or manual actions change', () => {
    const current = {
      requestRevision: 2,
      currentRequestRevision: 2,
      requestActionRevision: 4,
      currentActionRevision: 4,
      requestText: 'RO1 target 8/20',
      currentText: 'RO1 target 8/20',
    }
    assert.equal(shouldAcceptGibParseResponse(current), true)
    assert.equal(shouldAcceptGibParseResponse({ ...current, currentRequestRevision: 3 }), false)
    assert.equal(shouldAcceptGibParseResponse({ ...current, currentActionRevision: 5 }), false)
    assert.equal(shouldAcceptGibParseResponse({ ...current, currentText: 'RO1 target 8/21' }), false)
  })

  it('blocks Apply whenever reviewed actions no longer match the input', () => {
    assert.equal(isGibPlanStale([{ type: 'add_note' }], 'new input', 'old input'), true)
    assert.equal(isGibPlanStale([{ type: 'add_note' }], ' same ', 'same'), false)
    assert.equal(isGibPlanStale([], 'new input', 'old input'), false)
  })

  it('hydrates only the current owner and schema', () => {
    const payload = { schemaVersion: GIB_DRAFT_SCHEMA_VERSION, ownerUid: 'user-1' }
    assert.equal(isGibDraftPayloadForOwner(payload, 'user-1'), true)
    assert.equal(isGibDraftPayloadForOwner(payload, 'user-2'), false)
    assert.equal(isGibDraftPayloadForOwner({ ...payload, schemaVersion: 1 }, 'user-1'), false)
  })

  it('locks every draft mutation while planning, committing, or unconfirmed', () => {
    assert.equal(isGibDraftMutationLocked({ status: 'planning' }), true)
    assert.equal(isGibDraftMutationLocked({ status: 'committing' }), true)
    assert.equal(isGibDraftMutationLocked({ status: 'unknown' }), true)
    assert.equal(isGibDraftMutationLocked({ status: 'failed' }), false)
  })

  it('turns an interrupted in-flight attempt into a verifiable unknown attempt', () => {
    assert.deepEqual(recoverGibAttemptAfterReload({ status: 'planning', operationId: 'op-1' }), { status: 'unknown', operationId: 'op-1' })
    assert.deepEqual(recoverGibAttemptAfterReload({ status: 'committing', operationId: 'op-1' }), { status: 'unknown', operationId: 'op-1' })
    assert.deepEqual(recoverGibAttemptAfterReload({ status: 'failed', operationId: 'op-1' }), { status: 'failed', operationId: 'op-1' })
  })

  it('rejects late async callbacks after owner, scope, or generation changes', () => {
    const expected = { ownerUid: 'user-1', draftStorageKey: 'draft:user-1:ro-board', generation: 4 }
    assert.equal(isGibDraftLifecycleCurrent({ ...expected }, expected), true)
    assert.equal(isGibDraftLifecycleCurrent({ ...expected, ownerUid: 'user-2' }, expected), false)
    assert.equal(isGibDraftLifecycleCurrent({ ...expected, draftStorageKey: 'draft:user-1:parts' }, expected), false)
    assert.equal(isGibDraftLifecycleCurrent({ ...expected, generation: 5 }, expected), false)
    assert.equal(isGibDraftLifecycleCurrent(expected, { ...expected, ownerUid: '' }), false)
  })
})
