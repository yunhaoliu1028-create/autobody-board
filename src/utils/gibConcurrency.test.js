import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  captureBaseRoRevisions,
  gibStalePlanError,
  isGibStalePlanError,
  normalizeGibRevision,
  reviewedRoRevisionsAreComplete,
  taskUndoFingerprint,
} from './gibConcurrency.js'

const ros = [
  { id: 'ro-a', roNumber: '1111', gibRevision: 4 },
  { id: 'ro-b', roNumber: '2222' },
]

describe('GIB reviewed revision guards', () => {
  it('treats missing or invalid legacy revisions as zero', () => {
    assert.equal(normalizeGibRevision(undefined), 0)
    assert.equal(normalizeGibRevision(-1), 0)
    assert.equal(normalizeGibRevision(3), 3)
  })

  it('freezes only targeted ROs and preserves an existing reviewed base', () => {
    const actions = [{ type: 'add_note', roNumber: '1111' }]
    assert.deepEqual(captureBaseRoRevisions(actions, ros), { 'ro-a': 4 })
    assert.deepEqual(
      captureBaseRoRevisions(actions, [{ ...ros[0], gibRevision: 5 }, ros[1]], { 'ro-a': 4 }),
      { 'ro-a': 4 },
    )
  })

  it('adds a newly edited target at its current revision and drops removed targets', () => {
    assert.deepEqual(
      captureBaseRoRevisions([{ type: 'add_note', roNumber: '2222' }], ros, { 'ro-a': 4 }),
      { 'ro-b': 0 },
    )
  })

  it('requires a non-negative frozen base for every resolved RO target', () => {
    const actions = [
      { type: 'add_note', roNumber: '1111' },
      { type: 'add_note', roNumber: '2222' },
      { type: 'assign_task', title: 'Standalone', assigneeName: 'Alex' },
    ]
    assert.equal(reviewedRoRevisionsAreComplete(actions, ros, { 'ro-a': 4, 'ro-b': 0 }), true)
    assert.equal(reviewedRoRevisionsAreComplete(actions, ros, { 'ro-a': 4 }), false)
  })

  it('uses a typed error for zero-write stale-plan handling', () => {
    const error = gibStalePlanError()
    assert.equal(isGibStalePlanError(error), true)
    assert.equal(isGibStalePlanError(new Error('network')), false)
  })

  it('detects meaningful task edits while ignoring server timestamp fields', () => {
    const expected = {
      title: 'Repair',
      status: 'pending',
      assignedTo: 'alex',
      taskNotes: [],
      createdAt: { serverTimestamp: true },
    }
    assert.equal(
      taskUndoFingerprint({ ...expected, createdAt: { seconds: 123 }, updatedAt: { seconds: 124 } }),
      taskUndoFingerprint(expected),
    )
    assert.notEqual(taskUndoFingerprint({ ...expected, status: 'in_progress' }), taskUndoFingerprint(expected))
    assert.notEqual(taskUndoFingerprint({ ...expected, assignedTo: 'bob' }), taskUndoFingerprint(expected))
    assert.notEqual(taskUndoFingerprint({ ...expected, taskNotes: [{ text: 'started' }] }), taskUndoFingerprint(expected))
  })
})
