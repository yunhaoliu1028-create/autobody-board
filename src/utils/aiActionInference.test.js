import test from 'node:test'
import assert from 'node:assert/strict'
import { inferStructuredActionsFromText } from './aiActionInference.js'

function actionMap(actions, type, field) {
  return new Map(actions
    .filter(action => action.type === type)
    .map(action => [String(action.roNumber), action[field]]))
}

test('keeps full-year target dates exact for each RO', () => {
  const actions = [
    { type: 'add_note', roNumber: '1111', note: 'First update' },
    { type: 'add_note', roNumber: '2222', note: 'Second update' },
  ]
  const inferred = inferStructuredActionsFromText(
    actions,
    'RO1111 target date 8/20/2026; RO2222 target date 8/25/2026',
    ['1111', '2222'],
  )
  const dates = actionMap(inferred, 'update_due_date', 'dueDate')

  assert.equal(dates.get('1111'), '2026-08-20')
  assert.equal(dates.get('2222'), '2026-08-25')
})

test('corrects an existing due-date action from its scoped raw clause', () => {
  const actions = [
    { type: 'update_due_date', roNumber: '1111', dueDate: '2026-08-20' },
    { type: 'update_due_date', roNumber: '2222', dueDate: '2026-08-20' },
  ]
  const inferred = inferStructuredActionsFromText(
    actions,
    'RO1111 target date 8/20/2026; RO2222 target date 8/25/2026',
    ['1111', '2222'],
  )
  const dates = actionMap(inferred, 'update_due_date', 'dueDate')

  assert.equal(dates.get('1111'), '2026-08-20')
  assert.equal(dates.get('2222'), '2026-08-25')
})

test('keeps an impossible explicit target date as a blocked review action', () => {
  const inferred = inferStructuredActionsFromText(
    [{ type: 'add_note', roNumber: '1111', note: 'Target date noted.' }],
    'RO1111 target date 2/30/2026',
    ['1111'],
  )
  const dueAction = inferred.find(action => action.type === 'update_due_date')

  assert.equal(dueAction?.dueDate, '')
  assert.equal(dueAction?.invalidDate, '2/30/2026')
  assert.equal(dueAction?.confidence, 'low')
})

test('blocks malformed model date fields even without raw date evidence', () => {
  const inferred = inferStructuredActionsFromText(
    [
      { type: 'update_due_date', roNumber: '1111', dueDate: '2026-02-30' },
      { type: 'update_dropoff_date', roNumber: '1111', dropOffDate: '2026-13-01' },
      { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', eta: 'not-a-date' },
    ],
    'RO1111 customer called',
    ['1111'],
  )

  assert.deepEqual(
    inferred.map(action => [action.type, action.dueDate ?? action.dropOffDate ?? action.eta, action.invalidDate]),
    [
      ['update_due_date', '', '2026-02-30'],
      ['update_dropoff_date', '', '2026-13-01'],
      ['update_parts_order', '', 'not-a-date'],
    ],
  )
})

test('blocks model rollover dates when raw drop-off or parts ETA is impossible', () => {
  const inferred = inferStructuredActionsFromText(
    [
      { type: 'update_dropoff_date', roNumber: '1111', dropOffDate: '2026-03-02' },
      { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', eta: '2026-03-02' },
    ],
    'RO1111 dropped off 2/30/2026 and ordered 1 part from Keystone ETA 2/30/2026',
    ['1111'],
  )

  assert.deepEqual(
    inferred.map(action => [action.type, action.dropOffDate ?? action.eta, action.invalidDate]),
    [
      ['update_dropoff_date', '', '2/30/2026'],
      ['update_parts_order', '', '2/30/2026'],
    ],
  )
})

test('keeps a vendor ETA from contaminating another vendor action in the same RO', () => {
  const inferred = inferStructuredActionsFromText(
    [
      { type: 'log_parts_received', roNumber: '1111', vendor: 'Keystone', qtyReceived: 1, totalQty: 1 },
      { type: 'update_parts_order', roNumber: '1111', vendor: 'Amazon', qty: 1, eta: '2026-03-02' },
    ],
    'RO1111 received 1/1 from Keystone; ordered 1 part from Amazon ETA 2/30/2026',
    ['1111'],
  )

  const receipt = inferred.find(action => action.type === 'log_parts_received')
  const order = inferred.find(action => action.type === 'update_parts_order')
  assert.equal(receipt?.invalidDate, undefined)
  assert.equal(receipt?.eta, undefined)
  assert.equal(order?.eta, '')
  assert.equal(order?.invalidDate, '2/30/2026')
})

test('keeps a new-order ETA from contaminating a receipt for the same vendor', () => {
  for (const input of [
    'RO1111 received 1/1 from Keystone; ordered 1 part from Keystone ETA 2/30/2026',
    'RO1111 received 1/1 from Keystone and ordered 1 part from Keystone ETA 2/30/2026',
  ]) {
    const inferred = inferStructuredActionsFromText(
      [
        { type: 'log_parts_received', roNumber: '1111', vendor: 'Keystone', qtyReceived: 1, totalQty: 1 },
        { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', qty: 1, eta: '2026-03-02' },
      ],
      input,
      ['1111'],
    )

    const receipt = inferred.find(action => action.type === 'log_parts_received')
    const order = inferred.find(action => action.type === 'update_parts_order')
    assert.equal(receipt?.invalidDate, undefined)
    assert.equal(receipt?.eta, undefined)
    assert.equal(order?.eta, '')
    assert.equal(order?.invalidDate, '2/30/2026')
  }
})

test('keeps compact and-or-slash vendor ETAs attached to the nearest vendor', () => {
  for (const separator of ['and', '/', '&', '+']) {
    const inferred = inferStructuredActionsFromText(
      [
        { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', qty: 1 },
        { type: 'update_parts_order', roNumber: '1111', vendor: 'Amazon', qty: 1, eta: '2026-03-02' },
      ],
      `RO1111 ordered 1 from Keystone ${separator} 1 from Amazon ETA 2/30/2026`,
      ['1111'],
    )

    const keystone = inferred.find(action => action.vendor === 'Keystone')
    const amazon = inferred.find(action => action.vendor === 'Amazon')
    assert.equal(keystone?.invalidDate, undefined)
    assert.equal(keystone?.eta, undefined)
    assert.equal(amazon?.eta, '')
    assert.equal(amazon?.invalidDate, '2/30/2026')
  }
})

test('does not match a short vendor name inside a longer known vendor', () => {
  const inferred = inferStructuredActionsFromText(
    [
      { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', qty: 1 },
      { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone Auto', qty: 1, eta: '2026-03-02' },
    ],
    'RO1111 Keystone Auto ETA 2/30/2026',
    ['1111'],
  )

  const shortVendor = inferred.find(action => action.vendor === 'Keystone')
  const longVendor = inferred.find(action => action.vendor === 'Keystone Auto')
  assert.equal(shortVendor?.invalidDate, undefined)
  assert.equal(shortVendor?.eta, undefined)
  assert.equal(longVendor?.eta, '')
  assert.equal(longVendor?.invalidDate, '2/30/2026')
})

test('still blocks an invalid ETA attached to the same receipt vendor', () => {
  for (const input of [
    'RO1111 received 1/1 from Keystone ETA 2/30/2026',
    'RO1111 received 1/1 from Keystone, ETA 2/30/2026',
  ]) {
    const [receipt] = inferStructuredActionsFromText(
      [{ type: 'log_parts_received', roNumber: '1111', vendor: 'Keystone', qtyReceived: 1, totalQty: 1 }],
      input,
      ['1111'],
    )

    assert.equal(receipt?.eta, '')
    assert.equal(receipt?.invalidDate, '2/30/2026')
  }
})

test('blocks impossible Chinese target, drop-off, and vendor ETA dates', () => {
  const inferred = inferStructuredActionsFromText(
    [
      { type: 'update_due_date', roNumber: '1111', dueDate: '2026-03-02' },
      { type: 'update_dropoff_date', roNumber: '2222', dropOffDate: '2026-03-02' },
      { type: 'update_parts_order', roNumber: '3333', vendor: 'Keystone', eta: '2026-03-02' },
    ],
    'RO1111 2月30号交车；RO2222 2月30号进店；RO3333 跟 Keystone 订了一个部件，大概 2月30号会到',
    ['1111', '2222', '3333'],
  )

  assert.deepEqual(
    inferred.map(action => [action.type, action.dueDate ?? action.dropOffDate ?? action.eta, action.invalidDate]),
    [
      ['update_due_date', '', '2月30号'],
      ['update_dropoff_date', '', '2月30号'],
      ['update_parts_order', '', '2月30号'],
    ],
  )
})

test('does not borrow a parts ETA for a target date in another clause', () => {
  const inferred = inferStructuredActionsFromText(
    [{ type: 'add_note', roNumber: '1111', note: 'Target date remains TBD.' }],
    'RO1111 target date TBD. Keystone parts ETA 8/25/2026',
    ['1111'],
  )

  assert.equal(inferred.some(action => action.type === 'update_due_date'), false)
})

test('does not borrow a comma-separated vendor ETA for a target date', () => {
  const inferred = inferStructuredActionsFromText(
    [{ type: 'add_note', roNumber: '1111', note: 'Target date remains TBD.' }],
    'RO1111 target date TBD, Keystone ETA 8/25/2026',
    ['1111'],
  )

  assert.equal(inferred.some(action => action.type === 'update_due_date'), false)
})

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
