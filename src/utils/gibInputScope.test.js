import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoInputScopes, getRoScopedText } from './gibInputScope.js'

test('keeps separate RO clauses isolated', () => {
  const input = 'RO1111 no rental, target date 8/20/2026; RO2222 has rental, target date 8/25/2026'
  const scopes = buildRoInputScopes(input, ['1111', '2222'])

  assert.match(scopes.get('1111'), /no rental/i)
  assert.doesNotMatch(scopes.get('1111'), /has rental|8\/25/i)
  assert.match(scopes.get('2222'), /has rental|8\/25/i)
  assert.doesNotMatch(scopes.get('2222'), /no rental|8\/20/i)
})

test('shares an explicitly grouped clause with every named RO', () => {
  const input = 'RO1111 and RO2222 both have no rental'
  const scopes = buildRoInputScopes(input, ['1111', '2222'])

  assert.equal(scopes.get('1111'), scopes.get('2222'))
  assert.match(scopes.get('1111'), /both have no rental/i)
})

test('does not treat comma-separated RO updates as a group when the first RO has facts', () => {
  const input = 'RO1111 ordered 1 Keystone, RO2222 ordered 2 Amazon ETA 8/25/2026'
  const scopes = buildRoInputScopes(input, ['1111', '2222'])

  assert.match(scopes.get('1111'), /Keystone/i)
  assert.doesNotMatch(scopes.get('1111'), /Amazon|8\/25/i)
  assert.match(scopes.get('2222'), /Amazon|8\/25/i)
  assert.doesNotMatch(scopes.get('2222'), /Keystone/i)
})

test('supports bare RO numbers and Chinese continuation text', () => {
  const input = '9725 8月17号回来，没有租车。9800 今天订了一个 Keystone，8月25号到。'
  const scopes = buildRoInputScopes(input, ['9725', '9800'])

  assert.match(scopes.get('9725'), /没有租车/)
  assert.doesNotMatch(scopes.get('9725'), /Keystone|8月25/)
  assert.match(scopes.get('9800'), /Keystone|8月25/)
  assert.doesNotMatch(scopes.get('9800'), /没有租车/)
})

test('joins repeated clauses for the same RO without importing the other RO', () => {
  const input = 'RO1111 no rental. RO2222 target date 8/25/2026. RO1111 customer called.'
  const scopes = buildRoInputScopes(input, ['1111', '2222'])

  assert.match(scopes.get('1111'), /no rental/i)
  assert.match(scopes.get('1111'), /customer called/i)
  assert.doesNotMatch(scopes.get('1111'), /8\/25/i)
})

test('isolates paint-ready and authorization phrases from unrelated ROs', () => {
  const input = 'RO1111 ready for paint and customer authorized; RO2222 customer called and is waiting parts'
  const scopes = buildRoInputScopes(input, ['1111', '2222'])

  assert.match(scopes.get('1111'), /ready for paint|authorized/i)
  assert.doesNotMatch(scopes.get('2222'), /ready for paint|authorized/i)
})

test('uses the full input only when exactly one action RO exists and no RO is explicit', () => {
  const input = 'customer has no rental and target date is 8/20/2026'

  assert.equal(getRoScopedText(input, '1111', ['1111', '2222'], ['1111']), input)
  assert.equal(getRoScopedText(input, '1111', ['1111', '2222'], ['1111', '2222']), '')
})
