import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildGibOperationIdentity,
  gibOperationLimitError,
  gibTaskDocumentId,
  operationLedgerMatches,
  stableGibJson,
} from './gibOperation.js'

const base = {
  draftNonce: 'draft-fixed-00000000000000000000',
  actorUid: 'user-1',
  sourceRole: 'production_manager',
  submittedInput: 'RO9725 target 8/20 no rental',
  actions: [
    { type: 'update_target_date', roNumber: '9725', dueDate: '2026-08-20', confidence: 'high' },
    { type: 'update_rental_status', roNumber: '9725', rentalStatus: 'no' },
  ],
  baseRoRevisions: { 'ro-9725': 3 },
}

describe('GIB operation identity', () => {
  it('is stable for the same reviewed plan and ignores object key order', async () => {
    const first = await buildGibOperationIdentity(base)
    const second = await buildGibOperationIdentity({
      ...base,
      actions: [
        { confidence: 'low', dueDate: '2026-08-20', roNumber: '9725', type: 'update_target_date' },
        { rentalStatus: 'no', type: 'update_rental_status', roNumber: '9725' },
      ],
    })
    assert.deepEqual(second, first)
  })

  it('changes for a new explicit draft even when the text and actions match', async () => {
    const first = await buildGibOperationIdentity(base)
    const second = await buildGibOperationIdentity({ ...base, draftNonce: 'draft-new-0000000000000000000000' })
    assert.notEqual(second.operationId, first.operationId)
    assert.equal(second.planFingerprint, first.planFingerprint)
  })

  for (const [label, change] of [
    ['action order', { actions: [...base.actions].reverse() }],
    ['RO number', { actions: [{ ...base.actions[0], roNumber: '9726' }, base.actions[1]] }],
    ['date', { actions: [{ ...base.actions[0], dueDate: '2026-08-21' }, base.actions[1]] }],
    ['assignee', { actions: [...base.actions, { type: 'assign_task', assigneeName: 'Alex', title: 'QC' }] }],
    ['quantity', { actions: [...base.actions, { type: 'update_parts_order', vendor: 'Keystone', qty: 2 }] }],
    ['submitted input', { submittedInput: `${base.submittedInput} customer called` }],
    ['reviewed RO revision', { baseRoRevisions: { 'ro-9725': 4 } }],
  ]) {
    it(`keeps the draft sentinel but changes the fingerprint when ${label} changes`, async () => {
      const first = await buildGibOperationIdentity(base)
      const second = await buildGibOperationIdentity({ ...base, ...change })
      assert.notEqual(second.planFingerprint, first.planFingerprint)
      assert.equal(second.operationId, first.operationId)
    })
  }

  it('creates stable, distinct deterministic task IDs', () => {
    assert.equal(gibTaskDocumentId('gib_abc', 0), 'gib_abc_t000')
    assert.equal(gibTaskDocumentId('gib_abc', 12), 'gib_abc_t012')
    assert.notEqual(gibTaskDocumentId('gib_abc', 0), gibTaskDocumentId('gib_abc', 1))
  })

  it('matches only the same owner, operation ID, fingerprint, and schema', async () => {
    const identity = await buildGibOperationIdentity(base)
    const ledger = { ...identity, ownerUid: base.actorUid }
    assert.equal(operationLedgerMatches(ledger, identity, base.actorUid), true)
    assert.equal(operationLedgerMatches({ ...ledger, ownerUid: 'other' }, identity, base.actorUid), false)
    assert.equal(operationLedgerMatches({ ...ledger, planFingerprint: '0'.repeat(64) }, identity, base.actorUid), false)
  })

  it('canonicalizes nested object keys while preserving array order', () => {
    assert.equal(stableGibJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}')
    assert.notEqual(stableGibJson({ a: [1, 2] }), stableGibJson({ a: [2, 1] }))
  })

  it('mirrors the ledger rules limits before commit', () => {
    assert.equal(gibOperationLimitError({ actions: Array(449), targetRoIds: Array(100).fill('ro'), writeCount: 450 }), '')
    assert.match(gibOperationLimitError({ actions: Array(450), writeCount: 1 }), /450 actions/)
    assert.match(gibOperationLimitError({ actions: [1], targetRoIds: Array.from({ length: 101 }, (_, index) => `ro-${index}`), writeCount: 102 }), /101 ROs/)
    assert.match(gibOperationLimitError({ actions: [1], targetRoIds: ['ro-1'], writeCount: 451 }), /451 database writes/)
  })
})
