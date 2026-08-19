import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPartsOrderCandidates,
  mergePreferredPartsOrderActions,
  vendorsMatchIgnoringParsingMetadata,
} from './partsOrderParsing.js'

const options = { defaultYear: 2026 }

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

test('does not mistake a legitimate vendor containing Complete for receipt language', () => {
  const text = 'RO9448 ordered 1 part from Complete Auto Parts ETA 5/21'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Complete Auto Parts', qty: 1, eta: '2026-05-21' },
  ])
})

test('rejects impossible calendar dates', () => {
  const text = 'RO9448 ordered 1 part from Keystone ETA 2/30'
  assert.deepEqual(extractPartsOrderCandidates(text, options), [
    { roNumber: '9448', vendor: 'Keystone', qty: 1, eta: null },
  ])
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
