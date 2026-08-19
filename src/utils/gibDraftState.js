export const GIB_DRAFT_SCHEMA_VERSION = 2

export function resultMetadataWithoutActions(result) {
  if (!result || typeof result !== 'object') return null
  const { actions: _actions, ...metadata } = result
  return metadata
}

export function shouldAcceptGibParseResponse({
  requestRevision,
  currentRequestRevision,
  requestActionRevision,
  currentActionRevision,
  requestText,
  currentText,
}) {
  return requestRevision === currentRequestRevision
    && requestActionRevision === currentActionRevision
    && String(requestText || '').trim() === String(currentText || '').trim()
}

export function isGibPlanStale(actions, text, submittedInput) {
  return Array.isArray(actions)
    && actions.length > 0
    && String(text || '').trim() !== String(submittedInput || '').trim()
}

export function isGibDraftPayloadForOwner(payload, ownerUid) {
  return Boolean(
    payload
      && payload.schemaVersion === GIB_DRAFT_SCHEMA_VERSION
      && payload.ownerUid === ownerUid,
  )
}

export function isGibDraftMutationLocked(attempt) {
  return ['planning', 'committing', 'unknown'].includes(attempt?.status)
}

export function isGibDraftLifecycleCurrent(current, expected) {
  return Boolean(
    expected?.ownerUid
      && expected?.draftStorageKey
      && Number.isInteger(expected?.generation)
      && current?.ownerUid === expected.ownerUid
      && current?.draftStorageKey === expected.draftStorageKey
      && current?.generation === expected.generation,
  )
}

export function recoverGibAttemptAfterReload(attempt) {
  return ['planning', 'committing'].includes(attempt?.status)
    ? { ...attempt, status: 'unknown' }
    : attempt || null
}
