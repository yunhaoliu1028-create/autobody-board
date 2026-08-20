import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')
const ledgerRule = rules.match(/match \/gibOperations[\s\S]*?allow update, delete: if false;/)?.[0] || ''

describe('GIB operation ledger rules contract', () => {
  it('has an owner-scoped nested path and never permits list access', () => {
    assert.match(ledgerRule, /match \/gibOperations\/\{uid\}\/operations\/\{operationId\}/)
    assert.match(ledgerRule, /allow get: if isAuth\(\) && \(request\.auth\.uid == uid \|\| isManager\(\)\)/)
    assert.match(ledgerRule, /allow list: if false/)
  })

  it('permits only a typed, bounded, create-time record owned by the caller', () => {
    assert.match(ledgerRule, /allow create: if isAuth\(\)/)
    assert.match(ledgerRule, /request\.auth\.uid == uid/)
    assert.match(ledgerRule, /request\.resource\.data\.ownerUid == uid/)
    assert.match(ledgerRule, /planFingerprint\.matches\('\^\[0-9a-f\]\{64\}\$'\)/)
    assert.match(ledgerRule, /request\.resource\.data\.writeCount <= 450/)
    assert.match(ledgerRule, /request\.resource\.data\.schemaVersion == 2/)
    assert.match(ledgerRule, /request\.resource\.data\.baseRoRevisions is map/)
    assert.match(ledgerRule, /request\.resource\.data\.resultRoRevisions is map/)
    assert.match(ledgerRule, /request\.resource\.data\.committedAt == request\.time/)
  })

  it('prevents the update bypass and deletion of consumed IDs', () => {
    assert.match(ledgerRule, /allow update, delete: if false/)
  })

  it('requires every RO update to advance the shared revision by exactly one', () => {
    assert.match(rules, /function hasValidGibRevisionTransition\(\)/)
    assert.match(rules, /before is int && after == before \+ 1/)
    assert.doesNotMatch(rules, /after == before \|\|/)
    assert.match(rules, /allow update: if isAuth\(\) && hasValidGibRevisionTransition\(\)/)
  })
})
