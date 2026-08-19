import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../components/AIInputBox.jsx', import.meta.url), 'utf8')

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`)
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`)
  return source.slice(start, end)
}

test('GIB Apply plans every mutation before one atomic batch commit', () => {
  const applySource = sourceBetween('const handleApply = async () => {', 'const canSubmit =')
  assert.doesNotMatch(applySource, /\b(?:addDoc|deleteDoc|updateDoc)\s*\(/)
  assert.match(applySource, /const taskCatalog = await loadTaskCatalog/)
  assert.match(applySource, /const batch = writeBatch\(db\)/)
  assert.match(applySource, /plannedTaskCreates\.forEach\(item => batch\.set/)
  assert.match(applySource, /taskUpdates\.forEach\(item => batch\.update/)
  assert.equal((applySource.match(/batch\.commit\(\)/g) || []).length, 1)
  const actionLoop = applySource.indexOf('for (const action of actions)')
  const completionFinalizer = applySource.indexOf('phaseCompletionIntents.forEach')
  const batchCreation = applySource.indexOf('const batch = writeBatch(db)')
  assert.ok(actionLoop < completionFinalizer)
  assert.ok(completionFinalizer < batchCreation)
  assert.match(applySource, /await awaitAtomicCommit\(batch\.commit\(\)/)
  assert.match(applySource, /Do not retry or refresh until it finishes/)
})

test('GIB Undo restores RO and task state in one atomic batch', () => {
  const undoSource = sourceBetween('const handleUndoRecent = async () => {', 'if (compact) {')
  assert.doesNotMatch(undoSource, /\b(?:addDoc|deleteDoc|updateDoc)\s*\(/)
  assert.match(undoSource, /const batch = writeBatch\(db\)/)
  assert.match(undoSource, /batch\.delete\(ref\)/)
  assert.match(undoSource, /taskRestores\.forEach\(item => batch\.update/)
  assert.equal((undoSource.match(/batch\.commit\(\)/g) || []).length, 1)
})
