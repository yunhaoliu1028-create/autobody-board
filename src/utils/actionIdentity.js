function normalizedText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function hasOwnField(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

export function normalizeActionRoNumber(value = '') {
  return String(value || '')
    .trim()
    .replace(/^(?:ro\s*#?|#)\s*/i, '')
    .trim()
}

export function actionTargetsRo(action = {}, roDoc = {}) {
  if (hasOwnField(action, 'roNumber')) {
    const roNumber = normalizeActionRoNumber(action.roNumber)
    return Boolean(roNumber) && roNumber === String(roDoc.roNumber ?? '')
  }
  return Boolean(action.roId && action.roId === roDoc.id)
}

export function resolveRoForAction(ros = [], action = {}) {
  if (hasOwnField(action, 'roNumber')) {
    const roNumber = normalizeActionRoNumber(action.roNumber)
    if (!roNumber) return null
    return ros.find(ro => String(ro.roNumber ?? '') === roNumber) ?? null
  }
  if (!action.roId) return null
  return ros.find(ro => ro.id === action.roId) ?? null
}

export function reconcileEditedActionIdentity(draft = {}, original = {}) {
  const next = { ...draft }

  if (hasOwnField(draft, 'roNumber')) {
    const roNumber = normalizeActionRoNumber(draft.roNumber)
    const originalRoNumber = normalizeActionRoNumber(original.roNumber)
    next.roNumber = roNumber
    if (!roNumber || roNumber !== originalRoNumber) delete next.roId
  }

  if (hasOwnField(draft, 'assigneeName')) {
    const assigneeName = String(draft.assigneeName || '').trim().replace(/\s+/g, ' ')
    next.assigneeName = assigneeName
    if (!assigneeName || normalizedText(assigneeName) !== normalizedText(original.assigneeName)) {
      delete next.assigneeUid
    }
  }

  return next
}
