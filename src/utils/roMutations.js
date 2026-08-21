import { increment, updateDoc } from 'firebase/firestore'

// Every current web RO writer advances the same revision used by GIB's
// optimistic-concurrency check. Keeping this in one wrapper also lets rules
// fail closed for older cached PWA RO writes that do not participate.
export function updateRoDoc(roRef, fields = {}) {
  return updateDoc(roRef, {
    ...fields,
    gibRevision: increment(1),
  })
}
