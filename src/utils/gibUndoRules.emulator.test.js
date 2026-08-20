import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  Bytes,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore'

const PROJECT_ID = 'demo-autobody-board-gib-undo'
const OWNER_UID = 'parts-owner'
const SURFACE = 'parts-manager'
const SURFACE_ID = `surface_${'b'.repeat(64)}`
const MANIFEST_HASH = 'a'.repeat(64)

let testEnv

before(async () => {
  const [host, rawPort] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port: Number(rawPort),
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  })
})

after(async () => {
  await testEnv?.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
})

function operationId(suffix = '1') {
  return `gib_${suffix.padStart(36, '0')}`
}

function operationRefs(db, opId) {
  const root = doc(db, 'gibOperations', OWNER_UID, 'operations', opId)
  return {
    root,
    manifest: doc(root, 'undoData', 'manifest'),
    receipt: doc(root, 'undoReceipts', 'undo_v1'),
    head: doc(db, 'gibUndoHeads', OWNER_UID, 'surfaces', SURFACE_ID),
  }
}

function operationDocuments({ opId, taskIds, targetRoIds = [], updatedTaskIds = [] }) {
  const itemCount = taskIds.length + targetRoIds.length + updatedTaskIds.length
  const payload = Bytes.fromUint8Array(new TextEncoder().encode(`manifest:${opId}:${itemCount}`))
  const resultRoRevisions = Object.fromEntries(targetRoIds.map(roId => [roId, 1]))
  const baseRoRevisions = Object.fromEntries(targetRoIds.map(roId => [roId, 0]))
  return {
    root: {
      kind: 'gib_apply',
      operationId: opId,
      ownerUid: OWNER_UID,
      planFingerprint: 'c'.repeat(64),
      schemaVersion: 3,
      sourceRole: 'parts_manager',
      actionCount: itemCount,
      writeCount: itemCount + 3,
      surface: SURFACE,
      surfaceId: SURFACE_ID,
      summary: 'Rules emulator operation',
      targetRoIds,
      createdTaskIds: taskIds,
      updatedTaskIds,
      baseRoRevisions,
      resultRoRevisions,
      undoSchemaVersion: 1,
      undoManifestHash: MANIFEST_HASH,
      undoManifestBytes: payload.toUint8Array().byteLength,
      undoItemCount: itemCount,
      committedAt: serverTimestamp(),
    },
    manifest: {
      kind: 'gib_undo_manifest',
      operationId: opId,
      ownerUid: OWNER_UID,
      schemaVersion: 1,
      payload,
      payloadHash: MANIFEST_HASH,
      payloadBytes: payload.toUint8Array().byteLength,
      itemCount,
      committedAt: serverTimestamp(),
    },
    head: {
      kind: 'gib_undo_head',
      ownerUid: OWNER_UID,
      surface: SURFACE,
      surfaceId: SURFACE_ID,
      operationId: opId,
      manifestHash: MANIFEST_HASH,
      itemCount,
      committedAt: serverTimestamp(),
    },
  }
}

function undoReceipt(opId, taskIds, itemCount = taskIds.length) {
  return {
    kind: 'gib_undo',
    operationId: opId,
    ownerUid: OWNER_UID,
    manifestHash: MANIFEST_HASH,
    itemCount,
    createdTaskIds: taskIds,
    surfaceId: SURFACE_ID,
    committedAt: serverTimestamp(),
  }
}

async function seedUser(role = 'parts_manager') {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'users', OWNER_UID), { role, name: 'Rules Owner' })
  })
}

async function applyTaskOperation(db, { opId, taskCount, includeHead = true }) {
  const taskIds = Array.from({ length: taskCount }, (_, index) => `${opId}_t${String(index).padStart(3, '0')}`)
  const refs = operationRefs(db, opId)
  const data = operationDocuments({ opId, taskIds })
  const batch = writeBatch(db)
  batch.set(refs.root, data.root)
  batch.set(refs.manifest, data.manifest)
  if (includeHead) batch.set(refs.head, data.head)
  taskIds.forEach((taskId, index) => batch.set(doc(db, 'tasks', taskId), {
    title: `Task ${index}`,
    status: 'pending',
    assignedTo: 'body-tech',
    taskRevision: 0,
    gibOperationId: opId,
    gibOperationOwnerUid: OWNER_UID,
    gibOperationTaskIndex: index,
  }))
  await assertSucceeds(batch.commit())
  return { refs, taskIds }
}

async function undoTaskOperation(db, { opId, taskIds }) {
  const refs = operationRefs(db, opId)
  const batch = writeBatch(db)
  batch.set(refs.receipt, undoReceipt(opId, taskIds))
  batch.delete(refs.head)
  taskIds.forEach(taskId => batch.delete(doc(db, 'tasks', taskId)))
  return batch.commit()
}

test('manager can atomically Apply and Undo the maximum 447 untouched GIB tasks', async () => {
  await seedUser('shop_manager')
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('max')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 447 })

  await assertSucceeds(undoTaskOperation(db, { opId, taskIds }))

  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[0]))).exists(), false)
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds.at(-1)))).exists(), false)
    assert.equal((await getDoc(refs.head)).exists(), false)
    assert.equal((await getDoc(refs.receipt)).exists(), true)
  })
})

test('parts_manager cannot delete even one task through a GIB Undo receipt', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('parts-one')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 1 })

  await assertFails(undoTaskOperation(db, { opId, taskIds }))
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[0]))).exists(), true)
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('parts_manager cannot use one receipt to delete a multi-task operation', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('parts-many')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 2 })

  await assertFails(undoTaskOperation(db, { opId, taskIds }))
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[0]))).exists(), true)
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[1]))).exists(), true)
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('parts_manager cannot use durable Undo to restore an existing task', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('parts-update')
  const taskId = 'existing-parts-task'
  const refs = operationRefs(db, opId)
  const data = operationDocuments({ opId, taskIds: [], updatedTaskIds: [taskId] })
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'tasks', taskId), {
      title: 'Existing task',
      assignedTo: OWNER_UID,
      status: 'pending',
      taskRevision: 0,
    })
  })

  const applyBatch = writeBatch(db)
  applyBatch.set(refs.root, data.root)
  applyBatch.set(refs.manifest, data.manifest)
  applyBatch.set(refs.head, data.head)
  applyBatch.update(doc(db, 'tasks', taskId), { status: 'completed', taskRevision: 1 })
  await assertSucceeds(applyBatch.commit())

  const undoBatch = writeBatch(db)
  undoBatch.set(refs.receipt, undoReceipt(opId, [], 1))
  undoBatch.delete(refs.head)
  undoBatch.update(doc(db, 'tasks', taskId), { status: 'pending', taskRevision: 2 })
  await assertFails(undoBatch.commit())
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    const task = (await getDoc(doc(adminDb, 'tasks', taskId))).data()
    assert.equal(task.status, 'completed')
    assert.equal(task.taskRevision, 1)
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('Undo receipt cannot be created without atomically deleting the current head', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('receipt-only')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 1 })

  await assertFails(setDoc(refs.receipt, undoReceipt(opId, taskIds)))
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('surface head cannot be rewound to an older immutable operation', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const oldOpId = operationId('old-head')
  const newOpId = operationId('new-head')
  await applyTaskOperation(db, { opId: oldOpId, taskCount: 1 })
  await applyTaskOperation(db, { opId: newOpId, taskCount: 1 })
  const oldRefs = operationRefs(db, oldOpId)
  const oldData = operationDocuments({ opId: oldOpId, taskIds: [`${oldOpId}_t000`] })

  await assertFails(setDoc(oldRefs.head, oldData.head))
  await testEnv.withSecurityRulesDisabled(async context => {
    const currentHead = (await getDoc(doc(
      context.firestore(), 'gibUndoHeads', OWNER_UID, 'surfaces', SURFACE_ID,
    ))).data()
    assert.equal(currentHead.operationId, newOpId)
  })
})

test('parts_manager can restore an RO-only GIB update with the same durable receipt', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('ro-only')
  const roId = 'ro-1'
  const refs = operationRefs(db, opId)
  const data = operationDocuments({ opId, taskIds: [], targetRoIds: [roId] })
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'ros', roId), { status: 'teardown', gibRevision: 0 })
  })

  const applyBatch = writeBatch(db)
  applyBatch.set(refs.root, data.root)
  applyBatch.set(refs.manifest, data.manifest)
  applyBatch.set(refs.head, data.head)
  applyBatch.update(doc(db, 'ros', roId), { status: 'body_work', gibRevision: 1 })
  await assertSucceeds(applyBatch.commit())

  const undoBatch = writeBatch(db)
  undoBatch.set(refs.receipt, undoReceipt(opId, [], 1))
  undoBatch.delete(refs.head)
  undoBatch.update(doc(db, 'ros', roId), { status: 'teardown', gibRevision: 2 })
  await assertSucceeds(undoBatch.commit())

  await testEnv.withSecurityRulesDisabled(async context => {
    const restored = (await getDoc(doc(context.firestore(), 'ros', roId))).data()
    assert.equal(restored.status, 'teardown')
    assert.equal(restored.gibRevision, 2)
  })
})

test('Undo is denied atomically after a created task starts or changes revision', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('stale')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 1 })

  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'tasks', taskIds[0]), {
      title: 'Started task',
      status: 'in_progress',
      assignedTo: 'body-tech',
      taskRevision: 1,
      gibOperationId: opId,
      gibOperationOwnerUid: OWNER_UID,
      gibOperationTaskIndex: 0,
    })
  })

  await assertFails(undoTaskOperation(db, { opId, taskIds }))
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[0]))).exists(), true)
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('Undo cannot delete a task whose operation provenance was changed', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('forged')
  const { refs, taskIds } = await applyTaskOperation(db, { opId, taskCount: 1 })

  await testEnv.withSecurityRulesDisabled(async context => {
    const taskRef = doc(context.firestore(), 'tasks', taskIds[0])
    const current = (await getDoc(taskRef)).data()
    await setDoc(taskRef, { ...current, gibOperationId: operationId('other') })
  })

  await assertFails(undoTaskOperation(db, { opId, taskIds }))
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore()
    assert.equal((await getDoc(doc(adminDb, 'tasks', taskIds[0]))).exists(), true)
    assert.equal((await getDoc(refs.head)).exists(), true)
    assert.equal((await getDoc(refs.receipt)).exists(), false)
  })
})

test('operation root, manifest, and surface head must be created atomically', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('no-head')
  const taskIds = [`${opId}_t000`]
  const refs = operationRefs(db, opId)
  const data = operationDocuments({ opId, taskIds })
  const batch = writeBatch(db)
  batch.set(refs.root, data.root)
  batch.set(refs.manifest, data.manifest)
  batch.set(doc(db, 'tasks', taskIds[0]), {
    title: 'Orphan attempt',
    status: 'pending',
    assignedTo: 'body-tech',
    taskRevision: 0,
    gibOperationId: opId,
    gibOperationOwnerUid: OWNER_UID,
    gibOperationTaskIndex: 0,
  })
  await assertFails(batch.commit())
})

test('legacy schema 2 operation writes are rejected', async () => {
  await seedUser()
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const opId = operationId('legacy')
  await assertFails(setDoc(doc(db, 'gibOperations', OWNER_UID, 'operations', opId), {
    kind: 'gib_apply',
    operationId: opId,
    ownerUid: OWNER_UID,
    planFingerprint: 'c'.repeat(64),
    schemaVersion: 2,
    sourceRole: 'parts_manager',
    actionCount: 1,
    writeCount: 1,
    targetRoIds: [],
    createdTaskIds: [],
    baseRoRevisions: {},
    resultRoRevisions: {},
    committedAt: serverTimestamp(),
  }))
})

test('manager manual task deletion receipt remains supported', async () => {
  await seedUser('shop_manager')
  const db = testEnv.authenticatedContext(OWNER_UID).firestore()
  const taskId = 'manual-task'
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'tasks', taskId), {
      title: 'Manual task', status: 'pending', assignedTo: 'body-tech', taskRevision: 2,
    })
  })

  const batch = writeBatch(db)
  batch.set(doc(db, 'taskDeletionReceipts', taskId), {
    kind: 'task_delete',
    taskId,
    actorUid: OWNER_UID,
    expectedTaskRevision: 2,
    committedAt: serverTimestamp(),
  })
  batch.delete(doc(db, 'tasks', taskId))
  await assertSucceeds(batch.commit())
})
