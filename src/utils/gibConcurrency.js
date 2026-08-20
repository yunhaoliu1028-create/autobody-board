import { resolveRoForAction } from './actionIdentity.js'

export const GIB_STALE_PLAN_CODE = 'gib/stale-reviewed-plan'

const TASK_UNDO_VOLATILE_FIELDS = new Set([
  'assignedAt',
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
])

function normalizeStableValue(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeStableValue)
  if (typeof value.toJSON === 'function') return normalizeStableValue(value.toJSON())
  const normalized = {}
  Object.keys(value).sort().forEach(key => {
    const next = normalizeStableValue(value[key])
    if (next !== undefined) normalized[key] = next
  })
  return normalized
}

export function taskUndoFingerprint(task = {}) {
  const stable = {}
  Object.keys(task).sort().forEach(key => {
    if (TASK_UNDO_VOLATILE_FIELDS.has(key)) return
    const next = normalizeStableValue(task[key])
    if (next !== undefined) stable[key] = next
  })
  return JSON.stringify(stable)
}

export function normalizeGibRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function captureBaseRoRevisions(actions = [], ros = [], previous = {}) {
  const next = {}
  actions.forEach(action => {
    const roDoc = resolveRoForAction(ros, action)
    if (!roDoc?.id) return
    next[roDoc.id] = Object.prototype.hasOwnProperty.call(previous, roDoc.id)
      ? normalizeGibRevision(previous[roDoc.id])
      : normalizeGibRevision(roDoc.gibRevision)
  })
  return next
}

export function reviewedRoRevisionsAreComplete(actions = [], ros = [], baseRoRevisions = {}) {
  const targetRoIds = new Set()
  actions.forEach(action => {
    const roDoc = resolveRoForAction(ros, action)
    if (roDoc?.id) targetRoIds.add(roDoc.id)
  })
  return [...targetRoIds].every(roId => (
    Object.prototype.hasOwnProperty.call(baseRoRevisions, roId)
    && Number.isInteger(baseRoRevisions[roId])
    && baseRoRevisions[roId] >= 0
  ))
}

export function gibStalePlanError(message = 'RO or task data changed after these actions were reviewed.') {
  const error = new Error(message)
  error.code = GIB_STALE_PLAN_CODE
  return error
}

export function isGibStalePlanError(error) {
  return error?.code === GIB_STALE_PLAN_CODE
}
