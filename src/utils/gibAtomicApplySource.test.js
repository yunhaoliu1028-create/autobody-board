import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../components/AIInputBox.jsx', import.meta.url), 'utf8')

function sourceBetween(startMarker, endMarker, haystack = source) {
  const start = haystack.indexOf(startMarker)
  const end = haystack.indexOf(endMarker, start)
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`)
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`)
  return haystack.slice(start, end)
}

test('GIB Apply plans every mutation before one guarded transaction commit', () => {
  const applySource = sourceBetween('const handleApply = async () => {', 'const canSubmit =')
  assert.doesNotMatch(applySource, /\b(?:addDoc|deleteDoc|updateDoc)\s*\(/)
  assert.match(applySource, /getDocFromServer\(doc\(db, 'ros', roId\)\)/)
  assert.match(applySource, /snapshots: taskSnapshots/)
  assert.match(applySource, /runTransaction\(db, async transaction =>/)
  assert.match(applySource, /snapshotEqual\(snapshot, reviewedSnapshot\)/)
  assert.match(applySource, /plannedTaskSnapshots\.some\(snapshot => snapshot\.exists\(\)\)/)
  assert.match(applySource, /plannedTaskCreates\.forEach\(item => transaction\.set/)
  assert.match(applySource, /taskUpdates\.forEach\(item => transaction\.update/)
  const actionLoop = applySource.indexOf('for (const action of applyActions)')
  const completionFinalizer = applySource.indexOf('phaseCompletionIntents.forEach')
  const transactionCommit = applySource.indexOf('runTransaction(db, async transaction =>')
  assert.notEqual(actionLoop, -1)
  assert.notEqual(completionFinalizer, -1)
  assert.notEqual(transactionCommit, -1)
  assert.ok(actionLoop < completionFinalizer)
  assert.ok(completionFinalizer < transactionCommit)
  assert.match(applySource, /transaction\.set\(operationRef, ledgerData\)/)
  assert.match(applySource, /gibOperationLimitError\(\{ actions: applyActions, targetRoIds: targetedRoIds, writeCount \}\)/)
  assert.match(applySource, /gibRevision: resultRoRevisions\[roDoc\.id\]/)
  assert.match(source, /const explicitExistingAssigneeChange = clean\.gibExplicitAssigneeChange === true/)
  assert.match(source, /delete clean\.gibExplicitAssigneeChange/)
  assert.match(source, /assigneeChanged \? \{ assigneeUserEdited: true \}/)
  assert.match(source, /actionHasExplicitAssigneeIntent\(action, actionInput, assignee, employees\)/)
  assert.match(source, /painter: explicitPainter \|\| employees\.find/)
  assert.match(applySource, /planTaskUpdate\(existingItem, \{[\s\S]*?assignedTo: clean\.assignedTo/)
  assert.doesNotMatch(source, /hasOpenTaskForTemplate/)
  assert.match(applySource, /if \(priorUnconfirmedAttempt\) \{[\s\S]*?safety record could not be read/)
  assert.match(applySource, /Do not retry or refresh until it finishes/)

  const transactionSource = sourceBetween(
    'runTransaction(db, async transaction => {',
    '}), () => {',
    applySource,
  )
  const lastRead = transactionSource.lastIndexOf('transaction.get(')
  const firstWrite = Math.min(
    ...['transaction.set(', 'transaction.update(', 'transaction.delete(']
      .map(marker => transactionSource.indexOf(marker))
      .filter(index => index >= 0),
  )
  assert.ok(lastRead >= 0 && lastRead < firstWrite)
  assert.doesNotMatch(transactionSource, /\b(?:setState|setError|setActions|setText|toast\.|localStorage\.|newRecordId\()/)
})

test('GIB Undo checks the post-Apply RO revision and advances it atomically', () => {
  const undoSource = sourceBetween('const handleUndoRecent = async () => {', 'if (compact) {')
  assert.doesNotMatch(undoSource, /\b(?:addDoc|deleteDoc|updateDoc)\s*\(/)
  assert.match(undoSource, /runTransaction\(db, async transaction =>/)
  assert.match(undoSource, /normalizeGibRevision\(snapshot\.data\(\)\.gibRevision\) !== restore\.resultRevision/)
  assert.match(undoSource, /gibRevision: item\.resultRevision \+ 1/)
  assert.match(undoSource, /createdTaskSnapshots\.forEach\(snapshot => transaction\.delete/)
  assert.match(undoSource, /taskRestores\.forEach\(item => transaction\.update/)
  assert.match(undoSource, /taskUndoFingerprint\(snapshot\.data\(\)\) !== undoSnapshot\.taskFingerprints/)
  assert.match(undoSource, /taskUndoFingerprint\(snapshot\.data\(\)\) !== taskRestores\[index\]\.expectedAfterFingerprint/)
})

test('direct photo upload merges current server notes and advances the shared revision', () => {
  const uploadSource = sourceBetween('const handleDirectImageUpload = async () => {', 'const handleSubmit = async (e) => {')
  assert.match(uploadSource, /runTransaction\(db, async transaction =>/)
  assert.match(uploadSource, /photoUploadAttemptRef\.current\?\.signature !== attemptSignature/)
  assert.match(uploadSource, /filename = `\$\{uploadAttempt\.id\}_\$\{typeSlug\}_\$\{padded\}\.jpg`/)
  assert.match(uploadSource, /uploadAttemptId: uploadAttempt\.id/)
  assert.match(uploadSource, /storagePath: sRef\.fullPath/)
  assert.match(uploadSource, /const current = await transaction\.get\(roRef\)/)
  assert.match(uploadSource, /const incomingByKey = new Map/)
  assert.match(uploadSource, /const matchedKeys = new Set/)
  assert.match(uploadSource, /return \{ \.\.\.existing, \.\.\.incoming \}/)
  assert.match(uploadSource, /if \(!attachmentChanged\) return/)
  assert.match(uploadSource, /if \(matchedKeys\.size === 0\)/)
  assert.match(uploadSource, /updates\.notes = `\$\{noteEntry\}\\n\$\{currentData\.notes \?\? ''\}`/)
  assert.match(uploadSource, /gibRevision: normalizeGibRevision\(currentData\.gibRevision\) \+ 1/)
  assert.doesNotMatch(uploadSource, /roDoc\.notes/)
})
