import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actionDateValidationError,
  findDateToken,
  formatCalendarDate,
  isValidIsoDate,
  parseFlexibleDate,
} from './dateParsing.js'

test('parses full-year US dates without shifting digits', () => {
  assert.equal(parseFlexibleDate('target date 8/25/2026', 2026), '2026-08-25')
})

test('accepts valid ISO, named-month, Chinese, and leap-day dates', () => {
  assert.equal(parseFlexibleDate('2026-08-25', 2026), '2026-08-25')
  assert.equal(parseFlexibleDate('August 25, 2026', 2026), '2026-08-25')
  assert.equal(parseFlexibleDate('8月25号', 2026), '2026-08-25')
  assert.equal(parseFlexibleDate('2/29/2024', 2026), '2024-02-29')
})

test('rejects impossible calendar dates instead of rolling them over', () => {
  assert.equal(formatCalendarDate(2026, 2, 30), null)
  assert.equal(parseFlexibleDate('ETA 2/30/2026', 2026), null)
  assert.equal(parseFlexibleDate('2/29/2025', 2026), null)
  assert.equal(parseFlexibleDate('13/1/2026', 2026), null)
  assert.equal(isValidIsoDate('2026-02-30'), false)
})

test('preserves the invalid source token for review UI', () => {
  assert.deepEqual(findDateToken('target date 2/30/2026', 2026), {
    raw: '2/30/2026',
    normalized: null,
    index: 12,
  })
})

test('blocks invalid action dates before Apply while accepting valid ISO dates', () => {
  assert.equal(
    actionDateValidationError({ type: 'update_due_date', dueDate: '', invalidDate: '2/30/2026' }),
    'Invalid date "2/30/2026"',
  )
  assert.equal(
    actionDateValidationError({ type: 'update_parts_order', eta: '2026-13-01' }),
    'Invalid parts ETA "2026-13-01"',
  )
  assert.equal(actionDateValidationError({ type: 'update_due_date', dueDate: '2026-08-25' }), null)
})
