import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) return sourceFiles(url)
    return /\.(?:js|jsx)$/.test(entry.name) && !entry.name.endsWith('.test.js') ? [url] : []
  }))
  return nested.flat()
}

test('all current web task writers use the shared revision protocol', async () => {
  const files = await sourceFiles(new URL('../', import.meta.url))
  for (const file of files) {
    if (file.pathname.endsWith('/taskMutations.js')) continue
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /addDoc\s*\(\s*collection\(db,\s*['"]tasks['"]/, file.pathname)
    assert.doesNotMatch(source, /updateDoc\s*\(\s*doc\(db,\s*['"]tasks['"]/, file.pathname)
    assert.doesNotMatch(source, /deleteDoc\s*\(\s*doc\(db,\s*['"]tasks['"]/, file.pathname)
    assert.doesNotMatch(source, /setDoc\s*\(\s*taskRef\s*,/, file.pathname)
    assert.doesNotMatch(source, /batch\.update\(doc\(db,\s*['"]tasks['"],[^\n]+,\s*\{/, file.pathname)
  }
})

test('GIB task creates, updates, and existing-task Undo advance task revisions', async () => {
  const source = await readFile(new URL('../components/AIInputBox.jsx', import.meta.url), 'utf8')
  assert.match(source, /taskRevision: 0,\s+gibOperationId:/)
  assert.match(source, /taskRevision: planned\.resultRevision/)
  assert.match(source, /taskRevision: item\.resultRevision \+ 1/)
  assert.match(source, /transaction\.set\(receiptRef, receiptData\)/)
  assert.match(source, /recentAppliedForOwner\.undoSupported === false/)
})

test('Firestore rules reject non-participating task writes and require atomic delete receipts', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8')
  assert.match(rules, /function hasValidTaskRevisionTransition\(\)/)
  assert.match(rules, /allow create: if isAuth\(\)\s+&& request\.resource\.data\.taskRevision == 0;/)
  assert.match(rules, /allow update: if isAuth\(\) && hasValidTaskRevisionTransition\(\)/)
  assert.match(rules, /hasCurrentGibUndoReceipt\(taskId\)\s+\|\| \(isManager\(\) && hasCurrentTaskDeleteReceipt\(taskId\)\)/)
  assert.match(rules, /match \/taskDeletionReceipts\/\{taskId\}/)
  assert.match(rules, /allow create, update: if isAuth\(\)/)
  assert.match(rules, /expectedTaskRevision\s+== resource\.data\.get\('taskRevision', 0\)/)
  assert.match(rules, /request\.resource\.data\.committedAt == request\.time;/)
})

test('manual task deletion is bound to the revision the manager confirmed', async () => {
  const helper = await readFile(new URL('./taskMutations.js', import.meta.url), 'utf8')
  assert.match(helper, /deleteTaskDoc\(taskRef, actorUid, expectedTaskRevision\)/)
  assert.match(helper, /runTransaction\(taskRef\.firestore/)
  assert.match(helper, /currentTaskRevision !== expectedTaskRevision/)
  assert.match(helper, /expectedTaskRevision,\s+committedAt: serverTimestamp\(\)/)

  const files = await sourceFiles(new URL('../', import.meta.url))
  for (const file of files) {
    if (file.pathname.endsWith('/taskMutations.js')) continue
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(
      source,
      /deleteTaskDoc\(doc\(db, ['"]tasks['"], [^)]+\), user\.uid\)/,
      `${file.pathname} must pass the reviewed task revision`,
    )
  }
})
