import test from 'node:test'
import assert from 'node:assert/strict'
import { inferStructuredActionsFromText } from './aiActionInference.js'

function actionMap(actions, type, field) {
  return new Map(actions
    .filter(action => action.type === type)
    .map(action => [String(action.roNumber), action[field]]))
}

test('does not leak rental status across ROs', () => {
  const actions = [
    { type: 'add_note', roNumber: '1111', note: 'First RO update' },
    { type: 'add_note', roNumber: '2222', note: 'Second RO update' },
  ]
  const input = 'RO1111 no rental, target date 8/20/2026; RO2222 has rental, target date 8/25/2026'

  const inferred = inferStructuredActionsFromText(actions, input, ['1111', '2222'])
  const rentals = actionMap(inferred, 'update_rental', 'hasRental')

  assert.equal(rentals.get('1111'), false)
  assert.equal(rentals.get('2222'), true)
})

test('applies an explicit group-scoped rental fact to both ROs', () => {
  const actions = [
    { type: 'add_note', roNumber: '1111', note: 'First RO update' },
    { type: 'add_note', roNumber: '2222', note: 'Second RO update' },
  ]

  const inferred = inferStructuredActionsFromText(
    actions,
    'RO1111 and RO2222 both have no rental',
    ['1111', '2222'],
  )
  const rentals = actionMap(inferred, 'update_rental', 'hasRental')

  assert.equal(rentals.get('1111'), false)
  assert.equal(rentals.get('2222'), false)
})

test('prefers each RO raw clause over a contaminated generated note', () => {
  const actions = [
    { type: 'add_note', roNumber: '1111', note: 'Customer has no rental.' },
    { type: 'add_note', roNumber: '2222', note: 'Customer has no rental.' },
  ]
  const input = 'RO1111 no rental; RO2222 has rental'

  const inferred = inferStructuredActionsFromText(actions, input, ['1111', '2222'])
  const rentals = actionMap(inferred, 'update_rental', 'hasRental')

  assert.equal(rentals.get('1111'), false)
  assert.equal(rentals.get('2222'), true)
})

test('corrects an existing rental action that conflicts with its RO clause', () => {
  const actions = [
    { type: 'update_rental', roNumber: '1111', hasRental: false },
    { type: 'update_rental', roNumber: '2222', hasRental: false },
  ]

  const inferred = inferStructuredActionsFromText(
    actions,
    'RO1111 no rental; RO2222 has rental',
    ['1111', '2222'],
  )
  const rentals = actionMap(inferred, 'update_rental', 'hasRental')

  assert.equal(rentals.get('1111'), false)
  assert.equal(rentals.get('2222'), true)
})

test('fills every explicitly grouped RO even when the model omitted one member', () => {
  const inferred = inferStructuredActionsFromText(
    [{ type: 'add_note', roNumber: '1111', note: 'No rental.' }],
    'RO1111 and RO2222 both have no rental',
    ['1111', '2222'],
  )
  const rentals = actionMap(inferred, 'update_rental', 'hasRental')

  assert.equal(rentals.get('1111'), false)
  assert.equal(rentals.get('2222'), false)
})
