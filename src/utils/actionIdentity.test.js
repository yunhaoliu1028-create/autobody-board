import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actionTargetsRo,
  normalizeActionRoNumber,
  reconcileEditedActionIdentity,
  resolveRoForAction,
} from './actionIdentity.js'

const ros = [
  { id: 'ro-a', roNumber: '1111' },
  { id: 'ro-b', roNumber: '2222' },
]

test('normalizes common RO number prefixes', () => {
  assert.equal(normalizeActionRoNumber(' RO # 2222 '), '2222')
  assert.equal(normalizeActionRoNumber('#1111'), '1111')
})

test('changing the visible RO number clears a stale roId', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'add_note', roNumber: 'RO#2222', roId: 'ro-a', note: 'Moved action' },
      { type: 'add_note', roNumber: '1111', roId: 'ro-a', note: 'Moved action' },
    ),
    { type: 'add_note', roNumber: '2222', note: 'Moved action' },
  )
})

test('keeping the same visible RO preserves its matching roId', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'add_note', roNumber: 'RO 1111', roId: 'ro-a' },
      { type: 'add_note', roNumber: '1111', roId: 'ro-a' },
    ),
    { type: 'add_note', roNumber: '1111', roId: 'ro-a' },
  )
})

test('changing the visible assignee clears a stale assigneeUid', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'assign_task', assigneeName: ' New Tech ', assigneeUid: 'old-uid' },
      { type: 'assign_task', assigneeName: 'Old Tech', assigneeUid: 'old-uid' },
    ),
    { type: 'assign_task', assigneeName: 'New Tech' },
  )
})

test('explicit roNumber wins over a conflicting roId everywhere', () => {
  const action = { roNumber: '2222', roId: 'ro-a' }
  assert.equal(resolveRoForAction(ros, action)?.id, 'ro-b')
  assert.equal(actionTargetsRo(action, ros[0]), false)
  assert.equal(actionTargetsRo(action, ros[1]), true)
})

test('an unknown explicit roNumber never falls back to a stale roId', () => {
  assert.equal(resolveRoForAction(ros, { roNumber: '9999', roId: 'ro-a' }), null)
  assert.equal(resolveRoForAction(ros, { roId: 'ro-a' })?.roNumber, '1111')
})

test('a blank explicit roNumber never falls back to a stale roId', () => {
  const action = { roNumber: '   ', roId: 'ro-a' }
  assert.equal(resolveRoForAction(ros, action), null)
  assert.equal(actionTargetsRo(action, ros[0]), false)
})

test('saving a blank visible RO clears its hidden roId', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'add_note', roNumber: '', roId: 'ro-a' },
      { type: 'add_note', roNumber: '', roId: 'ro-a' },
    ),
    { type: 'add_note', roNumber: '' },
  )
})

test('saving a blank visible assignee clears its hidden assigneeUid', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'assign_task', assigneeName: '   ', assigneeUid: 'old-uid' },
      { type: 'assign_task', assigneeName: '', assigneeUid: 'old-uid' },
    ),
    { type: 'assign_task', assigneeName: '' },
  )
})

test('legacy ID-only actions keep their compatibility fallback', () => {
  assert.deepEqual(
    reconcileEditedActionIdentity(
      { type: 'assign_task', roId: 'ro-a', assigneeUid: 'tech-a' },
      { type: 'assign_task', roId: 'ro-a', assigneeUid: 'tech-a' },
    ),
    { type: 'assign_task', roId: 'ro-a', assigneeUid: 'tech-a' },
  )
})
