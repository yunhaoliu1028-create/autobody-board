import { Bytes, Timestamp, deleteField } from 'firebase/firestore'
import { sha256Hex } from './gibOperation.js'

export const GIB_UNDO_SCHEMA_VERSION = 1
export const GIB_UNDO_MANIFEST_ID = 'manifest'
export const GIB_UNDO_RECEIPT_ID = 'undo_v1'
export const GIB_UNDO_PAYLOAD_MAX_BYTES = 600 * 1024
export const GIB_UNDO_ITEM_MAX = 447

const MAP_TAG = '__gibUndoMap'
const TIMESTAMP_TAG = '__gibUndoTimestamp'
const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const RO_UNDO_FIELDS = new Set([
  'assignedBodyMan',
  'assignedPaintHelper',
  'assignedPainter',
  'carStatus',
  'changeLog',
  'customerAuthorized',
  'dropOffDate',
  'eta',
  'hasRental',
  'noReplacementPartsNeeded',
  'notes',
  'partsOrders',
  'partsReturns',
  'partsStatus',
  'partsSubtasks',
  'partsSubtasks.deliveredToReassembly',
  'partsSubtasks.deliveredToRepair',
  'partsSubtasks.verifiedAllReceived',
  'status',
])
const TASK_UNDO_FIELDS = new Set([
  'assignedAt',
  'assignedBy',
  'assignedByName',
  'assignedTo',
  'assignedToName',
  'completedAt',
  'status',
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function encodeUndoValue(value) {
  if (value === undefined) throw new Error('Undo data cannot contain undefined values.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Undo data cannot contain non-finite numbers.')
    return value
  }
  if (value instanceof Timestamp) {
    return { [TIMESTAMP_TAG]: [value.seconds, value.nanoseconds] }
  }
  if (Array.isArray(value)) return value.map(encodeUndoValue)
  if (!isPlainObject(value)) throw new Error('Undo data contains an unsupported Firestore value.')
  return {
    [MAP_TAG]: Object.keys(value).sort().map(key => [key, encodeUndoValue(value[key])]),
  }
}

function decodeUndoValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Undo payload contains a non-finite number.')
    return value
  }
  if (Array.isArray(value)) return value.map(decodeUndoValue)
  if (!isPlainObject(value)) throw new Error('Undo payload contains an invalid value.')

  const keys = Object.keys(value)
  if (keys.length !== 1) throw new Error('Undo payload contains an invalid tagged object.')
  if (keys[0] === TIMESTAMP_TAG) {
    const parts = value[TIMESTAMP_TAG]
    if (
      !Array.isArray(parts)
      || parts.length !== 2
      || !Number.isInteger(parts[0])
      || !Number.isInteger(parts[1])
      || parts[1] < 0
      || parts[1] > 999999999
    ) throw new Error('Undo payload contains an invalid timestamp.')
    return new Timestamp(parts[0], parts[1])
  }
  if (keys[0] === MAP_TAG) {
    const entries = value[MAP_TAG]
    if (!Array.isArray(entries)) throw new Error('Undo payload contains an invalid map.')
    const decoded = {}
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new Error('Undo payload contains an invalid map entry.')
      }
      if (FORBIDDEN_MAP_KEYS.has(entry[0])) {
        throw new Error('Undo payload contains a forbidden map key.')
      }
      if (Object.prototype.hasOwnProperty.call(decoded, entry[0])) {
        throw new Error('Undo payload contains a duplicate map key.')
      }
      decoded[entry[0]] = decodeUndoValue(entry[1])
    }
    return decoded
  }
  throw new Error('Undo payload contains an unknown value type.')
}

function valueAtPath(source, path) {
  return String(path).split('.').reduce((value, key) => (
    value == null ? undefined : value[key]
  ), source)
}

function validDocumentId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 1500
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
}

function validRevision(value) {
  return Number.isInteger(value) && value >= 0
}

function validateUndoPatch(patch, allowedFields = null) {
  if (!isPlainObject(patch) || !isPlainObject(patch.values) || !Array.isArray(patch.deleteFields)) {
    throw new Error('Undo payload contains an invalid field patch.')
  }
  const valueFields = Object.keys(patch.values)
  const deleteFields = patch.deleteFields
  if (valueFields.length + deleteFields.length > 250) {
    throw new Error('Undo payload contains too many fields in one patch.')
  }
  const allFields = [...valueFields, ...deleteFields]
  if (allFields.some(field => typeof field !== 'string' || !field || field.length > 1500)) {
    throw new Error('Undo payload contains an invalid field path.')
  }
  if (allFields.some(field => field.split('.').some(part => !part || FORBIDDEN_MAP_KEYS.has(part)))) {
    throw new Error('Undo payload contains a forbidden field path.')
  }
  if (allowedFields && allFields.some(field => !allowedFields.has(field))) {
    throw new Error('Undo payload contains a field that GIB cannot restore.')
  }
  if (new Set(allFields).size !== allFields.length) {
    throw new Error('Undo payload contains duplicate field paths.')
  }
}

export function buildGibUndoPatch(source = {}, fieldPaths = []) {
  const values = {}
  const deleteFields = []
  ;[...new Set(fieldPaths)].sort().forEach(field => {
    const previous = valueAtPath(source, field)
    if (previous === undefined) deleteFields.push(field)
    else values[field] = previous
  })
  const patch = { values, deleteFields }
  validateUndoPatch(patch)
  return patch
}

export function firestoreFieldsFromUndoPatch(patch) {
  validateUndoPatch(patch)
  const fields = { ...patch.values }
  patch.deleteFields.forEach(field => { fields[field] = deleteField() })
  return fields
}

function validateManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== GIB_UNDO_SCHEMA_VERSION) {
    throw new Error('Undo payload has an unsupported schema.')
  }
  if (!validDocumentId(manifest.operationId) || typeof manifest.ownerUid !== 'string' || !manifest.ownerUid) {
    throw new Error('Undo payload has an invalid owner or operation ID.')
  }
  if (!Array.isArray(manifest.roRestores) || !Array.isArray(manifest.createdTasks) || !Array.isArray(manifest.taskRestores)) {
    throw new Error('Undo payload is missing restore groups.')
  }

  manifest.roRestores.forEach(item => {
    if (!isPlainObject(item) || !validDocumentId(item.roId) || !validRevision(item.resultRevision)) {
      throw new Error('Undo payload contains an invalid RO restore.')
    }
    validateUndoPatch(item.patch, RO_UNDO_FIELDS)
  })
  manifest.createdTasks.forEach(item => {
    if (
      !isPlainObject(item)
      || !validDocumentId(item.taskId)
      || !validRevision(item.resultRevision)
      || typeof item.expectedAfterFingerprint !== 'string'
    ) throw new Error('Undo payload contains an invalid created-task restore.')
  })
  manifest.taskRestores.forEach(item => {
    if (
      !isPlainObject(item)
      || !validDocumentId(item.taskId)
      || !validRevision(item.resultRevision)
      || typeof item.expectedAfterFingerprint !== 'string'
    ) throw new Error('Undo payload contains an invalid task restore.')
    validateUndoPatch(item.patch, TASK_UNDO_FIELDS)
  })

  const roIds = manifest.roRestores.map(item => item.roId)
  const createdTaskIds = manifest.createdTasks.map(item => item.taskId)
  const updatedTaskIds = manifest.taskRestores.map(item => item.taskId)
  if (
    new Set(roIds).size !== roIds.length
    || new Set(createdTaskIds).size !== createdTaskIds.length
    || new Set(updatedTaskIds).size !== updatedTaskIds.length
    || createdTaskIds.some(taskId => updatedTaskIds.includes(taskId))
  ) throw new Error('Undo payload contains duplicate document targets.')

  const itemCount = manifest.roRestores.length + manifest.createdTasks.length + manifest.taskRestores.length
  if (itemCount !== manifest.itemCount || itemCount < 1 || itemCount > GIB_UNDO_ITEM_MAX) {
    throw new Error('Undo payload item count is invalid.')
  }
  return manifest
}

export async function buildGibUndoPayload(manifestInput) {
  const itemCount = (manifestInput.roRestores?.length || 0)
    + (manifestInput.createdTasks?.length || 0)
    + (manifestInput.taskRestores?.length || 0)
  const manifest = validateManifest({
    ...manifestInput,
    schemaVersion: GIB_UNDO_SCHEMA_VERSION,
    itemCount,
  })
  const payloadText = JSON.stringify(encodeUndoValue(manifest))
  const encodedPayload = new TextEncoder().encode(payloadText)
  const payloadBytes = encodedPayload.byteLength
  if (payloadBytes > GIB_UNDO_PAYLOAD_MAX_BYTES) {
    throw new Error(`This Undo record is ${payloadBytes} bytes. Split the GIB update into smaller drafts.`)
  }
  return {
    manifest,
    payload: Bytes.fromUint8Array(encodedPayload),
    payloadBytes,
    payloadHash: await sha256Hex(payloadText),
    itemCount,
  }
}

export async function parseGibUndoPayload({
  payload,
  payloadHash,
  operationId,
  ownerUid,
  itemCount,
}) {
  if (!payload || typeof payload.toUint8Array !== 'function') {
    throw new Error('Undo manifest payload is missing.')
  }
  const encodedPayload = payload.toUint8Array()
  const payloadBytes = encodedPayload.byteLength
  if (payloadBytes > GIB_UNDO_PAYLOAD_MAX_BYTES) throw new Error('Undo manifest payload is too large.')
  let payloadText
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(encodedPayload)
  } catch {
    throw new Error('Undo manifest payload is not valid UTF-8.')
  }
  if (typeof payloadHash !== 'string' || await sha256Hex(payloadText) !== payloadHash) {
    throw new Error('Undo manifest integrity check failed.')
  }
  let decoded
  try {
    decoded = decodeUndoValue(JSON.parse(payloadText))
  } catch (error) {
    throw new Error(`Undo manifest could not be decoded: ${error.message}`)
  }
  const manifest = validateManifest(decoded)
  if (
    manifest.operationId !== operationId
    || manifest.ownerUid !== ownerUid
    || manifest.itemCount !== itemCount
  ) throw new Error('Undo manifest does not match its operation record.')
  return manifest
}

export async function gibUndoSurfaceId(surface) {
  const normalized = String(surface || 'general')
  if (normalized.length > 160) throw new Error('This GIB surface identity is too long to save safely.')
  return `surface_${await sha256Hex(normalized)}`
}

export function operationHasDurableUndo(data, ownerUid, surface) {
  return Boolean(
    data
      && data.kind === 'gib_apply'
      && data.ownerUid === ownerUid
      && data.schemaVersion === 3
      && data.undoSchemaVersion === GIB_UNDO_SCHEMA_VERSION
      && data.surface === surface
      && typeof data.surfaceId === 'string'
      && /^surface_[0-9a-f]{64}$/.test(data.surfaceId)
      && typeof data.undoManifestHash === 'string'
      && /^[0-9a-f]{64}$/.test(data.undoManifestHash)
      && Number.isInteger(data.undoManifestBytes)
      && data.undoManifestBytes >= 1
      && data.undoManifestBytes <= GIB_UNDO_PAYLOAD_MAX_BYTES
      && Number.isInteger(data.undoItemCount)
      && data.undoItemCount >= 1
      && data.undoItemCount <= GIB_UNDO_ITEM_MAX,
  )
}

export function undoManifestDocumentMatches(data, operationData, ownerUid) {
  return Boolean(
    data
      && operationData
      && data.kind === 'gib_undo_manifest'
      && data.operationId === operationData.operationId
      && data.ownerUid === ownerUid
      && data.schemaVersion === operationData.undoSchemaVersion
      && data.payloadHash === operationData.undoManifestHash
      && data.payloadBytes === operationData.undoManifestBytes
      && data.itemCount === operationData.undoItemCount
      && data.payload?.toUint8Array?.().byteLength === data.payloadBytes,
  )
}

export function undoHeadMatchesOperation(data, operationData, ownerUid, surfaceId) {
  return Boolean(
    data
      && operationData
      && data.kind === 'gib_undo_head'
      && data.ownerUid === ownerUid
      && data.surfaceId === surfaceId
      && operationData.surfaceId === surfaceId
      && data.surface === operationData.surface
      && data.operationId === operationData.operationId
      && data.manifestHash === operationData.undoManifestHash
      && data.itemCount === operationData.undoItemCount,
  )
}

function sameIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const normalizedLeft = [...left].sort()
  const normalizedRight = [...right].sort()
  return normalizedLeft.every((value, index) => value === normalizedRight[index])
}

export function undoManifestTargetsMatchOperation(manifest, operationData) {
  if (!manifest || !operationData) return false
  const roIds = manifest.roRestores.map(item => item.roId)
  const createdTaskIds = manifest.createdTasks.map(item => item.taskId)
  const updatedTaskIds = manifest.taskRestores.map(item => item.taskId)
  if (
    !sameIds(roIds, operationData.targetRoIds)
    || !sameIds(createdTaskIds, operationData.createdTaskIds)
    || !sameIds(updatedTaskIds, operationData.updatedTaskIds)
  ) return false
  return manifest.roRestores.every(item => (
    operationData.resultRoRevisions?.[item.roId] === item.resultRevision
  ))
}

export function undoReceiptMatches(data, operationData, ownerUid) {
  return Boolean(
    data
      && operationData
      && data.kind === 'gib_undo'
      && data.ownerUid === ownerUid
      && data.operationId === operationData.operationId
      && data.manifestHash === operationData.undoManifestHash
      && data.itemCount === operationData.undoItemCount
      && data.surfaceId === operationData.surfaceId
      && sameIds(data.createdTaskIds, operationData.createdTaskIds),
  )
}

export function durableUndoSupportedForRole(data, role) {
  const createdTaskCount = Array.isArray(data?.createdTaskIds) ? data.createdTaskIds.length : Number.POSITIVE_INFINITY
  const updatedTaskCount = Array.isArray(data?.updatedTaskIds) ? data.updatedTaskIds.length : Number.POSITIVE_INFINITY
  if (['shop_manager', 'production_manager', 'estimator'].includes(role)) return true
  return updatedTaskCount === 0 && createdTaskCount === 0
}

export function recentAppliedFromOperation(data, draftStorageKey, role = '') {
  const committedAt = data.committedAt?.toDate?.()
  return {
    at: committedAt instanceof Date ? committedAt.toISOString() : new Date().toISOString(),
    ownerUid: data.ownerUid,
    draftStorageKey,
    operationId: data.operationId,
    summary: typeof data.summary === 'string' ? data.summary.split('\n').filter(Boolean).slice(0, 4) : [],
    actionCount: data.actionCount,
    undoSupported: durableUndoSupportedForRole(data, role),
  }
}
