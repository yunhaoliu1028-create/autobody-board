export const GIB_OPERATION_SCHEMA_VERSION = 2

const NON_SEMANTIC_ACTION_KEYS = new Set(['confidence'])

function normalizeForFingerprint(value, parentKey = '') {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map(item => normalizeForFingerprint(item, parentKey))
  }

  const normalized = {}
  Object.keys(value).sort().forEach(key => {
    if (parentKey === 'actions' && NON_SEMANTIC_ACTION_KEYS.has(key)) return
    const next = normalizeForFingerprint(value[key], key)
    if (next !== undefined) normalized[key] = next
  })
  return normalized
}

export function stableGibJson(value) {
  return JSON.stringify(normalizeForFingerprint(value))
}

export function createGibDraftNonce() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  return `${Date.now().toString(36)}-${random}`.padEnd(32, '0')
}

export async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure operation identity is not available in this browser.')
  }
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function buildGibOperationIdentity({
  draftNonce,
  actorUid,
  sourceRole = '',
  submittedInput = '',
  actions = [],
  baseRoRevisions = {},
}) {
  if (!draftNonce) throw new Error('This GIB draft is missing its safety identity. Submit it again before applying.')
  if (!actorUid) throw new Error('You must be signed in before applying GIB actions.')

  const planFingerprint = await sha256Hex(stableGibJson({
    schemaVersion: GIB_OPERATION_SCHEMA_VERSION,
    actorUid,
    sourceRole: sourceRole || '',
    submittedInput: submittedInput.trim(),
    actions,
    baseRoRevisions,
  }))
  const safeNonce = String(draftNonce).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
  if (safeNonce.length < 26) throw new Error('This GIB draft has an invalid safety identity. Submit it again before applying.')

  return {
    // One immutable sentinel per draft. Competing stale/manual revisions of
    // the same draft must contend for the same document, not create two
    // independently valid operation IDs.
    operationId: `gib_${safeNonce}`,
    planFingerprint,
    schemaVersion: GIB_OPERATION_SCHEMA_VERSION,
  }
}

export function gibOperationLimitError({ actions = [], targetRoIds = [], writeCount = 0 }) {
  if (actions.length > 449) {
    return `This update contains ${actions.length} actions. Split it into drafts of 449 actions or fewer.`
  }
  const uniqueTargetCount = new Set(targetRoIds.filter(Boolean)).size
  if (uniqueTargetCount > 100) {
    return `This update targets ${uniqueTargetCount} ROs. Split it into drafts of 100 ROs or fewer.`
  }
  if (writeCount > 450) {
    return `This update needs ${writeCount} database writes including its safety record. Split it into smaller updates.`
  }
  return ''
}

export function gibTaskDocumentId(operationId, index) {
  if (!operationId) throw new Error('Missing GIB operation ID for task creation.')
  if (!Number.isInteger(index) || index < 0 || index > 999) {
    throw new Error('Invalid GIB task index.')
  }
  return `${operationId}_t${String(index).padStart(3, '0')}`
}

export function operationLedgerMatches(snapshotData, identity, actorUid) {
  return Boolean(
    snapshotData
      && snapshotData.operationId === identity.operationId
      && snapshotData.planFingerprint === identity.planFingerprint
      && snapshotData.schemaVersion === identity.schemaVersion
      && snapshotData.ownerUid === actorUid,
  )
}
