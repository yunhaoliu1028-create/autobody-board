import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPartsOrderCandidates,
  mergePreferredPartsOrderActions,
  removeCrossRoPartsOrderLeakage,
  vendorsMatchIgnoringParsingMetadata,
} from './partsOrderParsing.js'
import { actionDateValidationError } from './dateParsing.js'

const options = {
  defaultYear: 2026,
  knownRoNumbers: ['9448', '9725', '1111', '2222'],
}

test('does not turn a received historical order into a new order', () => {
  const text = 'RO9725. The 5 parts ordered from Sepaplus have all been received today.'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [])
})

test('extracts only the new Keystone order from the reported bilingual update', () => {
  const text = [
    '9725，8月17号返回来。今天跟 Sepaplus 订的 5 个部件已经全收齐了。今天跟 Keyston 订了一个部件，大概是 8 月 18 号会到。',
    'RO9725 returned on August 17. The 5 parts ordered from Sepaplus have all been received today. Ordered 1 part from Keystone today, ETA approximately August 18.',
  ].join('\n')

  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9725', vendor: 'Keystone', qty: 1, eta: '2026-08-18' },
  ])
})

test('keeps a new order that follows a receipt in the same sentence', () => {
  const text = 'RO9725 received all 5 from Sepaplus, ordered 1 part from Keystone ETA 8/18.'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9725', vendor: 'Keystone', qty: 1, eta: '2026-08-18' },
  ])
})

test('parses compact multi-vendor orders and shared ETA without contaminating vendor names', () => {
  const text = 'RO9448 parts ordered: 1 from Keystone, 1 from Parts Authority, 1 from Amazon all ETA 5/21, 3 labels ordered from Auto Datalabel ETA 5/22'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: '2026-05-21' },
    { roNumber: '9448', vendor: 'Parts Authority', qty: 1, eta: '2026-05-21' },
    { roNumber: '9448', vendor: 'Amazon', qty: 1, eta: '2026-05-21' },
    { roNumber: '9448', vendor: 'Auto Datalabel', qty: 3, eta: '2026-05-22' },
  ])
})

test('preserves an explicit vendor on a single order with no quantity', () => {
  const text = 'RO9448 ordered parts thru Parts Authority eta 5/21'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Parts Authority', qty: null, eta: '2026-05-21' },
  ])
})

test('does not create an order from a receipt-only update', () => {
  assert.deepEqual(extractPartsOrderCandidates('RO9448 received 5 parts from Keystone today', options), [])
})

test('does not treat a receipt quantity as an order when a new order follows without punctuation', () => {
  const text = 'RO9725 received 5 from Sepaplus and ordered 1 part from Keystone ETA 8/18'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9725', vendor: 'Keystone', qty: 1, eta: '2026-08-18' },
  ])
})

test('does not leak a shared ETA from one RO into another RO', () => {
  const text = 'RO9448 parts ordered: 1 from Keystone all ETA 5/21. RO9725 ordered 1 part from Amazon.'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: '2026-05-21' },
    { roNumber: '9725', vendor: 'Amazon', qty: 1, eta: null },
  ])
})

test('carries a continuation order only from the nearest preceding RO scope', () => {
  const text = 'RO1111 customer called. RO2222 is waiting parts; ordered 2 parts from Amazon ETA 8/25'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '2222', vendor: 'Amazon', qty: 2, eta: '2026-08-25' },
  ])
})

test('keeps comma-separated RO orders isolated', () => {
  const text = 'RO1111 ordered 1 part from Keystone, RO2222 ordered 2 parts from Amazon ETA 8/25'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '1111', vendor: 'Keystone', qty: 1, eta: null },
    { roNumber: '2222', vendor: 'Amazon', qty: 2, eta: '2026-08-25' },
  ])
})

test('applies an explicitly grouped parts order to every named RO', () => {
  const text = 'RO1111 and RO2222 ordered 1 part from Keystone ETA 8/25'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '1111', vendor: 'Keystone', qty: 1, eta: '2026-08-25' },
    { roNumber: '2222', vendor: 'Keystone', qty: 1, eta: '2026-08-25' },
  ])
})

test('drops a model parts action copied onto the wrong RO clause', () => {
  const text = 'RO1111 customer called. RO2222 is waiting parts; ordered 2 parts from Amazon ETA 8/25'
  const explicitOrders = extractPartsOrderCandidates(text, options)
  const actions = [
    { type: 'add_note', roNumber: '1111', note: 'Customer called.' },
    { type: 'update_parts_order', roNumber: '1111', vendor: 'Amazon', qty: 2, eta: '2026-08-25' },
  ]

  assert.deepEqual(
    removeCrossRoPartsOrderLeakage(actions, text, explicitOrders, options),
    [{ type: 'add_note', roNumber: '1111', note: 'Customer called.' }],
  )
})

test('drops a copied vendor even when both RO clauses contain different orders', () => {
  const text = 'RO1111 ordered 1 part from Keystone. RO2222 ordered 2 parts from Amazon ETA 8/25'
  const explicitOrders = extractPartsOrderCandidates(text, options)
  const actions = [
    { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', qty: 1 },
    { type: 'update_parts_order', roNumber: '1111', vendor: 'Amazon', qty: 2 },
    { type: 'update_parts_order', roNumber: '2222', vendor: 'Amazon', qty: 2 },
  ]

  assert.deepEqual(
    removeCrossRoPartsOrderLeakage(actions, text, explicitOrders, options),
    [actions[0], actions[2]],
  )
})

test('keeps a legitimate vendor ETA action when another RO contains an order', () => {
  const text = 'RO1111 Keystone ETA changed to 8/25. RO2222 ordered 1 part from Amazon.'
  const explicitOrders = extractPartsOrderCandidates(text, options)
  const actions = [
    { type: 'update_parts_order', roNumber: '1111', vendor: 'Keystone', eta: '2026-08-25' },
    { type: 'update_parts_order', roNumber: '2222', vendor: 'Amazon', qty: 1 },
  ]

  assert.deepEqual(
    removeCrossRoPartsOrderLeakage(actions, text, explicitOrders, options),
    actions,
  )
})

test('does not mistake a legitimate vendor containing Complete for receipt language', () => {
  const text = 'RO9448 ordered 1 part from Complete Auto Parts ETA 5/21'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Complete Auto Parts', qty: 1, eta: '2026-05-21' },
  ])
})

test('rejects impossible calendar dates', () => {
  const text = 'RO9448 ordered 1 part from Keystone ETA 2/30'
  const candidates = extractPartsOrderCandidates(text, options)
  assert.deepEqual(candidates, [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: null, invalidDate: '2/30' },
  ])
  assert.equal(
    actionDateValidationError({ type: 'update_parts_order', ...candidates[0] }),
    'Invalid date "2/30"',
  )
})

test('keeps an invalid vendor ETA from contaminating another vendor in the same RO scope', () => {
  const text = 'RO9448 parts ordered: 1 from Keystone ETA 2/30, 1 from Amazon ETA 3/2'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: null, invalidDate: '2/30' },
    { roNumber: '9448', vendor: 'Amazon', qty: 1, eta: '2026-03-02' },
  ])
})

test('does not share a valid vendor ETA without explicit all ETA wording', () => {
  const text = 'RO9448 parts ordered: 1 from Keystone ETA 3/2, 1 from Amazon'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: '2026-03-02' },
    { roNumber: '9448', vendor: 'Amazon', qty: 1, eta: null },
  ])
})

test('shares an invalid ETA only when the input explicitly says all ETA', () => {
  const text = 'RO9448 parts ordered: 1 from Keystone, 1 from Amazon all ETA 2/30'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: null, invalidDate: '2/30' },
    { roNumber: '9448', vendor: 'Amazon', qty: 1, eta: null, invalidDate: '2/30' },
  ])
})

test('keeps an invalid source marker when a duplicate translation supplies a rolled valid ETA', () => {
  const text = 'RO9448 ordered 1 part from Keystone ETA 2/30, ordered 1 part from Keystone ETA 3/2'
  const [candidate] = extractPartsOrderCandidates(text, options)
  assert.deepEqual(candidate, {
    roNumber: '9448',
    vendor: 'Keystone',
    qty: 1,
    eta: '2026-03-02',
    invalidDate: '2/30',
  })
  assert.equal(
    actionDateValidationError({ type: 'update_parts_order', ...candidate }),
    'Invalid date "2/30"',
  )
})

test('preserves invalid ETA evidence for Chinese parts-order fallbacks', () => {
  for (const text of [
    'RO9448 从 Keystone 订了一个部件，ETA 2/30',
    'RO9448 从 Keystone 订部件 ETA 2/30',
    'RO9448 从 Keystone 下单 ETA 2/30',
  ]) {
    const [candidate] = extractPartsOrderCandidates(text, options)
    assert.deepEqual(candidate, {
      roNumber: '9448',
      vendor: 'Keystone',
      qty: null,
      eta: null,
      invalidDate: '2/30',
    })
    assert.equal(
      actionDateValidationError({ type: 'update_parts_order', ...candidate }),
      'Invalid date "2/30"',
    )
  }
})

test('keeps Chinese vendor dates local when multiple orders share one RO clause', () => {
  for (const text of [
    'RO9448 从 Keystone 订了一个部件，ETA 2/30，跟 Amazon 订了一个部件，ETA 3/2',
    'RO9448 从 Keystone 订了一个部件，然后跟 Amazon 订了一个部件，ETA 3/2',
    'RO9448 从 Keystone 订了一个部件 跟 Amazon 订了一个部件 ETA 3/2',
  ]) {
    const candidates = extractPartsOrderCandidates(text, options)
    const keystone = candidates.find(candidate => candidate.vendor === 'Keystone')
    const amazon = candidates.find(candidate => candidate.vendor === 'Amazon')
    if (text.includes('ETA 2/30')) {
      assert.deepEqual(keystone, { roNumber: '9448', vendor: 'Keystone', qty: null, eta: null, invalidDate: '2/30' })
    } else {
      assert.deepEqual(keystone, { roNumber: '9448', vendor: 'Keystone', qty: null, eta: null })
    }
    assert.deepEqual(amazon, { roNumber: '9448', vendor: 'Amazon', qty: null, eta: '2026-03-02' })
  }
})

test('matches only parser-added vendor suffixes for defensive reconciliation', () => {
  assert.equal(vendorsMatchIgnoringParsingMetadata('Keystone today', 'Keystone'), true)
  assert.equal(vendorsMatchIgnoringParsingMetadata('Sepaplus have all been received', 'Sepaplus'), true)
  assert.equal(vendorsMatchIgnoringParsingMetadata('Keystone Auto', 'Keystone'), false)
  assert.equal(vendorsMatchIgnoringParsingMetadata('Complete Auto Parts', 'Complete'), false)
})

test('duplicate-order merging keeps fields from the more complete action', () => {
  const noisyFirst = { type: 'update_parts_order', vendor: 'Keystone', qty: 5, qtyReceived: 2, eta: null }
  const supportedLater = { type: 'update_parts_order', vendor: 'Keystone', vendorFull: 'Keystone', qty: 1, qtyReceived: 0, eta: '2026-08-18', description: 'Parts order' }
  assert.deepEqual(mergePreferredPartsOrderActions(noisyFirst, supportedLater), supportedLater)
})
