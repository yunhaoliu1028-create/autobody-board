import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) return sourceFiles(url)
    return /\.(?:js|jsx)$/.test(entry.name) ? [url] : []
  }))
  return nested.flat()
}

describe('shared RO mutation revision', () => {
  it('routes every web updateDoc call for an RO through updateRoDoc', async () => {
    const files = await sourceFiles(new URL('../', import.meta.url))
    for (const file of files) {
      if (file.pathname.endsWith('/roMutations.js')) continue
      const source = await readFile(file, 'utf8')
      assert.doesNotMatch(source, /updateDoc\s*\(\s*doc\(db,\s*['"]ros['"]/, file.pathname)
      assert.doesNotMatch(source, /updateDoc\s*\(\s*roRef\s*,/, file.pathname)
    }
  })

  it('keeps the CCC extension on the same revision protocol', async () => {
    for (const path of ['../../chrome-extension/background.js', '../../chrome-extension/popup.js']) {
      const source = await readFile(new URL(path, import.meta.url), 'utf8')
      assert.match(source, /fieldPath: ['"]gibRevision['"], increment: \{ integerValue: ['"]1['"] \}/)
      assert.match(source, /gibRevision:\s*\{ integerValue: ['"]0['"] \}/)
    }
  })

  it('requires every current RO creator to start at revision zero', async () => {
    const addEditSource = await readFile(new URL('../pages/AddEditRO.jsx', import.meta.url), 'utf8')
    const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8')
    assert.match(addEditSource, /payload\.gibRevision = 0/)
    assert.match(rules, /allow create: if isAuth\(\)\s+&& canEditRO\(\)\s+&& request\.resource\.data\.gibRevision == 0;/)
  })
})
