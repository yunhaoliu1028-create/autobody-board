import {
  addDoc,
  doc,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'

export const TASK_STALE_DELETE_CODE = 'task/stale-delete'

export function normalizeTaskRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function taskCreateFields(fields = {}) {
  return { ...fields, taskRevision: 0 }
}

export function taskUpdateFields(fields = {}) {
  return { ...fields, taskRevision: increment(1) }
}

export function createTaskDoc(taskCollection, fields = {}) {
  return addDoc(taskCollection, taskCreateFields(fields))
}

export function setNewTaskDoc(taskRef, fields = {}) {
  return setDoc(taskRef, taskCreateFields(fields))
}

export function updateTaskDoc(taskRef, fields = {}) {
  return updateDoc(taskRef, taskUpdateFields(fields))
}

export function deleteTaskDoc(taskRef, actorUid, expectedTaskRevision) {
  if (!actorUid) throw new Error('A signed-in user is required to delete a task.')
  if (!Number.isInteger(expectedTaskRevision) || expectedTaskRevision < 0) {
    throw new Error('A reviewed task revision is required to delete a task.')
  }
  const receiptRef = doc(taskRef.firestore, 'taskDeletionReceipts', taskRef.id)
  return runTransaction(taskRef.firestore, async transaction => {
    const taskSnapshot = await transaction.get(taskRef)
    if (!taskSnapshot.exists()) return { alreadyDeleted: true }

    const currentTaskRevision = normalizeTaskRevision(taskSnapshot.data().taskRevision)
    if (currentTaskRevision !== expectedTaskRevision) {
      const error = new Error('This task changed after you reviewed it. Refresh and confirm deletion again.')
      error.code = TASK_STALE_DELETE_CODE
      throw error
    }

    transaction.set(receiptRef, {
      kind: 'task_delete',
      taskId: taskRef.id,
      actorUid,
      expectedTaskRevision,
      committedAt: serverTimestamp(),
    })
    transaction.delete(taskRef)
    return { alreadyDeleted: false }
  })
}
