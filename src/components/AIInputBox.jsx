import { useState, useEffect, useMemo, useRef } from 'react'
import { doc, updateDoc, addDoc, deleteDoc, deleteField, getDocs, query, where, collection, serverTimestamp, arrayUnion, arrayRemove } from 'firebase/firestore'
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'
import { parseShopInput, getApiKey, transcribeWithWhisper } from '../hooks/useAI'
import { getSuggestedNextStatus, getDownstreamTasks } from '../engine/taskRules'
import { STATUS_MAP, RO_STATUSES, PARTS_STATUSES, CAR_STATUSES, CAR_STATUS_MAP } from '../constants/roles'
import MentionTextarea, { buildMentionCandidates } from './MentionTextarea'
import { format, differenceInCalendarDays, parseISO, isValid } from 'date-fns'
import { compressImageFile, compressVideoFrame } from '../utils/imageCompression'
import { playShutterSound } from '../utils/cameraFeedback'
import { inferStructuredActionsFromText } from '../utils/aiActionInference'
import { buildRoInputScopes, getRoScopedText } from '../utils/gibInputScope'
import {
  extractPartsOrderCandidates,
  mergePreferredPartsOrderActions,
  removeCrossRoPartsOrderLeakage,
  vendorsMatchIgnoringParsingMetadata,
} from '../utils/partsOrderParsing'

const BODY_RELEASE_ERROR = 'Please assign a body technician before releasing repair'

function dueDateToPriority(ro) {
  const dateStr = ro?.eta || ro?.cccDateOut || ro?.promisedDate
  if (!dateStr) return 'medium'
  try {
    const due  = parseISO(dateStr)
    if (!isValid(due)) return 'medium'
    const days = differenceInCalendarDays(due, new Date())
    if (days <= 2)  return 'high'
    if (days <= 7)  return 'medium'
    return 'low'
  } catch { return 'medium' }
}

function normalizeName(value = '') {
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeVendorName(value = '') {
  const normalized = normalizeName(value)
    .split(' ')
    .filter(part => !['dealer', 'dealership', 'oem', 'parts', 'part'].includes(part))
    .join(' ')
    .trim()
  if (['sm toyota', 's m toyota', 'smt'].includes(normalized)) return 'santa margarita toyota'
  if (['kaystone', 'keyston', 'kystone', 'key stone'].includes(normalized)) return 'keystone'
  return normalized
    .replace(/\bchevy\b/g, 'chevrolet')
    .replace(/\bph\b/g, 'puente hills')
    .replace(/\s+/g, ' ')
    .trim()
}

function vendorNamesMatch(left = '', right = '') {
  const a = normalizeVendorName(left)
  const b = normalizeVendorName(right)
  if (!a || !b) return false
  if (a === b) return true
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true

  const aParts = a.split(' ').filter(Boolean)
  const bParts = b.split(' ').filter(Boolean)
  if (aParts.length < 2 || bParts.length < 2) return false

  const shorter = aParts.length <= bParts.length ? aParts : bParts
  const longer = aParts.length <= bParts.length ? bParts : aParts
  return shorter.every(part =>
    longer.some(other => other === part || other.startsWith(part) || part.startsWith(other))
  )
}

function isDealerVendorText(value = '') {
  return /\b(dealer|dealership|oem)\b/i.test(String(value))
}

function orderMatchesVendor(order, rawVendor = '', rawVendorFull = '') {
  const vendor = rawVendor || ''
  const vendorFull = rawVendorFull || ''
  if (!vendor && !vendorFull) return false
  if (
    vendorNamesMatch(order?.vendor, vendor)
    || vendorNamesMatch(order?.vendorFull, vendor)
    || vendorNamesMatch(order?.vendor, vendorFull)
    || vendorNamesMatch(order?.vendorFull, vendorFull)
  ) return true

  if (isDealerVendorText(`${vendor} ${vendorFull}`)) {
    return isDealerVendorText(`${order?.vendor ?? ''} ${order?.vendorFull ?? ''}`)
  }
  return false
}

function withApplyTimeout(promise, timeoutMs = 20000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Apply is taking too long. Please refresh and check whether the update already went through before applying again.')), timeoutMs)
    }),
  ])
}

function vendorGroupKey(order = {}) {
  return normalizeVendorName(order.vendorFull) || normalizeVendorName(order.vendor) || 'missing vendor'
}

function orderQtyValue(order = {}) {
  return numericQty(order.qty ?? order.quantity, 0)
}

function orderReceivedValue(order = {}) {
  return numericQty(order.qtyReceived ?? order.receivedQty, 0)
}

function preferredVendorLabel(order = {}, fallback = 'Missing vendor') {
  const full = (order.vendorFull || '').trim()
  const vendor = (order.vendor || '').trim()
  const fullParts = normalizeVendorName(full).split(' ').filter(Boolean).length
  const vendorParts = normalizeVendorName(vendor).split(' ').filter(Boolean).length
  if (full && fullParts > vendorParts) return full
  return vendor || full || fallback
}

function mergePartsOrdersForAction(orders = []) {
  const groups = new Map()
  orders.forEach(order => {
    const key = vendorGroupKey(order)
    const current = groups.get(key) ?? {
      key,
      vendor: preferredVendorLabel(order),
      vendorFull: order.vendorFull || '',
      quantity: 0,
      received: 0,
      eta: null,
      sourceOrders: [],
    }
    const label = preferredVendorLabel(order, current.vendor)
    if (label.length > current.vendor.length || current.vendor === 'Missing vendor') current.vendor = label
    if (!current.vendorFull && order.vendorFull) current.vendorFull = order.vendorFull
    const ordered = orderQtyValue(order)
    const received = Math.min(orderReceivedValue(order), ordered || orderReceivedValue(order))
    current.quantity += ordered
    current.received += received
    if (order.eta && (!current.eta || order.eta < current.eta)) current.eta = order.eta
    current.sourceOrders.push(order)
    groups.set(key, current)
  })
  return [...groups.values()].filter(group => group.quantity > 0)
}

function actionVendorsMatch(left = {}, right = {}) {
  return vendorNamesMatch(left.vendor, right.vendor)
    || vendorNamesMatch(left.vendorFull, right.vendor)
    || vendorNamesMatch(left.vendor, right.vendorFull)
    || vendorNamesMatch(left.vendorFull, right.vendorFull)
}

function orderMentionedInText(order, text = '') {
  const normalizedText = normalizeName(text)
  if (!normalizedText) return false
  if (/\bdealer\b/i.test(text) && isDealerVendorText(`${order?.vendor ?? ''} ${order?.vendorFull ?? ''}`)) return true

  const names = [order?.vendor, order?.vendorFull]
    .map(normalizeVendorName)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  return names.some(name => {
    const parts = name.split(' ').filter(Boolean)
    return parts.length >= 2 && parts.every(part => normalizedText.includes(part))
  })
}

function findEmployeeByName(employees, rawName = '', preferredRole = null) {
  const employeeList = Array.isArray(employees)
    ? employees
    : Object.entries(employees || {}).map(([uid, name]) => ({ uid, name, role: '' }))
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  const matches = employeeList.filter(emp => {
    const name = normalizeName(emp.name)
    if (!name) return false
    const nameParts = name.split(' ').filter(Boolean)
    if (name === target) return true
    if (targetParts.length === 1) {
      return nameParts.some(part => part === target || part.startsWith(target))
    }
    return targetParts.every(part =>
      nameParts.some(namePart => namePart === part || namePart.startsWith(part))
    )
  })
  if (preferredRole) {
    const roleMatch = matches.find(emp => emp.role === preferredRole)
    return roleMatch ?? null
  }
  return matches[0] ?? null
}

function findEmployeeByUid(employees, uid = '') {
  if (!uid) return null
  if (Array.isArray(employees)) return employees.find(emp => emp.uid === uid) ?? null
  const name = employees?.[uid]
  return name ? { uid, name, role: '' } : null
}

function isBodyTaskAction(action) {
  const text = `${action.title ?? ''} ${action.description ?? ''} ${action.assigneeName ?? ''}`.toLowerCase()
  const hasCoreBodyPhase = /\b(body\s*(man|tech|work)|teardown|tear\s*down|process repair|begin repair|start repair|reassembl|reassemble|assemble|assigned body)\b/i.test(text)
  if (hasCoreBodyPhase) return true
  const looksLikeVerificationTask = /\b(check|verify|confirm|inspect|light|illuminated|photo|call|follow\s*up|update customer)\b/i.test(text)
  if (looksLikeVerificationTask) return false
  return /\b(body\s*(man|tech)|repair)\b/i.test(text)
}

function bodyPhaseFromText(text = '') {
  if (/\b(reassembl\w*|reassemble|assemble)\b/i.test(text)) return 'reassembly'
  if (/\b(tear\s*down|teardown)\b/i.test(text)) return 'teardown'
  if (/\b(body[\s_-]*(man|tech|work|complete)|process repair|begin repair|start repair|repair authorized|authorized.*repair|can start repair|repair)\b/i.test(text)) return 'body'
  if (/可以开始.*repair|开始.*repair|开始维修|可以修|可以开始修/i.test(text)) return 'body'
  return ''
}

function bodyPhaseTitle(phase) {
  if (phase === 'teardown') return 'Teardown'
  if (phase === 'reassembly') return 'Reassembly'
  return 'Repair'
}

function looksLikeSecondaryBodyTask(action, contextText = '') {
  const text = `${taskTitleFromAction(action, '')} ${action.description ?? ''} ${contextText}`.toLowerCase()
  return /\b(customer|service|concern|check|verify|inspect|adjust|gap|fitment|tire|tyre|pressure|tpms|photo|picture|light|noise|rattle)\b/i.test(text)
    || /客人|客户|检查|调整|胎压|照片|异响|缝|间隙|灯/i.test(text)
}

function looksLikeSecondaryBodyTaskStrict(action, contextText = '') {
  const text = `${taskTitleFromAction(action, '')} ${action.description ?? ''}`.toLowerCase()
  const fallbackText = String(contextText || '').toLowerCase()
  return /\b(customer|service|concern|check|verify|inspect|adjust|gap|fitment|fluid|leak|tire|tyre|pressure|tpms|photo|picture|light|noise|rattle)\b/i.test(text)
    || /å®¢äºº|å®¢æˆ·|æ£€æŸ¥|è°ƒæ•´|èƒŽåŽ‹|ç…§ç‰‡|å¼‚å“|ç¼|é—´éš™|ç¯/i.test(text)
    || (!text.trim() && /å®¢äºº|å®¢æˆ·|æ£€æŸ¥|è°ƒæ•´|èƒŽåŽ‹|æ¼|æµå‡º|ç…§ç‰‡|å¼‚å“|ç¼|é—´éš™|ç¯/i.test(fallbackText))
}

function isExplicitPrimaryBodyTaskAction(action) {
  if (action.taskKind === 'primary') return true
  if (action.taskKind === 'secondary') return false
  const text = `${taskTitleFromAction(action, '')} ${action.description ?? ''}`.toLowerCase()
  if (!bodyPhaseFromText(text)) return false
  if (looksLikeSecondaryBodyTaskStrict(action)) return false
  return true
}

function bodyTaskCore(action, contextText = '') {
  const rawTitle = taskTitleFromAction(action, '')
  const rawDescription = (action.description || '').trim()
  const text = `${rawTitle} ${rawDescription} ${contextText}`.toLowerCase()
  const phase = bodyPhaseFromText(text) || 'body'
  const title = bodyPhaseTitle(phase)

  const removeCoreWords = (value = '') => value
    .replace(/\b(teardown|tear\s*down|process repair|begin repair|start repair|body\s*work|repair|reassembly|reassemble|assemble)\b/ig, ' ')
    .replace(/^[\s:;,.\-–—+&/]+|[\s:;,.\-–—+&/]+$/g, '')
    .replace(/^(and|then)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  const detailFromTitle = removeCoreWords(rawTitle)
  const detailFromDescription = removeCoreWords(rawDescription)
  const subTask = detailFromDescription || detailFromTitle

  return {
    title,
    phase,
    description: subTask,
    secondaryTask: subTask ? {
      title: inferSecondaryBodyTaskTitle(subTask),
      description: subTask,
    } : null,
  }
}

function inferSecondaryBodyTaskTitle(text = '') {
  if (/\b(tire|tyre|tpms|pressure|air pressure)\b/i.test(text) || /胎压/i.test(text)) return 'Tire Pressure Check'
  if (/\b(fluid|leak|leaking|coolant|oil|water)\b/i.test(text) || /æ¼|æµå‡º/i.test(text)) return 'Fluid Leak Check'
  if (/\b(gap|fitment|align|adjust|bumper|door|fender|hood|trunk|panel)\b/i.test(text)) return 'Fitment Check'
  if (/\b(photo|picture|image)\b/i.test(text)) return 'Progress Photos'
  if (/\b(noise|rattle|wind|water leak|leak)\b/i.test(text)) return 'Concern Check'
  if (/\b(light|warning|engine|sensor|scan)\b/i.test(text)) return 'Warning Light Check'
  if (/\b(customer|service|concern)\b/i.test(text)) return 'Customer Concern'
  return 'Follow-up Item'
}

function normalizedTaskTitle(action, isBodyTask) {
  return isBodyTask ? bodyTaskCore(action).title : (action.title || 'Task')
}

function normalizedTaskDescription(action, isBodyTask) {
  return isBodyTask ? bodyTaskCore(action).description : (action.description ?? '')
}

function taskTitleFromAction(action, fallback = 'Task') {
  return (action.title || action.description || action.note || fallback).trim()
}

function newRecordId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function numericQty(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function actionVendorsMatchIgnoringParsingMetadata(left = {}, right = {}) {
  return vendorsMatchIgnoringParsingMetadata(left.vendor, right.vendor)
    || vendorsMatchIgnoringParsingMetadata(left.vendorFull, right.vendor)
    || vendorsMatchIgnoringParsingMetadata(left.vendor, right.vendorFull)
    || vendorsMatchIgnoringParsingMetadata(left.vendorFull, right.vendorFull)
}

function partsQtyValue(value, fallback = 0) {
  const numeric = numericQty(value, 0)
  if (numeric) return numeric
  const wordMap = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  return wordMap[String(value ?? '').trim().toLowerCase()] ?? fallback
}

function fmtShortDate(value) {
  if (!value) return ''
  try {
    const parsed = parseISO(value)
    return isValid(parsed) ? format(parsed, 'M/d') : value
  } catch {
    return value
  }
}

function calculatePartsStatus(orders = [], fallback = 'not_ordered') {
  if (!orders.length) return fallback || 'not_ordered'
  if (orders.every(isOrderFullyReceived)) return 'all_received'
  if (orders.some(order => normalizedOrderStatus(order) === 'partial' || numericQty(order.qtyReceived ?? order.receivedQty, 0) > 0)) return 'partially_received'
  return 'ordered'
}

function normalizedOrderStatus(order) {
  if (order?.status === 'partially_received') return 'partial'
  return order?.status || 'ordered'
}

function isOrderFullyReceived(order) {
  const qty = numericQty(order.qty ?? order.quantity, 0)
  const received = numericQty(order.qtyReceived ?? order.receivedQty, 0)
  return normalizedOrderStatus(order) === 'received' || (qty > 0 && received >= qty)
}

function currentPartsOrders(roDoc, entry) {
  return Array.isArray(entry.fields.partsOrders)
    ? entry.fields.partsOrders
    : Array.isArray(roDoc.partsOrders) ? roDoc.partsOrders : []
}

function orderStatusFromPartsStatus(partsStatus) {
  if (partsStatus === 'all_received') return 'received'
  if (partsStatus === 'partially_received') return 'partial'
  return 'ordered'
}

function sameRoActionText(actions, roNumber) {
  return actions
    .filter(action => String(action.roNumber ?? '') === String(roNumber ?? ''))
    .map(action => [
      action.note,
      action.notes,
      action.description,
      action.title,
      action.status,
      action.partsStatus,
    ].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase()
}

function bodyPhaseFromActionsForRo(actions = [], roNumber, inputText = '') {
  const directStatusAction = actions.find(action =>
    String(action.roNumber ?? '') === String(roNumber ?? '')
    && ['update_status', 'complete_phase'].includes(action.type)
    && bodyPhaseFromText(`${action.status ?? ''} ${action.phase ?? ''}`)
  )
  if (directStatusAction) {
    return bodyPhaseFromText(`${directStatusAction.status ?? ''} ${directStatusAction.phase ?? ''}`)
  }
  return bodyPhaseFromText(`${sameRoActionText(actions, roNumber)} ${inputText}`)
}

function resolveBodyTech(roDoc, employees = []) {
  const byUid = findEmployeeByUid(employees, roDoc?.assignedBodyMan)
  if (byUid?.role === 'body_man') return { uid: byUid.uid, name: byUid.name, source: 'assignedBodyMan', needsReview: false }

  const cccName = roDoc?.bodyTechName
    || roDoc?.bodyTech
    || roDoc?.bodyTechnician
    || roDoc?.cccBodyTech
    || roDoc?.cccBodyTechnician
    || ''
  const byCccName = findEmployeeByName(employees, cccName, 'body_man')
  if (byCccName) return { uid: byCccName.uid, name: byCccName.name, source: 'ccc', needsReview: false }

  return { uid: '', name: '', source: 'none', needsReview: Boolean(cccName) }
}

function assignedBodyTechName(roDoc, employees = []) {
  return resolveBodyTech(roDoc, employees).name
}

function hasAssignedBodyTech(roDoc, pendingFields = {}, employees = []) {
  if (pendingFields.assignedBodyMan) return true
  return resolveBodyTech(roDoc, employees).source === 'assignedBodyMan'
}

function roNumberForAction(action = {}, ros = []) {
  if (action.roNumber != null) return String(action.roNumber)
  return String(ros.find(ro => ro.id === action.roId)?.roNumber ?? '')
}

function scopedInputForRo(inputText = '', roNumber, actions = [], ros = []) {
  const actionRoNumbers = actions.map(action => roNumberForAction(action, ros)).filter(Boolean)
  const candidateRoNumbers = [...ros.map(ro => ro.roNumber), ...actionRoNumbers]
  return getRoScopedText(inputText, roNumber, candidateRoNumbers, actionRoNumbers)
}

function normalizeActionsPerRoScope(rawActions = [], inputText = '', ros = [], normalizeScope) {
  const actions = rawActions.map(action => ({ ...action, type: action.type ?? action.action }))
  const actionRoNumbers = actions.map(action => roNumberForAction(action, ros)).filter(Boolean)
  const candidateRoNumbers = [...ros.map(ro => ro.roNumber), ...actionRoNumbers]
  const scopes = buildRoInputScopes(inputText, candidateRoNumbers)
  const groups = new Map()
  const unscoped = []

  for (const action of actions) {
    const roNumber = roNumberForAction(action, ros)
    if (!roNumber) {
      unscoped.push(action)
      continue
    }
    const group = groups.get(roNumber) || []
    group.push(action)
    groups.set(roNumber, group)
  }

  const normalized = []
  for (const [roNumber, group] of groups) {
    const scopedText = scopes.get(roNumber)
      || (scopes.size === 0 && groups.size === 1 ? inputText : '')
    normalized.push(...normalizeScope(group, scopedText, roNumber))
  }

  if (unscoped.length) {
    const unscopedText = scopes.size === 0 && groups.size <= 1 ? inputText : ''
    normalized.push(...normalizeScope(unscoped, unscopedText, ''))
  }
  return normalized
}

function actionAssignsBodyTech(action, roDoc, employees = []) {
  if (action.type !== 'assign_body_man') return false
  const assignee = action.assigneeUid
    ? findEmployeeByUid(employees, action.assigneeUid)
    : findEmployeeByName(employees, action.assigneeName, 'body_man')
  if (!roDoc || assignee?.role !== 'body_man') return false
  return action.roId === roDoc.id || String(action.roNumber ?? '') === String(roDoc.roNumber ?? '')
}

function releaseHasBodyTech(roDoc, pendingFields = {}, actions = [], employees = []) {
  return hasAssignedBodyTech(roDoc, pendingFields, employees)
    || actions.some(action => actionAssignsBodyTech(action, roDoc, employees))
}

function isPaintPrimaryTemplate(tmpl = {}) {
  return tmpl.category === 'paint' && tmpl.taskKind === 'primary'
}

async function hasOpenTaskForTemplate(roId, tmpl) {
  if (!roId || !tmpl?.phase) return false
  const snap = await getDocs(query(collection(db, 'tasks'), where('roId', '==', roId), where('phase', '==', tmpl.phase)))
  return snap.docs.some(d => {
    const task = d.data()
    if (isPaintPrimaryTemplate(tmpl)) {
      return task.taskKind !== 'secondary' && (tmpl.statusBackfill || task.status !== 'completed')
    }
    if (task.status === 'completed') return false
    return task.title === tmpl.title
  })
}

function taskFieldsFromTemplate({ roDoc, tmpl, assignTo, user, author, employees }) {
  const assigneeName = employees.find(e => e.uid === assignTo)?.name ?? ''
  const fields = {
    roId: roDoc.id,
    roNumber: roDoc.roNumber,
    vehicleInfo: roDoc.vehicle || roDoc.vehicleInfo || '',
    assignedTo: assignTo,
    assignedBy: user.uid,
    assignedByName: author,
    assignedToName: assigneeName,
    assignedAt: serverTimestamp(),
    title: tmpl.title,
    phase: tmpl.phase,
    category: tmpl.category,
    taskKind: tmpl.taskKind,
    autoTriggered: true,
    source: 'auto',
    priority: dueDateToPriority(roDoc),
    dueDate: roDoc.eta || roDoc.cccDateOut || roDoc.promisedDate || null,
    status: 'pending',
    createdAt: serverTimestamp(),
    ...(tmpl.noAssigneeNote ? { taskNotes: [{ text: tmpl.noAssigneeNote, by: 'System', at: new Date().toISOString() }] } : {}),
  }
  // Firestore rejects `undefined` field values. Templates that aren't paint-related
  // have no category/taskKind — strip any undefined keys before the write.
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined) delete fields[k]
  }
  return fields
}

async function addDownstreamTasksForEntry({ entry, status, roDoc, employees, user, author, addTask }) {
  const downstreamTemplates = getDownstreamTasks(status, { ...roDoc, ...entry.fields })
  for (const tmpl of downstreamTemplates) {
    if (await hasOpenTaskForTemplate(roDoc.id, tmpl)) continue
    let assignTo = tmpl.assignedToUid
    if (!assignTo && tmpl.assignedToRole) {
      const emp = employees.find(e => e.role === tmpl.assignedToRole)
      assignTo = emp?.uid ?? null
    }
    if (tmpl.setRoField && assignTo) entry.fields[tmpl.setRoField] = assignTo
    if (assignTo) {
      entry.taskPromises.push(addTask(taskFieldsFromTemplate({ roDoc, tmpl, assignTo, user, author, employees })))
    }
  }
}

function inputExplicitlyMentionsAssignee(inputText = '', assigneeName = '') {
  const input = normalizeName(inputText)
  const name = normalizeName(assigneeName)
  if (!input || !name) return false
  const parts = name.split(' ').filter(Boolean)
  if (parts.length === 0) return false
  return parts.every(part => input.includes(part))
}

function findRoForAction(ros = [], action = {}) {
  return ros.find(ro => ro.id === action.roId || String(ro.roNumber ?? '') === String(action.roNumber ?? ''))
}

function normalizeBodyAssigneeDefaults(actions = [], inputText = '', ros = [], employees = []) {
  return actions.flatMap(action => {
    const roDoc = findRoForAction(ros, action)
    const existingBodyTech = resolveBodyTech(roDoc, employees)
    if (!existingBodyTech.uid && !existingBodyTech.name) return [action]

    const actionAssignee = action.assigneeName || ''
    const hasConflictingAssignee = actionAssignee
      && normalizeName(actionAssignee) !== normalizeName(existingBodyTech.name)
    const userExplicitlyNamedAssignee = inputExplicitlyMentionsAssignee(inputText, actionAssignee)
    if (!hasConflictingAssignee || userExplicitlyNamedAssignee) return [action]

    if (action.type === 'assign_body_man') return []

    const roActionText = `${sameRoActionText(actions, action.roNumber)} ${inputText}`
    const phase = bodyPhaseFromActionsForRo(actions, action.roNumber, inputText)
    const isBodyAssignment = action.type === 'assign_task'
      && (isExplicitPrimaryBodyTaskAction(action) || (phase && looksLikeSecondaryBodyTaskStrict(action, roActionText)))
    if (isBodyAssignment) return [{ ...action, assigneeName: existingBodyTech.name, assigneeUid: existingBodyTech.uid }]

    return [action]
  })
}

function parseReceivedAllExcept(inputText = '', scopedRoNumber = '') {
  const text = String(inputText || '')
  if (!/\b(received|recieved|rcvd|got)\b/i.test(text) || !/\b(all|everything)\b/i.test(text) || !/\bexcept\b/i.test(text)) {
    return null
  }

  const roMatch = text.match(/\b(?:ro\s*#?|#)?\s*(\d{4,})\b/i)
  const roNumber = String(scopedRoNumber || roMatch?.[1] || '')
  const afterExcept = text.split(/\bexcept\b/i).pop()?.trim() || ''

  const parseEta = (match) => {
    if (!match) return null
    const year = match[3]
      ? Number(match[3].length === 2 ? `20${match[3]}` : match[3])
      : new Date().getFullYear()
    const month = String(Number(match[1])).padStart(2, '0')
    const day = String(Number(match[2])).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const exceptions = []
  const clauseRe = /(\d+)\s*(?:pc|pcs|part|parts|piece|pieces)?\s*(?:from\s+)?(.+?)(?=\s+(?:and|,|;)\s+\d+\s*(?:pc|pcs|part|parts|piece|pieces)?\s*(?:from\s+)?|$)/gi
  for (const match of afterExcept.matchAll(clauseRe)) {
    const shortQty = numericQty(match[1], 0)
    const rawClause = match[2] || ''
    const etaMatch = rawClause.match(/\b(?:parts?|part|vendor)?\s*eta\s*(?:is|to|=|changed\s+to)?\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/i)
    const rawVendor = rawClause
      .replace(/\b(?:parts?|part|vendor)?\s*eta\b.*$/i, ' ')
      .replace(/\b(?:is|are|still|pending|missing|short|backorder(?:ed)?|left|remaining)\b/gi, ' ')
      .replace(/[.,;:!?]+\s*$/g, '')
      .trim()
    if (shortQty && rawVendor) {
      exceptions.push({ shortQty, rawVendor, eta: parseEta(etaMatch) })
    }
  }

  if (!exceptions.length) {
    const qtyThenVendor = afterExcept.match(/^(\d+)\s*(?:pc|pcs|part|parts|piece|pieces)?\s*(?:from\s+)?(.+?)\s*$/i)
    const vendorThenQty = afterExcept.match(/^(?:from\s+)?(.+?)\s+(\d+)\s*(?:pc|pcs|part|parts|piece|pieces)?\s*$/i)
    const shortQty = numericQty(qtyThenVendor?.[1] ?? vendorThenQty?.[2], 0)
    const etaMatch = text.match(/\b(?:parts?|part|vendor)?\s*eta\s*(?:is|to|=|changed\s+to)?\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/i)
    const rawVendor = (qtyThenVendor?.[2] ?? vendorThenQty?.[1] ?? '')
      .replace(/\b(?:parts?|part|vendor)?\s*eta\b.*$/i, ' ')
    .replace(/\b(?:is|are|still|pending|missing|short|backorder(?:ed)?|left|remaining)\b/gi, ' ')
    .replace(/[.,;:!?]+\s*$/g, '')
    .trim()
    if (shortQty && rawVendor) exceptions.push({ shortQty, rawVendor, eta: parseEta(etaMatch) })
  }

  if (!roNumber || !exceptions.length) return null
  return { roNumber, exceptions }
}

function normalizeReceivedAllExceptActions(rawActions = [], inputText = '', ros = [], scopedRoNumber = '') {
  const parsed = parseReceivedAllExcept(inputText, scopedRoNumber)
  if (!parsed) return rawActions

  const roDoc = ros.find(ro => String(ro.roNumber ?? '') === String(parsed.roNumber))
  const orders = Array.isArray(roDoc?.partsOrders) ? roDoc.partsOrders : []
  if (!roDoc || !orders.length) return rawActions

  const groups = mergePartsOrdersForAction(orders)
  const exceptions = parsed.exceptions
    .map(exception => {
      const group = groups.find(item =>
        vendorNamesMatch(item.vendor, exception.rawVendor) || vendorNamesMatch(item.vendorFull, exception.rawVendor)
      )
      return group ? { ...exception, group } : null
    })
    .filter(Boolean)
  if (exceptions.length !== parsed.exceptions.length) return rawActions
  const exceptionByKey = new Map(exceptions.map(exception => [exception.group.key, exception]))

  const generated = groups
    .map(group => {
      const total = group.quantity
      const exception = exceptionByKey.get(group.key)
      const nextReceived = Math.max(0, total - (exception?.shortQty ?? 0))
      return {
        type: 'log_parts_received',
        roNumber: roDoc.roNumber,
        vendor: group.vendor || exception?.rawVendor || '',
        vendorFull: group.vendorFull || '',
        qtyReceived: nextReceived,
        totalQty: total,
        receiveMode: 'set',
        currentQtyReceived: group.received,
        nextQtyReceived: nextReceived,
        eta: exception?.eta || undefined,
        confidence: 'high',
      }
    })

  const exceptionSummary = exceptions.map(exception => {
    const label = exception.group.vendor || exception.group.vendorFull || exception.rawVendor
    return `${label} short ${exception.shortQty} pc${exception.shortQty === 1 ? '' : 's'}${exception.eta ? ` ETA ${fmtShortDate(exception.eta)}` : ''}`
  }).join('; ')
  generated.push({
    type: 'add_note',
    roNumber: roDoc.roNumber,
    note: `Parts received: all vendors complete except ${exceptionSummary}.`,
    confidence: 'high',
  })

  const partsTypes = new Set(['log_parts_received', 'update_parts_order', 'update_parts_status', 'add_note'])
  const filtered = rawActions.filter(action =>
    String(action.roNumber ?? '') !== String(roDoc.roNumber ?? '') || !partsTypes.has(action.type)
  )
  return [...filtered, ...generated]
}

function parseReceivedAllFromVendors(inputText = '', scopedRoNumber = '') {
  const text = String(inputText || '')
  if (!/\b(received|recieved|rcvd|got)\b/i.test(text) || !/\ball\s+parts?\s+from\b/i.test(text)) return null
  const parsedSegments = text
    .split(/\s*\/\/+\s*/g)
    .map(segment => segment.trim())
    .filter(segment => /\b(received|recieved|rcvd|got)\b/i.test(segment) && /\ball\s+parts?\s+from\b/i.test(segment))
    .map(segment => {
      const roMatch = segment.match(/\b(?:ro\s*#?|#)?\s*(\d{4,})\b/i)
      const roNumber = String(scopedRoNumber || roMatch?.[1] || '')
      const afterFrom = segment.split(/\ball\s+parts?\s+from\b/i).pop()?.trim() || ''
      const vendorText = afterFrom
        .split(/\b(?:part|parts)\s+from\b/i)[0]
        .replace(/\b(?:and\s+)?(?:still\s+)?(?:waiting|short|except|missing)\b.*$/i, '')
        .replace(/[.;:!?/]+$/g, '')
        .trim()
      const rawVendors = vendorText
        .split(/\s*(?:,|;|&|\+|\band\b)\s*/i)
        .map(item => item.trim())
        .filter(Boolean)
      return roNumber && rawVendors.length ? { roNumber, rawVendors } : null
    })
    .filter(Boolean)
  return parsedSegments.length ? parsedSegments : null
}

function normalizeReceivedAllFromVendorActions(rawActions = [], inputText = '', ros = [], scopedRoNumber = '') {
  const parsedSegments = parseReceivedAllFromVendors(inputText, scopedRoNumber)
  if (!parsedSegments) return rawActions

  let nextActions = rawActions
  for (const parsed of parsedSegments) {
    const roDoc = ros.find(ro => String(ro.roNumber ?? '') === String(parsed.roNumber))
    const orders = Array.isArray(roDoc?.partsOrders) ? roDoc.partsOrders : []
    if (!roDoc || !orders.length) continue

    const groups = mergePartsOrdersForAction(orders)
    const matched = parsed.rawVendors
      .map(rawVendor => {
        const group = groups.find(item =>
          vendorNamesMatch(item.vendor, rawVendor) || vendorNamesMatch(item.vendorFull, rawVendor)
        )
        return group ? { rawVendor, group } : null
      })
      .filter(Boolean)
    if (!matched.length) continue

    const generated = matched.map(({ group, rawVendor }) => ({
      type: 'log_parts_received',
      roNumber: roDoc.roNumber,
      vendor: group.vendor || rawVendor,
      vendorFull: group.vendorFull || '',
      qtyReceived: group.quantity,
      totalQty: group.quantity,
      receiveMode: 'set',
      currentQtyReceived: group.received,
      nextQtyReceived: group.quantity,
      confidence: 'high',
    }))

    const generatedKeys = new Set(matched.map(({ group }) => group.key))
    nextActions = nextActions.filter(action => {
      if (String(action.roNumber ?? '') !== String(roDoc.roNumber ?? '')) return true
      if (!['log_parts_received', 'update_parts_order'].includes(action.type)) return true
      return !generatedKeys.has(normalizeVendorName(action.vendorFull || action.vendor))
    })
    nextActions = [...nextActions, ...generated]
  }
  return nextActions
}

function cleanWaitingVendor(value = '') {
  return String(value || '')
    .replace(/\b(?:eta|due|arriv(?:e|es|ing|al)?)\b.*$/i, '')
    .replace(/\b(?:back\s*order|backorder|backordered|ordered|order|wait|waiting|awaiting|still|on|from)\b/gi, ' ')
    .replace(/[.,;:!?/]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseWaitingPartsOrders(inputText = '', scopedRoNumber = '') {
  const text = String(inputText || '')
  if (!/\b(ord\w*|wait\w*|await\w*)\b/i.test(text) || !/\bfrom\b/i.test(text)) return []
  return text
    .split(/\s*\/\/+\s*/g)
    .map(segment => segment.trim())
    .flatMap(segment => {
      const inferredRoNumber = segment.match(/\b(?:ro\s*#?|#)?\s*(\d{4,})\b/i)?.[1] || ''
      const roNumber = String(scopedRoNumber || inferredRoNumber)
      if (!roNumber) return []
      const matches = []
      const re = /\b(?:ord\w*|wait\w*|await\w*)(?:\s+(?:and|&)\s+(?:ord\w*|wait\w*|await\w*))?\s+(?:on\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:pc|pcs|part|parts|piece|pieces)?\s+from\s+(.+?)(?:\s+(?:eta|due|arriv(?:e|es|ing|al)?)\s*(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?))?(?=$|[.;,])/gi
      for (const match of segment.matchAll(re)) {
        const qty = partsQtyValue(match[1], 0)
        const rawVendor = cleanWaitingVendor(match[2])
        if (!qty || !rawVendor) continue
        matches.push({
          roNumber,
          qty,
          rawVendor,
          eta: parseShortDate(match[3] || ''),
        })
      }
      return matches
    })
}

function normalizeWaitingPartsOrderActions(rawActions = [], inputText = '', ros = [], scopedRoNumber = '') {
  const parsedOrders = parseWaitingPartsOrders(inputText, scopedRoNumber)
  if (!parsedOrders.length) return rawActions

  let nextActions = rawActions.map(action => ({ ...action, type: action.type ?? action.action }))
  for (const parsed of parsedOrders) {
    const roDoc = ros.find(ro => String(ro.roNumber ?? '') === String(parsed.roNumber))
    const groups = mergePartsOrdersForAction(Array.isArray(roDoc?.partsOrders) ? roDoc.partsOrders : [])
    const group = groups.find(item =>
      vendorNamesMatch(item.vendor, parsed.rawVendor) || vendorNamesMatch(item.vendorFull, parsed.rawVendor)
    )
    const vendor = group?.vendor || parsed.rawVendor
    const vendorFull = group?.vendorFull || parsed.rawVendor
    const normalizedOrder = {
      type: 'update_parts_order',
      roNumber: roDoc?.roNumber || parsed.roNumber,
      roId: roDoc?.id,
      vendor,
      vendorFull: group?.vendorFull || group?.vendor || vendorFull,
      description: 'Parts order',
      qty: parsed.qty,
      qtyReceived: 0,
      eta: parsed.eta || null,
      status: 'ordered',
      forceNewOrder: true,
      confidence: 'high',
    }

    let replaced = false
    nextActions = nextActions.map(action => {
      const sameRo = roDoc
        ? action.roId === roDoc.id || String(action.roNumber ?? '') === String(roDoc.roNumber ?? '')
        : String(action.roNumber ?? '') === String(parsed.roNumber)
      if (
        action.type === 'update_parts_order'
        && sameRo
        && (
          vendorNamesMatch(action.vendor, parsed.rawVendor)
          || vendorNamesMatch(action.vendorFull, parsed.rawVendor)
          || vendorNamesMatch(action.vendor, vendor)
          || vendorNamesMatch(action.vendorFull, vendor)
        )
      ) {
        replaced = true
        return { ...action, ...normalizedOrder }
      }
      return action
    })
    if (!replaced) nextActions.push(normalizedOrder)
  }
  return nextActions
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const RECEIVED_CONTEXT_RE = /\b(received|recieved|rcvd|got|confirmed|complete|all\s+parts)\b/i
const WAITING_PARTS_CONTEXT_RE = /\b(wait|waiting|awaiting|short|missing|outstanding|order|ordered|ordering|backorder|backordered|hold|pending)\b/i

function matchWindow(text = '', matchIndex = 0, matchLength = 0, before = 80, after = 80) {
  const start = Math.max(0, matchIndex - before)
  const end = Math.min(text.length, matchIndex + matchLength + after)
  return text.slice(start, end)
}

function matchSentence(text = '', matchIndex = 0, matchLength = 0) {
  const before = text.slice(0, matchIndex)
  const after = text.slice(matchIndex + matchLength)
  const beforeBreak = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n'))
  const afterBreakCandidates = ['.', ';', '\n']
    .map(mark => after.indexOf(mark))
    .filter(index => index >= 0)
  const afterBreak = afterBreakCandidates.length ? Math.min(...afterBreakCandidates) : after.length
  return text.slice(beforeBreak + 1, matchIndex + matchLength + afterBreak)
}

function matchLocalContext(text = '', matchIndex = 0, matchLength = 0) {
  const sentence = matchSentence(text, matchIndex, matchLength)
  return sentence || matchWindow(text, matchIndex, matchLength)
}

function isWaitingPartsContext(text = '') {
  return WAITING_PARTS_CONTEXT_RE.test(text)
}

function hasReceivedContext(text = '') {
  return RECEIVED_CONTEXT_RE.test(text)
}

function noteReceivedQtyForVendor(noteText = '', group = {}) {
  const names = [group.vendor, group.vendorFull].filter(Boolean)
  for (const name of names) {
    const fractionMatch = noteText.match(new RegExp(`${escapeRegex(name)}\\s*\\(\\s*(\\d+)\\s*/\\s*(\\d+)\\s*\\)`, 'i'))
    if (fractionMatch) {
      const context = matchLocalContext(noteText, fractionMatch.index ?? 0, fractionMatch[0].length)
      if (isWaitingPartsContext(context)) continue
      return {
        received: numericQty(fractionMatch[1], 0),
        total: numericQty(fractionMatch[2], group.quantity),
      }
    }

    const qtyBeforeMatch = noteText.match(new RegExp(`(\\d+)\\s*(?:pc|pcs|part|parts|piece|pieces)?\\s+(?:from\\s+)?${escapeRegex(name)}\\b`, 'i'))
    if (qtyBeforeMatch) {
      const context = matchLocalContext(noteText, qtyBeforeMatch.index ?? 0, qtyBeforeMatch[0].length)
      if (isWaitingPartsContext(context) || !hasReceivedContext(context)) continue
      return {
        received: numericQty(qtyBeforeMatch[1], group.quantity),
        total: group.quantity,
      }
    }
  }
  const normalizedNote = normalizeVendorName(noteText)
  const groupKeys = [...new Set([group.vendor, group.vendorFull].map(normalizeVendorName).filter(Boolean))]
  for (const groupKey of groupKeys) {
    if (!normalizedNote.includes(groupKey)) continue
    const fuzzyVendor = groupKey
      .split(' ')
      .filter(Boolean)
      .map(escapeRegex)
      .join('[\\W_]+')
    const fuzzyMatch = noteText.match(new RegExp(`\\b${fuzzyVendor}\\b(?:[\\W_]+\\w+){0,4}?[\\W_]*\\(\\s*(\\d+)\\s*/\\s*(\\d+)\\s*\\)`, 'i'))
    if (fuzzyMatch) {
      const context = matchLocalContext(noteText, fuzzyMatch.index ?? 0, fuzzyMatch[0].length)
      if (isWaitingPartsContext(context)) continue
      return {
        received: numericQty(fuzzyMatch[1], 0),
        total: numericQty(fuzzyMatch[2], group.quantity),
      }
    }
    const bareFractionMatch = noteText.match(new RegExp(`\\b${fuzzyVendor}\\b(?:[\\W_]+\\w+){0,4}?[\\W_]+(\\d+)\\s*/\\s*(\\d+)`, 'i'))
    if (bareFractionMatch) {
      const context = matchLocalContext(noteText, bareFractionMatch.index ?? 0, bareFractionMatch[0].length)
      if (isWaitingPartsContext(context)) continue
      return {
        received: numericQty(bareFractionMatch[1], 0),
        total: numericQty(bareFractionMatch[2], group.quantity),
      }
    }
  }
  return null
}

function normalizeReceivedFromNoteActions(rawActions = [], ros = []) {
  const actions = rawActions.map(action => ({ ...action, type: action.type ?? action.action }))
  const generated = []

  actions.forEach(action => {
    if (action.type !== 'add_note') return
    const roDoc = findRoForAction(ros, action)
    const orders = Array.isArray(roDoc?.partsOrders) ? roDoc.partsOrders : []
    if (!roDoc || !orders.length) return

    const noteText = `${action.note ?? ''} ${action.notes ?? ''} ${action.description ?? ''}`
    if (!/\b(received|recieved|rcvd|got)\b/i.test(noteText)) return

    mergePartsOrdersForAction(orders).forEach(group => {
      const qty = noteReceivedQtyForVendor(noteText, group)
      if (!qty?.received) return
      const alreadyHasReceivedAction = actions.concat(generated).some(existing =>
        existing.type === 'log_parts_received'
        && String(existing.roNumber ?? '') === String(roDoc.roNumber ?? '')
        && actionVendorsMatch(existing, group)
      )
      if (alreadyHasReceivedAction) return

      const total = qty.total || group.quantity
      generated.push({
        type: 'log_parts_received',
        roNumber: roDoc.roNumber,
        vendor: group.vendor,
        vendorFull: group.vendorFull || '',
        qtyReceived: Math.min(qty.received, total || qty.received),
        totalQty: total,
        receiveMode: 'set',
        currentQtyReceived: group.received,
        nextQtyReceived: Math.min(qty.received, total || qty.received),
        confidence: 'high',
      })
    })
  })

  return generated.length ? [...actions, ...generated] : actions
}

function normalizeNoReplacementPartsActions(rawActions = [], inputText = '', ros = [], scopedRoNumber = '') {
  const text = String(inputText || '')
  if (!/\b(no|none|not\s+needed|does\s+not\s+need|doesn't\s+need|without)\b/i.test(text)) return rawActions
  if (!/\b(repl(?:acement)?|replace(?:ment)?|parts?|part)\b/i.test(text)) return rawActions
  if (/\b(order(?:ed)?|eta|received|rcvd|got|short|except|return|wrong|exchange)\b/i.test(text)) return rawActions

  const roNumber = String(scopedRoNumber || extractRoNumber(text, ros) || '')
  if (!roNumber) return rawActions
  const roDoc = ros.find(ro => String(ro.roNumber ?? '') === String(roNumber))
  if (!roDoc) return rawActions

  const filtered = rawActions
    .map(action => ({ ...action, type: action.type ?? action.action }))
    .filter(action => {
      if (String(action.roNumber ?? '') !== String(roNumber)) return true
      return !['update_parts_order', 'log_parts_received', 'update_parts_status', 'add_note'].includes(action.type)
    })

  return [
    ...filtered,
    {
      type: 'update_parts_status',
      roNumber,
      partsStatus: 'all_received',
      noReplacementPartsNeeded: true,
      confidence: 'high',
    },
    {
      type: 'add_note',
      roNumber,
      note: 'No replacement parts needed for this repair.',
      confidence: 'high',
    },
  ]
}

function normalizeRejectedPartsActions(rawActions = [], inputText = '') {
  const text = String(inputText || '')
  if (!/\b(reject|rejected|wrong|incorrect|exchange|return)\b/i.test(text)) return rawActions

  return rawActions.flatMap(action => {
    if (action.type !== 'log_parts_received') return [action]
    const matchingReturn = rawActions.find(other =>
      other.type === 'log_parts_return'
      && String(other.roNumber ?? '') === String(action.roNumber ?? '')
      && actionVendorsMatch(action, other)
      && (
        other.needsReplacement
        || /\b(exchange|wrong|incorrect|reject|rejected)\b/i.test(`${other.reason ?? ''} ${other.notes ?? ''} ${other.description ?? ''}`)
      )
    )
    if (!matchingReturn) return [action]

    const receivedQty = numericQty(action.qtyReceived ?? action.receivedQty, 0)
    const rejectedQty = numericQty(matchingReturn.qty ?? matchingReturn.quantity, 1)
    const shipmentQty = numericQty(action.totalQty ?? action.qty, 0)
    const actionText = `${action.note ?? ''} ${action.notes ?? ''} ${action.description ?? ''}`
    const alreadyUsableQty = /\b(usable|accepted|good)\b/i.test(actionText)
      || (shipmentQty > 0 && receivedQty + rejectedQty <= shipmentQty)

    if (alreadyUsableQty) return [action]
    if (receivedQty <= rejectedQty) return []

    return [{
      ...action,
      qtyReceived: receivedQty - rejectedQty,
      receivedQty: receivedQty - rejectedQty,
      note: action.note || `${rejectedQty} rejected for exchange; not counted as usable received.`,
    }]
  })
}

function inputUsesFinalReceivedCount(inputText = '') {
  const text = String(inputText || '').toLowerCase()
  return /\b(received|recieved|rcvd)\s+\d+\s*\/\s*\d+\b/i.test(text)
    || /\b\d+\s*\/\s*\d+\s*(received|recieved|rcvd)\b/i.test(text)
    || /\b(received|recieved|rcvd)\s+all\b/i.test(text)
}

function normalizePartsReceivedIncrements(rawActions = [], inputText = '', ros = []) {
  const useFinalCount = inputUsesFinalReceivedCount(inputText)
  return rawActions.map(action => {
    if (action.type !== 'log_parts_received') return action
    const roDoc = findRoForAction(ros, action)
    const orders = Array.isArray(roDoc?.partsOrders) ? roDoc.partsOrders : []
    const order = orders.find(item => orderMatchesVendor(item, action.vendor, action.vendorFull))
    if (!order) return action

    const currentReceived = numericQty(order.qtyReceived ?? order.receivedQty, 0)
    const orderQty = numericQty(order.qty ?? order.quantity, numericQty(action.totalQty ?? action.qty, 0))
    const actionReceived = numericQty(action.qtyReceived ?? action.receivedQty, 0)
    if (!actionReceived) return action

    const nextReceived = useFinalCount
      ? actionReceived
      : Math.min(orderQty || currentReceived + actionReceived, currentReceived + actionReceived)

    return {
      ...action,
      receiveMode: useFinalCount ? 'set' : 'increment',
      currentQtyReceived: currentReceived,
      nextQtyReceived: nextReceived,
      totalQty: orderQty || (action.totalQty ?? action.qty),
    }
  })
}

function dedupePartsOrderActions(rawActions = []) {
  const bestByKey = new Map()
  const output = []

  for (const action of rawActions) {
    if (action.type !== 'update_parts_order') {
      output.push(action)
      continue
    }

    const vendorKey = normalizeVendorName(action.vendorFull || action.vendor).replace(/\s+/g, '')
    const key = `${action.roId || action.roNumber || ''}:${vendorKey}`
    if (!vendorKey) {
      output.push(action)
      continue
    }

    const existingIndex = bestByKey.get(key)
    if (existingIndex === undefined) {
      bestByKey.set(key, output.length)
      output.push(action)
      continue
    }

    output[existingIndex] = mergePreferredPartsOrderActions(output[existingIndex], action)
  }

  return output
}

function removePartsOrdersCoveredByReceipts(rawActions = []) {
  const actions = rawActions.map(action => ({ ...action, type: action.type ?? action.action }))
  const receiptActions = actions.filter(action =>
    action.type === 'log_parts_received'
    && (action.vendor || action.vendorFull)
    && numericQty(action.qtyReceived ?? action.receivedQty ?? action.nextQtyReceived, 0) > 0
  )
  if (!receiptActions.length) return actions

  return actions.filter(action => {
    if (action.type !== 'update_parts_order') return true
    return !receiptActions.some(receipt =>
      String(receipt.roId || receipt.roNumber || '') === String(action.roId || action.roNumber || '')
      && (actionVendorsMatch(action, receipt) || actionVendorsMatchIgnoringParsingMetadata(action, receipt))
    )
  })
}

function shouldHideResolvedBodyTechClarification(clarification = '', resultActions = [], inputText = '', ros = [], employees = []) {
  if (!clarification) return false
  if (!/body technician|body tech|bodyman|body man|defaulted/i.test(clarification)) return false
  return resultActions.some(rawAction => {
    const action = { ...rawAction, type: rawAction.type ?? rawAction.action }
    const roDoc = findRoForAction(ros, action)
    const existingBodyTech = resolveBodyTech(roDoc, employees)
    if (!existingBodyTech.uid && !existingBodyTech.name) return false
    if (!action.assigneeName) return true
    const scopedInput = scopedInputForRo(inputText, action.roNumber || roDoc?.roNumber, resultActions, ros)
    return normalizeName(action.assigneeName) !== normalizeName(existingBodyTech.name)
      && !inputExplicitlyMentionsAssignee(scopedInput, action.assigneeName)
  })
}

function normalizeBodyWorkflowActionsForScope(rawActions = [], inputText = '', ros = [], employees = [], scopedRoNumber = '') {
  const baseActions = normalizeReceivedFromNoteActions(
    normalizeWaitingPartsOrderActions(
      normalizeReceivedAllFromVendorActions(
        normalizeReceivedAllExceptActions(
          normalizeNoReplacementPartsActions(
            rawActions.map(action => ({ ...action, type: action.type ?? action.action })),
            inputText,
            ros,
            scopedRoNumber,
          ),
          inputText,
          ros,
          scopedRoNumber,
        ),
        inputText,
        ros,
        scopedRoNumber,
      ),
      inputText,
      ros,
      scopedRoNumber,
    ),
    ros,
  )
  const partsNormalizedActions = dedupePartsOrderActions(removePartsOrdersCoveredByReceipts(
    normalizePartsReceivedIncrements(
      normalizeRejectedPartsActions(
        baseActions,
        inputText,
      ),
      inputText,
      ros,
    )
  ))
  const actions = normalizeBodyAssigneeDefaults(
    partsNormalizedActions,
    inputText,
    ros,
    employees,
  )
  const normalized = actions.map(action => {
    if (action.type !== 'assign_task' || isExplicitPrimaryBodyTaskAction(action)) return action
    const roActionText = `${sameRoActionText(actions, action.roNumber)} ${inputText}`
    const phase = bodyPhaseFromActionsForRo(actions, action.roNumber, inputText)
    if (!phase || !looksLikeSecondaryBodyTaskStrict(action, roActionText)) return action
    const detail = taskTitleFromAction(action, '').trim()
    return {
      ...action,
      title: inferSecondaryBodyTaskTitle(detail || action.description || ''),
      description: action.description || detail,
      phase,
      taskKind: 'secondary',
      parentPhase: phase,
      category: 'body',
    }
  })

  const extras = []
  const addPrimaryTaskIfMissing = ({ roNumber, roId, assigneeName, assigneeUid = '', phase, priority = 'medium', autoReason = 'status' }) => {
    if (!phase || (!assigneeName && !assigneeUid)) return
    const alreadyHasPrimary = normalized.concat(extras).some(other =>
      other.type === 'assign_task'
      && String(other.roNumber ?? '') === String(roNumber ?? '')
      && (
        (assigneeUid && other.assigneeUid === assigneeUid)
        || normalizeName(other.assigneeName) === normalizeName(assigneeName)
      )
      && isExplicitPrimaryBodyTaskAction(other)
    )
    if (alreadyHasPrimary) return
    extras.push({
      type: 'assign_task',
      roNumber,
      roId,
      assigneeName,
      assigneeUid,
      title: bodyPhaseTitle(phase),
      description: '',
      priority,
      phase,
      category: 'body',
      taskKind: 'primary',
      autoGenerated: true,
      autoReason,
    })
  }

  for (const action of normalized) {
    if (action.type !== 'assign_body_man') continue
    const phase = bodyPhaseFromActionsForRo(normalized, action.roNumber, inputText)
    if (!phase) continue
    addPrimaryTaskIfMissing({
      roNumber: action.roNumber,
      roId: action.roId,
      assigneeName: action.assigneeName,
      assigneeUid: action.assigneeUid || findEmployeeByName(employees, action.assigneeName, 'body_man')?.uid || '',
      phase,
      priority: action.priority || 'medium',
      autoReason: 'assign_body_man',
    })
  }

  for (const action of normalized) {
    if (!['update_status', 'complete_phase'].includes(action.type)) continue
    const phase = bodyPhaseFromText(`${action.status ?? ''} ${action.phase ?? ''}`)
    if (!phase) continue
    const roDoc = ros.find(ro => ro.id === action.roId || String(ro.roNumber ?? '') === String(action.roNumber ?? ''))
    const bodyTech = resolveBodyTech(roDoc, employees)
    addPrimaryTaskIfMissing({
      roNumber: action.roNumber || roDoc?.roNumber,
      roId: action.roId || roDoc?.id,
      assigneeName: bodyTech.name,
      assigneeUid: bodyTech.uid,
      phase,
      priority: action.priority || 'medium',
      autoReason: 'status_change',
    })
  }
  return [...normalized, ...extras]
}

function normalizeBodyWorkflowActions(rawActions = [], inputText = '', ros = [], employees = []) {
  return normalizeActionsPerRoScope(rawActions, inputText, ros, (scopedActions, scopedText, scopedRoNumber) => (
    normalizeBodyWorkflowActionsForScope(scopedActions, scopedText, ros, employees, scopedRoNumber)
  ))
}

function paintReadyStatusForRo(roDoc) {
  const current = roDoc?.status || ''
  if (['checked_in', 'teardown', 'waiting_parts', 'body_work', 'body_complete'].includes(current)) return 'paint_prep'
  return ''
}

function looksLikePrimaryPaintAction(action = {}, inputText = '') {
  const text = `${inputText} ${action.title || ''} ${action.description || ''} ${action.phase || ''} ${action.status || ''}`.toLowerCase()
  return /\b(prep\s*(?:&|and)?\s*paint|paint\s*prep|ready\s*(?:for|to).*paint|paint\s*complete|in\s*paint|reassy|reassembly)\b/i.test(text)
}

function paintSecondaryPhase(action = {}, inputText = '') {
  const text = `${inputText} ${action.title || ''} ${action.description || ''} ${action.phase || ''}`.toLowerCase()
  if (/\b(mask|masking|sand|sanding|tape|taping|cover|prep|primer|prime|scuff|edge|clean)\b/i.test(text)) return 'paint_prep'
  if (/\b(color\s*match|colour\s*match|blend|spray|paint|booth|clear|clearcoat|refinish)\b/i.test(text)) return 'paint'
  return 'paint_prep'
}

function normalizePaintWorkflowActionsForScope(rawActions = [], inputText = '', ros = [], employees = []) {
  const actions = rawActions.map(action => ({ ...action, type: action.type ?? action.action }))
  const extras = []

  const addPaintPrimaries = (roDoc) => {
    if (!roDoc?.id) return
    const paintTeam = {
      painter: employees.find(e => e.role === 'painter'),
      helper: employees.find(e => e.role === 'paint_helper'),
    }
    extras.push({
      type: 'assign_task',
      roId: roDoc.id,
      roNumber: roDoc.roNumber,
      assigneeName: paintTeam.helper?.name || 'Paint Helper',
      assigneeUid: paintTeam.helper?.uid || '',
      title: 'Paint Prep',
      phase: 'paint_prep',
      category: 'paint',
      taskKind: 'primary',
      autoGenerated: true,
      autoReason: 'paint_ready',
    })
    extras.push({
      type: 'assign_task',
      roId: roDoc.id,
      roNumber: roDoc.roNumber,
      assigneeName: paintTeam.painter?.name || 'Painter',
      assigneeUid: paintTeam.painter?.uid || '',
      title: 'Paint',
      phase: 'paint',
      category: 'paint',
      taskKind: 'primary',
      autoGenerated: true,
      autoReason: 'paint_ready',
    })
  }

  for (const action of actions) {
    const roDoc = findRoForAction(ros, action)
    if (!roDoc) continue
    if (action.type === 'assign_painter') addPaintPrimaries(roDoc)
    if (action.type === 'assign_task') {
      const assignee = action.assigneeUid
        ? findEmployeeByUid(employees, action.assigneeUid)
        : findEmployeeByName(employees, action.assigneeName)
      if (assignee?.role === 'painter' || assignee?.role === 'paint_helper') {
        addPaintPrimaries(roDoc)
        if (looksLikePrimaryPaintAction(action, inputText)) {
          continue
        }
        action.phase = paintSecondaryPhase(action, inputText)
        action.category = 'paint'
        action.taskKind = 'secondary'
        action.parentPhase = action.phase
      }
    }
    if (action.type === 'update_status' && ['paint_prep', 'in_paint', 'paint_complete', 'reassembly'].includes(action.status)) {
      addPaintPrimaries(roDoc)
    }
  }

  for (const roDoc of ros) {
    if (!sameRoActionText(actions, roDoc.roNumber)) continue
    if (!looksLikePrimaryPaintAction({}, inputText)) continue
    addPaintPrimaries(roDoc)
    const nextStatus = paintReadyStatusForRo(roDoc)
    if (nextStatus && !actions.some(action => action.type === 'update_status' && String(action.roNumber ?? '') === String(roDoc.roNumber ?? ''))) {
      extras.push({ type: 'update_status', roId: roDoc.id, roNumber: roDoc.roNumber, status: nextStatus, autoGenerated: true, autoReason: 'paint_ready' })
    }
  }

  const seen = new Set()
  return [...actions, ...extras].filter(action => {
    let actionIdentity = `${action.phase || action.status || ''}:${action.taskKind || ''}`
    if (action.type === 'update_parts_order') {
      actionIdentity = `${normalizeVendorName(action.vendorFull || action.vendor).replace(/\s+/g, '')}:${action.description || ''}:${action.eta || ''}`
    } else if (action.type === 'log_parts_received') {
      actionIdentity = `${normalizeVendorName(action.vendorFull || action.vendor).replace(/\s+/g, '')}:${action.qtyReceived ?? action.receivedQty ?? ''}:${action.totalQty ?? action.qty ?? ''}`
    } else if (action.type === 'log_parts_return') {
      actionIdentity = `${normalizeVendorName(action.vendorFull || action.vendor).replace(/\s+/g, '')}:${action.qty ?? action.quantity ?? ''}:${action.reason || action.description || ''}`
    }
    const key = `${action.type}:${action.roId || action.roNumber}:${actionIdentity}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizePaintWorkflowActions(rawActions = [], inputText = '', ros = [], employees = []) {
  return normalizeActionsPerRoScope(rawActions, inputText, ros, (scopedActions, scopedText) => (
    normalizePaintWorkflowActionsForScope(scopedActions, scopedText, ros, employees)
  ))
}

function impliedCompletedPhasesForStatus(status) {
  const map = {
    paint_prep: ['body'],
    in_paint: ['body', 'paint_prep'],
    paint_complete: ['body', 'paint_prep', 'paint'],
    reassembly: ['body', 'paint_prep', 'paint'],
  }
  return map[status] || []
}

function completePhaseTasksPromise(roId, phase) {
  const PHASE_CATEGORY = { teardown: 'body', body: 'body', paint_prep: 'paint', paint: 'paint', reassembly: 'body', sublet: 'sublet', detail: 'detail' }
  const PHASE_TITLE_RE = { teardown: /teardown/i, body: /body work|repair/i, paint_prep: /paint.?prep|prep/i, paint: /paint/i, reassembly: /reassembl/i, sublet: /sublet/i, detail: /detail|qc/i }
  return getDocs(query(collection(db, 'tasks'), where('roId', '==', roId), where('phase', '==', phase)))
    .then(async snap => {
      let pending = snap.docs.filter(d => d.data().status !== 'completed')
      if (pending.length === 0) {
        const cat = PHASE_CATEGORY[phase]
        const re = PHASE_TITLE_RE[phase]
        if (cat) {
          const fallback = await getDocs(query(collection(db, 'tasks'), where('roId', '==', roId), where('category', '==', cat)))
          pending = fallback.docs.filter(d => {
            const data = d.data()
            return data.status !== 'completed' && (!re || re.test(data.title ?? ''))
          })
        }
      }
      return Promise.all(pending.map(d => updateDoc(doc(db, 'tasks', d.id), {
        status: 'completed',
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })))
    })
}

function mentionsAuthorization(text = '') {
  return /\b(authori[sz]ed|approved|approval|customer\s+approved|insurance\s+approved|auth\s+(ok|approved|done))\b/i.test(text)
}

function effectivePartsStatus(roDoc, entry) {
  return entry.fields.partsStatus || calculatePartsStatus(currentPartsOrders(roDoc, entry), roDoc.partsStatus)
}

function partsAreActionable(status) {
  return ['ordered', 'partially_received', 'all_received'].includes(status)
}

function prependRoNote(entry, roDoc, line) {
  const prev = entry.fields.notes ?? roDoc.notes ?? ''
  entry.fields.notes = prev ? `${line}\n${prev}` : line
}

function getPathValue(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

// ── Photo-type keyword detection (no AI needed) ───────────────────────────────
const PHOTO_TYPES = [
  { keys: ['check in','checkin','check-in',' ci ','c/i','ci photo','check in photo'], label: 'Check-In',   slug: 'check_in'   },
  { keys: ['in progress','inprogress','in-progress',' ip ','i/p','ip photo'],         label: 'In Progress', slug: 'in_progress' },
  { keys: ['paint'],                                                                   label: 'Paint',       slug: 'paint'       },
  { keys: ['repair'],                                                                  label: 'Repair',      slug: 'repair'      },
  { keys: ['complete','finished','done','final'],                                      label: 'Complete',    slug: 'complete'    },
  { keys: ['damage','dmg'],                                                            label: 'Damage',      slug: 'damage'      },
  { keys: ['deliver','delivery','pickup','pick up','pick-up'],                         label: 'Delivery',    slug: 'delivery'    },
  { keys: ['supplement','supp'],                                                       label: 'Supplement',  slug: 'supplement'  },
  { keys: ['part','parts'],                                                            label: 'Parts',       slug: 'parts'       },
]

function detectPhotoType(text) {
  const t = text.toLowerCase()
  for (const pt of PHOTO_TYPES) {
    if (pt.keys.some(k => t.includes(k))) return pt
  }
  return { label: 'Photo', slug: 'photo' }
}

function extractRoNumber(text, ros) {
  // Matches: 9556 / RO9556 / RO#9556 / #9556 — 4–6 digits
  const matches = [...text.matchAll(/(?:ro#?|#)?(\d{4,6})/gi)]
  for (const m of matches) {
    if (ros.find(r => r.roNumber === m[1])) return m[1]
  }
  return null
}

const ACTION_LABELS = {
  add_note:            { label: 'Add Note',        color: 'bg-blue-50   border-blue-200   dark:bg-blue-950/35   dark:border-blue-800/80' },
  update_status:       { label: 'Update Status',   color: 'bg-purple-50 border-purple-200 dark:bg-purple-950/35 dark:border-purple-800/80' },
  update_parts_status: { label: 'Parts Status',    color: 'bg-amber-50  border-amber-200  dark:bg-amber-950/35  dark:border-amber-800/80' },
  assign_task:         { label: 'Assign Task',     color: 'bg-green-50  border-green-200  dark:bg-green-950/35  dark:border-green-800/80' },
  assign_body_man:     { label: 'Set Body Tech',  color: 'bg-blue-50   border-blue-200   dark:bg-blue-950/35   dark:border-blue-800/80' },
  assign_painter:      { label: 'Set Painter',    color: 'bg-purple-50 border-purple-200 dark:bg-purple-950/35 dark:border-purple-800/80' },
  update_car_status:   { label: 'Car Status',      color: 'bg-orange-50 border-orange-200 dark:bg-orange-950/35 dark:border-orange-800/80' },
  update_dropoff_date: { label: 'Drop-Off Date',   color: 'bg-cyan-50   border-cyan-200   dark:bg-cyan-950/35   dark:border-cyan-800/80' },
  update_due_date:     { label: 'Target Date',     color: 'bg-rose-50   border-rose-200   dark:bg-rose-950/35   dark:border-rose-800/80' },
  update_rental:       { label: 'Rental Status',   color: 'bg-gray-50   border-gray-200   dark:bg-zinc-800/95   dark:border-zinc-600' },
  complete_phase:      { label: 'Complete Phase',  color: 'bg-green-50  border-green-200  dark:bg-green-950/35  dark:border-green-800/80' },
  update_parts_order:  { label: 'Parts Order',     color: 'bg-blue-50   border-blue-200   dark:bg-blue-950/35   dark:border-blue-800/80' },
  log_parts_received:  { label: 'Parts Received',  color: 'bg-green-50  border-green-200  dark:bg-green-950/35  dark:border-green-800/80' },
  log_parts_return:    { label: 'Parts Return',    color: 'bg-red-50    border-red-200    dark:bg-red-950/35    dark:border-red-800/80' },
}

const ACTION_FIELD = 'border border-gray-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600'
const GIB_HISTORY_KEY = 'autobody.gib.history.v1'

// ── Inline-editable action card ───────────────────────────────────────────────
function EditableActionCard({ action, onChange, onDelete, employees, ros }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(action)

  // Keep draft in sync with parent action whenever not actively editing
  useEffect(() => { if (!editing) setDraft(action) }, [action])  // eslint-disable-line react-hooks/exhaustive-deps

  const meta = ACTION_LABELS[draft.type] ?? { icon: '•', label: draft.type, color: 'bg-gray-50 border-gray-200' }

  const save = () => { onChange(draft); setEditing(false) }
  const set  = (patch) => setDraft(prev => ({ ...prev, ...patch }))

  // ── Edit form ──────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="border-2 border-blue-400 rounded-xl p-3 bg-white dark:bg-zinc-900 space-y-2 text-sm">
        <div className="flex items-center gap-2 mb-1">
          <span>{meta.icon}</span>
          <span className="font-semibold text-blue-700 dark:text-blue-300">{draft.roNumber ? `RO#${draft.roNumber}` : 'No RO'}</span>
          <span className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide">{meta.label}</span>
        </div>

        {/* RO number */}
        <label className="block text-xs text-gray-500 dark:text-zinc-400">RO #
          <input
            className={`ml-2 px-2 py-0.5 text-xs w-24 font-mono ${ACTION_FIELD}`}
            value={draft.roNumber ?? ''}
            onChange={e => set({ roNumber: e.target.value })}
          />
        </label>

        {/* Per-type fields */}
        {draft.type === 'add_note' && (
          <textarea
            className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`}
            rows={3}
            value={draft.note ?? ''}
            onChange={e => set({ note: e.target.value })}
          />
        )}

        {draft.type === 'update_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.status ?? ''}
            onChange={e => set({ status: e.target.value })}
          >
            {RO_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_parts_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.partsStatus ?? ''}
            onChange={e => set({ partsStatus: e.target.value })}
          >
            {PARTS_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_parts_order' && (
          <div className="space-y-1.5">
            <input className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Vendor" value={draft.vendor ?? ''} onChange={e => set({ vendor: e.target.value })} />
            <input className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Vendor full name" value={draft.vendorFull ?? ''} onChange={e => set({ vendorFull: e.target.value })} />
            <textarea className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`} rows={2} placeholder="Description" value={draft.description ?? ''} onChange={e => set({ description: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min="1" className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Qty" value={draft.qty ?? draft.quantity ?? ''} onChange={e => set({ qty: e.target.value })} />
              <input type="date" className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`} value={draft.eta ?? ''} onChange={e => set({ eta: e.target.value })} />
            </div>
          </div>
        )}

        {draft.type === 'log_parts_received' && (
          <div className="space-y-1.5">
            <input className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Vendor" value={draft.vendor ?? ''} onChange={e => set({ vendor: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min="0" className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Received" value={draft.qtyReceived ?? draft.receivedQty ?? ''} onChange={e => set({ qtyReceived: e.target.value })} />
              <input type="number" min="1" className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Total" value={draft.totalQty ?? ''} onChange={e => set({ totalQty: e.target.value })} />
            </div>
            <input className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Note" value={draft.note ?? ''} onChange={e => set({ note: e.target.value })} />
          </div>
        )}

        {draft.type === 'log_parts_return' && (
          <div className="space-y-1.5">
            <input className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Vendor" value={draft.vendor ?? ''} onChange={e => set({ vendor: e.target.value })} />
            <textarea className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`} rows={2} placeholder="Reason / notes" value={draft.reason ?? draft.description ?? ''} onChange={e => set({ reason: e.target.value })} />
            <input type="number" min="1" className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`} placeholder="Qty" value={draft.qty ?? draft.quantity ?? ''} onChange={e => set({ qty: e.target.value })} />
          </div>
        )}

        {draft.type === 'update_car_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.carStatus ?? ''}
            onChange={e => set({ carStatus: e.target.value })}
          >
            {CAR_STATUSES.map(s => <option key={s.key} value={s.key}>{s.icon} {s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_dropoff_date' && (
          <input
            type="date"
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.dropOffDate ?? ''}
            onChange={e => set({ dropOffDate: e.target.value })}
          />
        )}

        {draft.type === 'update_due_date' && (
          <input
            type="date"
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.dueDate ?? ''}
            onChange={e => set({ dueDate: e.target.value })}
          />
        )}

        {draft.type === 'update_rental' && (
          <select
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.hasRental === true ? 'yes' : draft.hasRental === false ? 'no' : ''}
            onChange={e => set({ hasRental: e.target.value === 'yes' ? true : false })}
          >
            <option value="no">No rental</option>
            <option value="yes">Customer has rental</option>
          </select>
        )}

        {draft.type === 'assign_task' && (
          <div className="space-y-1.5">
            <input
              className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              placeholder="Assignee name"
              value={draft.assigneeName ?? ''}
              onChange={e => set({ assigneeName: e.target.value })}
            />
            <input
              className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              placeholder="Task title"
              value={draft.title ?? ''}
              onChange={e => set({ title: e.target.value })}
            />
            <textarea
              className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`}
              rows={2}
              placeholder="Description (optional)"
              value={draft.description ?? ''}
              onChange={e => set({ description: e.target.value })}
            />
            <select
              className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              value={draft.priority ?? 'medium'}
              onChange={e => set({ priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={save}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg"
          >Done</button>
          <button
            onClick={() => { setDraft(action); setEditing(false) }}
            className="px-3 py-1 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-xs rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
          >Cancel</button>
        </div>
      </div>
    )
  }

  // ── Duplicate detection for update_dropoff_date ────────────────────────────
  const dropoffDupStatus = (() => {
    if (draft.type !== 'update_dropoff_date') return null
    const roDoc = ros?.find(r => r.roNumber === draft.roNumber)
    if (!roDoc?.dropOffDate) return null
    return roDoc.dropOffDate === draft.dropOffDate ? 'same' : 'different'
  })()

  // ── Preview (read mode) ────────────────────────────────────────────────────
  const detail = () => {
    switch (draft.type) {
      case 'add_note':            return <span className="text-gray-700 dark:text-zinc-200">"{draft.note}"</span>
      case 'update_status':       return <span className="text-purple-700 dark:text-purple-300 font-medium">{STATUS_MAP[draft.status]?.label ?? draft.status}</span>
      case 'update_parts_status': return (
        <span className="text-yellow-700 dark:text-amber-300 font-medium">
          {draft.noReplacementPartsNeeded ? 'No Repl Parts Needed' : PARTS_STATUSES.find(p => p.key === draft.partsStatus)?.label ?? draft.partsStatus}
        </span>
      )
      case 'update_parts_order':
        return <span className="text-gray-700 dark:text-zinc-200"><strong>{draft.vendor}</strong>: {draft.description || 'Parts order'} ({draft.qty ?? draft.quantity ?? '?'} pc{Number(draft.qty ?? draft.quantity) === 1 ? '' : 's'}{draft.eta ? `, ETA ${draft.eta}` : ''})</span>
      case 'log_parts_received': {
        const etaSuffix = draft.eta ? `, ETA ${fmtShortDate(draft.eta)}` : ''
        if (draft.receiveMode === 'increment' && numericQty(draft.currentQtyReceived, 0)) {
          return <span className="text-gray-700 dark:text-zinc-200"><strong>{draft.vendor}</strong>: add {draft.qtyReceived ?? draft.receivedQty ?? '?'} received ({draft.currentQtyReceived}/{draft.totalQty ?? draft.qty ?? '?'} -&gt; {draft.nextQtyReceived}/{draft.totalQty ?? draft.qty ?? '?'}){etaSuffix}{draft.note ? ` - ${draft.note}` : ''}</span>
        }
        return <span className="text-gray-700 dark:text-zinc-200"><strong>{draft.vendor}</strong>: received {draft.nextQtyReceived ?? draft.qtyReceived ?? draft.receivedQty ?? '?'} / {draft.totalQty ?? draft.qty ?? '?'}{etaSuffix}{draft.note ? ` - ${draft.note}` : ''}</span>
      }
      case 'log_parts_return':
        return <span className="text-gray-700 dark:text-zinc-200"><strong>{draft.vendor}</strong>: return {draft.qty ?? draft.quantity ?? 1} pc{Number(draft.qty ?? draft.quantity) === 1 ? '' : 's'} - {draft.reason || draft.description || 'Return part'}</span>
      case 'update_car_status':   return <span className="text-gray-800 dark:text-zinc-100"><strong>{CAR_STATUS_MAP[draft.carStatus]?.label ?? draft.carStatus}</strong></span>
      case 'update_dropoff_date': return <span className="text-gray-700 dark:text-zinc-200">Drop Off: <strong className="text-gray-900 dark:text-white">{draft.dropOffDate}</strong></span>
      case 'update_due_date':     return <span className="text-gray-700 dark:text-zinc-200">ETA: <strong className="text-gray-900 dark:text-white">{draft.dueDate}</strong></span>
      case 'update_rental':       return <span className="text-gray-800 dark:text-zinc-100">{draft.hasRental ? 'Customer has rental' : 'No rental'}</span>
      case 'complete_phase': {
        const PHASE_LABELS = { checkin: 'Check-In', teardown: 'Teardown', body: 'Body Work', paint_prep: 'Paint Prep', paint: 'Paint', reassembly: 'Reassembly', sublet: 'Sublet / Calibration', detail: 'QC / Detail' }
        return <span className="text-green-700 dark:text-green-300 font-medium">✅ {PHASE_LABELS[draft.phase] ?? draft.phase} complete → auto-advance RO status</span>
      }
      case 'assign_task':
        return (
          <span>
            <span className="text-gray-700 dark:text-zinc-200">→ <strong className="text-gray-900 dark:text-white">{draft.assigneeName}</strong>: "{draft.title}"</span>
            <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded font-medium ${
              draft.priority === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
              : draft.priority === 'low' ? 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300'
              : 'bg-yellow-100 text-yellow-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>{draft.priority}</span>
          </span>
        )
      default: return null
    }
  }

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm shadow-sm dark:shadow-none ${meta.color}`}>
      <span className="shrink-0 mt-0.5">{meta.icon}</span>
      <div className="flex-1 min-w-0">
            <span className="font-semibold text-gray-800 dark:text-zinc-100">{draft.roNumber ? `RO#${draft.roNumber}` : 'No RO'}</span>
        <span className="text-gray-400 dark:text-zinc-500 mx-1.5">·</span>
        <span className="text-xs font-semibold text-gray-600 dark:text-zinc-300 uppercase tracking-wide">{meta.label}</span>
        {dropoffDupStatus === 'same' && (
          <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 font-semibold" title="Drop-off date already recorded — will skip field update, any note will still apply">
            Duplicate — date already set
          </span>
        )}
        <div className="text-sm mt-0.5">{detail()}</div>
      </div>
      {draft.confidence === 'low' && (
        <span className="text-xs text-orange-500 shrink-0 mt-0.5" title="Low confidence – please verify">⚠</span>
      )}
      {/* Edit / Delete buttons */}
      <div className="flex items-center gap-1 shrink-0 ml-1">
        <button
          onClick={() => setEditing(true)}
          className="text-gray-500 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-300 text-xs px-1.5 py-0.5 rounded hover:bg-white/70 dark:hover:bg-zinc-700 transition-colors"
          title="Edit"
        >✏️</button>
        <button
          onClick={onDelete}
          className="text-gray-500 dark:text-zinc-300 hover:text-red-500 dark:hover:text-red-300 text-xs px-1.5 py-0.5 rounded hover:bg-white/70 dark:hover:bg-zinc-700 transition-colors"
          title="Remove"
        >×</button>
      </div>
    </div>
  )
}

function actionMissingFields(action) {
  switch (action.type) {
    case 'update_parts_order': {
      const missing = []
      if (!action.vendor) missing.push('vendor')
      if (!numericQty(action.qty ?? action.quantity, 0)) missing.push('qty')
      if (!action.eta) missing.push('ETA')
      return missing
    }
    case 'log_parts_received': {
      const missing = []
      if (!action.vendor) missing.push('vendor')
      if (!numericQty(action.qtyReceived ?? action.receivedQty, 0)) missing.push('received qty')
      if (!numericQty(action.totalQty ?? action.qty, 0)) missing.push('total qty')
      return missing
    }
    case 'assign_task': {
      const missing = []
      if (!action.assigneeName) missing.push('assignee')
      if (!taskTitleFromAction(action, '')) missing.push('title')
      return missing
    }
    case 'add_note':
      return action.note ? [] : ['note']
    case 'update_status':
      return action.status ? [] : ['status']
    case 'update_due_date':
      return action.dueDate ? [] : ['date']
    default:
      return []
  }
}

function actionSummary(action) {
  const meta = ACTION_LABELS[action.type] ?? { label: action.type }
  switch (action.type) {
    case 'add_note':
      return `Note: ${action.note || 'Missing note'}`
    case 'update_status':
      return `Status -> ${STATUS_MAP[action.status]?.label ?? action.status ?? 'Missing'}`
      case 'update_parts_status':
      return action.noReplacementPartsNeeded
        ? 'No Repl Parts Needed'
        : `Parts status -> ${PARTS_STATUSES.find(p => p.key === action.partsStatus)?.label ?? action.partsStatus ?? 'Missing'}`
    case 'update_parts_order':
      return `Order parts from ${action.vendor || 'Missing vendor'} (${action.qty ?? action.quantity ?? 'Missing qty'} pcs, ETA ${action.eta || 'Missing'})`
    case 'log_parts_received':
      return `Received ${action.qtyReceived ?? action.receivedQty ?? 'Missing'} / ${action.totalQty ?? action.qty ?? 'Missing'} from ${action.vendor || 'Missing vendor'}`
    case 'log_parts_return':
      return `Return ${action.qty ?? action.quantity ?? 1} pcs to ${action.vendor || 'Missing vendor'}`
    case 'assign_task': {
      if (isExplicitPrimaryBodyTaskAction(action)) {
        const core = bodyTaskCore(action)
        return `Task for ${action.assigneeName || 'Missing assignee'}: ${core.title}${core.description ? ` + subtask: ${core.description}` : ''}`
      }
      return `Task for ${action.assigneeName || 'Missing assignee'}: ${taskTitleFromAction(action, 'Missing title')}`
    }
    case 'assign_body_man':
      return `Set body tech: ${action.assigneeName || 'Missing assignee'}`
    case 'assign_painter':
      return `Set painter: ${action.assigneeName || 'Missing assignee'}`
    case 'update_car_status':
      return `Car status -> ${CAR_STATUS_MAP[action.carStatus]?.label ?? action.carStatus ?? 'Missing'}`
    case 'update_dropoff_date':
      return `Drop-off date -> ${action.dropOffDate || 'Missing'}`
    case 'update_due_date':
      return `Target date -> ${action.dueDate || 'Missing'}`
    case 'update_rental':
      return action.hasRental ? 'Rental: yes' : 'Rental: no'
    case 'complete_phase':
      return `Complete phase: ${action.phase || 'Missing phase'}`
    default:
      return meta.label
  }
}

function groupActionsForPreview(actions, ros) {
  const groups = new Map()
  actions.forEach((action, index) => {
    const roDoc = ros.find(r => r.id === action.roId || r.roNumber === action.roNumber)
    const key = roDoc?.id || (action.roNumber ? `ro-${action.roNumber}` : 'standalone')
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        roNumber: roDoc?.roNumber || action.roNumber || null,
        vehicle: roDoc?.vehicle || '',
        standalone: !roDoc && !action.roNumber,
        items: [],
      })
    }
    groups.get(key).items.push({ action, index, missing: actionMissingFields(action) })
  })
  return [...groups.values()]
}

function ActionReviewGroup({ group, employees, ros, onChangeAt, onDeleteAt }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-900/80">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
            {group.standalone ? 'Standalone Task' : `RO#${group.roNumber || 'Unknown'}`}
          </p>
          {group.vehicle && <p className="truncate text-xs text-gray-500 dark:text-zinc-400">{group.vehicle}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500 dark:bg-zinc-800 dark:text-zinc-300">
          {group.items.length} action{group.items.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-2 p-2.5">
        {group.items.map(({ action, index, missing }) => (
          <div key={`${index}-${action.type}`} className="space-y-1">
            <div className="flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-2 text-xs dark:bg-zinc-950/50">
              <span className="mt-0.5 rounded bg-white px-1.5 py-0.5 font-semibold text-gray-500 dark:bg-zinc-800 dark:text-zinc-300">
                {ACTION_LABELS[action.type]?.label ?? action.type}
              </span>
              <p className="min-w-0 flex-1 text-gray-700 dark:text-zinc-200">{actionSummary(action)}</p>
              {action.confidence === 'low' && (
                <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                  Review
                </span>
              )}
            </div>
            {missing.length > 0 && (
              <div className="ml-1 flex flex-wrap gap-1.5">
                {missing.map(field => (
                  <span key={field} className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    Missing {field}
                  </span>
                ))}
              </div>
            )}
            <EditableActionCard
              action={action}
              employees={employees}
              ros={ros}
              onChange={(updated) => onChangeAt(index, updated)}
              onDelete={() => onDeleteAt(index)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Photo source picker (2 options only) ─────────────────────────────────────
function PhotoSheet({ onCamera, onLibrary, onClose }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9000] flex flex-col justify-end"
      style={{ background: 'rgba(0,0,0,0.45)' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-zinc-900 rounded-t-2xl overflow-hidden pb-safe"
      >
        {/* Title bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-zinc-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Photo</span>
          <button onClick={onClose} className="text-blue-500 text-sm font-medium">Cancel</button>
        </div>
        {/* Camera option */}
        <button
          onClick={onCamera}
          className="w-full flex items-center gap-4 px-5 py-4 border-b border-gray-100 dark:border-zinc-800 active:bg-gray-50 dark:active:bg-zinc-800 transition-colors"
        >
          <span className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-700 dark:text-gray-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
              <circle cx="12" cy="13" r="3"/>
            </svg>
          </span>
          <div className="text-left">
            <p className="text-[15px] font-medium text-gray-900 dark:text-gray-100">Take Photo</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Open camera</p>
          </div>
        </button>
        {/* Library option */}
        <button
          onClick={onLibrary}
          className="w-full flex items-center gap-4 px-5 py-4 active:bg-gray-50 dark:active:bg-zinc-800 transition-colors"
        >
          <span className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-700 dark:text-gray-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <path strokeLinecap="round" d="m21 15-5-5L5 21"/>
            </svg>
          </span>
          <div className="text-left">
            <p className="text-[15px] font-medium text-gray-900 dark:text-gray-100">Photo Library</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Choose existing photos</p>
          </div>
        </button>
      </div>
    </div>
  )
}

// ── Continuous Camera (getUserMedia) ──────────────────────────────────────────
// Uses visualViewport height to avoid iOS Safari nav bar covering controls
function CameraModal({ onDone, onClose }) {
  const videoRef  = useRef(null)
  const streamRef = useRef(null)
  const libRef    = useRef(null)
  const [shots, setShots] = useState([])
  const [ready, setReady] = useState(false)
  const [err,   setErr]   = useState('')
  // Real visible height — avoids Safari bottom bar overlap
  const [vh, setVh] = useState(() => window.visualViewport?.height ?? window.innerHeight)

  useEffect(() => {
    const onResize = () => setVh(window.visualViewport?.height ?? window.innerHeight)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => window.visualViewport?.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
      audio: false,
    }
    navigator.mediaDevices?.getUserMedia(constraints)
      .catch(() => navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }))
      .then(stream => { streamRef.current = stream; if (videoRef.current) videoRef.current.srcObject = stream; setReady(true) })
      .catch(() => setErr('无法访问相机，请检查权限'))
    return () => streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  const snap = async () => {
    const v = videoRef.current; if (!v || !ready) return
    const blob = await compressVideoFrame(v)
    if (!blob) return
    playShutterSound()
    const preview = URL.createObjectURL(blob)
    setShots(p => [...p, { blob, preview, name:`cam_${Date.now()}.jpg` }])
  }

  const remove = (idx) => setShots(prev => { URL.revokeObjectURL(prev[idx].preview); return prev.filter((_,i) => i!==idx) })
  const done   = () => { streamRef.current?.getTracks().forEach(t => t.stop()); onDone(shots) }
  const cancel = () => { streamRef.current?.getTracks().forEach(t => t.stop()); shots.forEach(s => URL.revokeObjectURL(s.preview)); onClose() }

  const STRIP_H  = shots.length > 0 ? 80 : 0
  const CTRL_H   = 120
  const VIDEO_H  = Math.max(100, vh - STRIP_H - CTRL_H)

  return (
    <div style={{ position:'fixed', top:0, left:0, width:'100%', height: vh+'px', zIndex:9999, background:'#000', overflow:'hidden' }}>

      {/* Thumbnail strip */}
      {shots.length > 0 && (
        <div style={{ height:STRIP_H+'px', display:'flex', gap:6, padding:'8px', overflowX:'auto', background:'#111', alignItems:'center' }}>
          {shots.map((s,i) => (
            <div key={i} style={{ position:'relative', flexShrink:0, width:64, height:64, borderRadius:10, overflow:'hidden', border:'2px solid rgba(255,255,255,0.35)' }}>
              <img src={s.preview} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              <button onClick={() => remove(i)} style={{ position:'absolute', top:2, right:2, width:18, height:18, borderRadius:'50%', background:'rgba(0,0,0,0.8)', color:'#fff', border:'none', fontSize:13, cursor:'pointer' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Viewfinder */}
      {err ? (
        <div style={{ height:VIDEO_H+'px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'#fff', gap:16, padding:24 }}>
          <p style={{ textAlign:'center', fontSize:15 }}>{err}</p>
          <button onClick={() => libRef.current?.click()} style={{ padding:'10px 24px', background:'#2563eb', borderRadius:12, color:'#fff', border:'none', fontSize:15, fontWeight:600 }}>从相册选择</button>
        </div>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted style={{ width:'100%', height:VIDEO_H+'px', objectFit:'cover', display:'block' }} />
      )}

      {/* Controls */}
      <div style={{ height:CTRL_H+'px', background:'#000', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 32px' }}>
        <button onClick={cancel} style={{ color:'#fff', background:'none', border:'none', fontSize:17, cursor:'pointer', minWidth:56 }}>取消</button>
        <button onPointerDown={snap} disabled={!ready && !err} style={{ width:72, height:72, borderRadius:'50%', border:'4px solid #fff', background:'transparent', opacity: ready||err ? 1 : 0.4, cursor:'pointer', WebkitTapHighlightColor:'transparent', flexShrink:0 }}>
          <div style={{ width:'100%', height:'100%', borderRadius:'50%', background:'rgba(255,255,255,0.12)' }} />
        </button>
        <button onClick={done} style={{ background:'none', border:'none', fontSize:17, fontWeight:700, color: shots.length>0 ? '#60a5fa' : 'rgba(255,255,255,0.3)', cursor:'pointer', minWidth:56, textAlign:'right' }}>
          {shots.length>0 ? `完成(${shots.length})` : '完成'}
        </button>
      </div>

      <input ref={libRef} type="file" accept="image/*" multiple style={{ display:'none' }} onChange={async e => { const files = Array.from(e.target.files); e.target.value=''; for (const f of files) { const blob = await compressImageFile(f); if (blob) setShots(p=>[...p,{blob,preview:URL.createObjectURL(blob),name:f.name}]) } }} />
    </div>
  )
}

// ── Icon buttons ─────────────────────────────────────────────────────────────
function IconMic({ active, cls = 'w-4 h-4' }) {
  return (
    <svg className={cls} fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="9" y="2" width="6" height="11" rx="3"/>
      <path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>
    </svg>
  )
}
function IconImage({ cls = 'w-4 h-4' }) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <path strokeLinecap="round" d="m21 15-5-5L5 21"/>
    </svg>
  )
}
function IconX2() {
  return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg>
}
function IconHistory() {
  return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5M12 7v5l3 2"/></svg>
}

// ── Main component ────────────────────────────────────────────────────────────
function looksLikePartsManagerEtaInput(inputText = '') {
  const text = String(inputText || '').toLowerCase()
  if (!/\b(eta|due|arriv|received|rcvd|back\s*order|backorder|return|exchange|wrong|short|qty|quantity|pc|pcs|piece|pieces)\b/i.test(text)) {
    return false
  }
  if (looksLikeShopRepairEtaInput(text)) {
    return false
  }
  return /\b(part|parts|vendor|dealer|dealership|bumper|fender|headlight|lamp|grille|hood|door|mirror|sensor|bracket|cover|reinforcement|absorber|molding|radiator|condenser|wheel|blend|keystone|pac|lkq|toyota|ford|hyundai|kia|tesla|colley)\b/i.test(text)
}

function looksLikeShopRepairEtaInput(inputText = '') {
  const text = String(inputText || '').toLowerCase()
  return /\b(customer|completion|complete|delivery|deliver|pickup|pick\s*up|ready|target|promise|promised|shop\s*eta|vehicle\s*eta|repair\s*eta|shop\s*repair\s*eta|repair\s*due|due\s*date|call|called|update customer)\b/i.test(text)
}

function parseShortDate(value = '') {
  const match = String(value).match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)
  if (!match) return ''
  const year = match[3]
    ? Number(match[3].length === 2 ? `20${match[3]}` : match[3])
    : new Date().getFullYear()
  const month = String(Number(match[1])).padStart(2, '0')
  const day = String(Number(match[2])).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function canonicalParsedVendorLabel(value = '') {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  const key = normalizeVendorName(cleaned)
  if (key === 'keystone') return 'Keystone'
  if (key === 'santa margarita toyota') return 'Santa Margarita Toyota'
  if (cleaned && cleaned === cleaned.toUpperCase()) {
    return cleaned.toLowerCase().replace(/\b\w/g, char => char.toUpperCase())
  }
  return cleaned
}

function extractExplicitPartsOrderVendors(inputText = '', knownRoNumbers = []) {
  return extractPartsOrderCandidates(inputText, { knownRoNumbers }).map(order => ({
    roNumber: order.roNumber,
    vendor: canonicalParsedVendorLabel(order.vendor),
    qty: order.qty,
    eta: order.eta,
  }))
}

function applyExplicitPartsOrderFields(action, order) {
  return {
    ...action,
    vendor: order.vendor,
    vendorFull: order.vendor,
    ...(order.qty ? { qty: order.qty } : {}),
    ...(order.eta ? { eta: order.eta } : {}),
  }
}

function preserveExplicitPartsOrderVendors(parsed, inputText = '', knownRoNumbers = []) {
  if (!parsed?.actions?.length) return parsed
  const explicitOrders = extractExplicitPartsOrderVendors(inputText, knownRoNumbers)
  if (!explicitOrders.length) return parsed
  const supportedActions = removeCrossRoPartsOrderLeakage(
    parsed.actions,
    inputText,
    explicitOrders,
    { knownRoNumbers },
  )

  const used = new Set()
  const allCandidatesFor = (action) => explicitOrders
    .map((order, index) => ({ order, index }))
    .filter(({ order }) => {
      return !order.roNumber || !action.roNumber || String(order.roNumber) === String(action.roNumber)
    })
  const candidatesFor = (action) => allCandidatesFor(action)
    .filter(({ index }) => !used.has(index))

  const actions = supportedActions.map(action => {
    if (action?.type !== 'update_parts_order') return action

    const candidates = candidatesFor(action)
    if (!candidates.length) return action

    const matching = candidates.find(({ order }) =>
      vendorNamesMatch(action.vendor, order.vendor) || vendorNamesMatch(action.vendorFull, order.vendor)
    )
    if (matching) {
      used.add(matching.index)
      return applyExplicitPartsOrderFields(action, matching.order)
    }

    const noisyMatching = allCandidatesFor(action).find(({ order }) =>
      vendorsMatchIgnoringParsingMetadata(action.vendor, order.vendor)
      || vendorsMatchIgnoringParsingMetadata(action.vendorFull, order.vendor)
    )
    if (noisyMatching) {
      used.add(noisyMatching.index)
      return applyExplicitPartsOrderFields(action, noisyMatching.order)
    }

    const replacement = candidates[0]
    used.add(replacement.index)
    return applyExplicitPartsOrderFields(action, replacement.order)
  })

  return { ...parsed, actions }
}

function parseBatchPartsOrders(inputText = '', knownRoNumbers = []) {
  return extractPartsOrderCandidates(inputText, { knownRoNumbers })
    .filter(order => order.roNumber)
    .map(order => {
      const vendor = canonicalParsedVendorLabel(order.vendor)
      return {
        type: 'update_parts_order',
        roNumber: order.roNumber,
        vendor,
        vendorFull: vendor,
        description: 'Parts order',
        qty: order.qty,
        qtyReceived: 0,
        eta: order.eta,
        status: 'ordered',
        confidence: 'high',
      }
    })
}

function mergeBatchPartsOrders(parsed, inputText = '', knownRoNumbers = []) {
  if (!parsed || !Array.isArray(parsed.actions)) return parsed
  const inferredOrders = parseBatchPartsOrders(inputText, knownRoNumbers)
  if (!inferredOrders.length) return parsed
  const hasVendor = (order) => parsed.actions.some(action =>
    action?.type === 'update_parts_order'
    && String(action.roNumber ?? '') === String(order.roNumber ?? '')
    && (vendorNamesMatch(action.vendor, order.vendor) || vendorNamesMatch(action.vendorFull, order.vendor))
  )
  const missingOrders = inferredOrders.filter(order => !hasVendor(order))
  if (!missingOrders.length) return parsed
  return { ...parsed, actions: [...parsed.actions, ...missingOrders] }
}

function applyPartsManagerParsePreference(parsed, sourceRole, inputText = '', knownRoNumbers = []) {
  if (sourceRole !== 'parts_manager' || !parsed?.actions?.length) return parsed

  const actionRoNumbers = parsed.actions.map(action => action?.roNumber).filter(Boolean)
  const candidateRoNumbers = [...knownRoNumbers, ...actionRoNumbers]

  return {
    ...parsed,
    actions: parsed.actions.map(action => {
      if (action?.type !== 'update_due_date') return action
      const scopedInput = getRoScopedText(
        inputText,
        action.roNumber,
        candidateRoNumbers,
        actionRoNumbers,
      )
      if (!looksLikePartsManagerEtaInput(scopedInput)) return action
      return {
        type: 'update_parts_order',
        roNumber: action.roNumber,
        roId: action.roId,
        vendor: '',
        vendorFull: '',
        description: 'Parts ETA update',
        qty: null,
        qtyReceived: 0,
        eta: action.dueDate,
        status: 'ordered',
        confidence: action.confidence || 'medium',
      }
    }),
  }
}

function prepareParsedResult(parsed, sourceRole, inputText = '', knownRoNumbers = []) {
  const parseContextText = [inputText, parsed?.translation].filter(Boolean).join('\n')
  const withInferredStructuredActions = parsed?.actions
    ? { ...parsed, actions: inferStructuredActionsFromText(parsed.actions, parseContextText, knownRoNumbers) }
    : parsed
  const withExplicitPartOrderVendors = preserveExplicitPartsOrderVendors(withInferredStructuredActions, parseContextText, knownRoNumbers)
  return mergeBatchPartsOrders(
    applyPartsManagerParsePreference(withExplicitPartOrderVendors, sourceRole, parseContextText, knownRoNumbers),
    parseContextText,
    knownRoNumbers,
  )
}

export default function AIInputBox({
  ros = [],
  employees = [],
  sourceRole = null,
  compact = false,
  sharedDraftKey = null,
  compactSubtitle = 'Parts ETA / received',
  compactPlaceholder = 'Quick parts update, e.g. RO9584 Chevy dealer ETA 5/28',
  fullPlaceholder = 'e.g. "RO9448 dropped off 4-25, w/o rental, ordered parts thru PT eta 4-29"',
}) {
  const { user } = useAuth()
  const toast    = useToast()

  const [text,        setText]        = useState('')
  const [loading,     setLoading]     = useState(false)
  const [reparsing,   setReparse]     = useState(false) // silent background re-parse
  const [result,      setResult]      = useState(null)
  const [actions,     setActions]     = useState([])
  const [error,       setError]       = useState('')
  const [applying,    setApplying]    = useState(false)
  const [applied,     setApplied]     = useState(false)
  const [noKey,       setNoKey]       = useState(false)
  const [listening,   setListening]   = useState(false)
  const [images,          setImages]          = useState([])
  const [showPhotoSheet,  setShowPhotoSheet]  = useState(false)
  const [showCamera,      setShowCamera]      = useState(false)
  const [uploadProgress,  setUploadProgress]  = useState({ done: 0, total: 0 })
  const [isTranscribing,  setIsTranscribing]  = useState(false)  // Whisper processing
  const [recordSecs,      setRecordSecs]      = useState(0)      // elapsed recording seconds
  const [audioLevel,      setAudioLevel]      = useState(0)      // 0-1 for bar heights
  const [showHistory,     setShowHistory]     = useState(false)
  const [history,         setHistory]         = useState([])
  const [recentApplied,   setRecentApplied]   = useState(null)
  const [undoing,         setUndoing]         = useState(false)

  const fileInputRef      = useRef(null)   // gallery picker
  const cameraRef         = useRef(null)   // camera capture
  const submittedText     = useRef('')     // text that produced the current AI result
  const reparseTimer      = useRef(null)
  // Whisper voice refs
  const mediaRecorderRef  = useRef(null)
  const audioChunksRef    = useRef([])
  const audioContextRef   = useRef(null)
  const analyserRef       = useRef(null)
  const levelAnimRef      = useRef(null)
  const recordTimerRef    = useRef(null)
  const instanceId        = useRef(`gib-${Math.random().toString(36).slice(2)}`)
  const lastSharedPayload = useRef('')

  useEffect(() => {
    if (!sharedDraftKey) return
    try {
      const savedRaw = localStorage.getItem(sharedDraftKey) || '{}'
      lastSharedPayload.current = savedRaw
      const saved = JSON.parse(savedRaw)
      if (typeof saved.text === 'string') setText(saved.text)
      if (saved.result) setResult(saved.result)
      if (Array.isArray(saved.actions)) setActions(saved.actions)
    } catch { /* ignore bad shared draft */ }

    const onDraftUpdate = (event) => {
      if (event.detail?.key !== sharedDraftKey) return
      if (event.detail?.source === instanceId.current) return
      const next = event.detail?.payload || {}
      const serialized = JSON.stringify(next)
      if (serialized === lastSharedPayload.current) return
      lastSharedPayload.current = serialized
      if (typeof next.text === 'string') setText(next.text)
      setResult(next.result || null)
      setActions(Array.isArray(next.actions) ? next.actions : [])
      setApplied(false)
    }

    window.addEventListener('gib-draft-update', onDraftUpdate)
    return () => window.removeEventListener('gib-draft-update', onDraftUpdate)
  }, [sharedDraftKey])

  useEffect(() => {
    if (!sharedDraftKey) return
    const payload = { text, result, actions }
    const serialized = JSON.stringify(payload)
    if (serialized === lastSharedPayload.current) return
    lastSharedPayload.current = serialized
    try {
      if (!text.trim() && !result && actions.length === 0) {
        localStorage.removeItem(sharedDraftKey)
      } else {
        localStorage.setItem(sharedDraftKey, serialized)
      }
    } catch { /* ignore storage errors */ }
    window.dispatchEvent(new CustomEvent('gib-draft-update', {
      detail: { key: sharedDraftKey, source: instanceId.current, payload },
    }))
  }, [sharedDraftKey, text, result, actions])

  // Sync actions from result whenever result changes
  useEffect(() => {
    if (result?.actions) {
      const inputText = submittedText.current || text
      const prepared = prepareParsedResult(result, sourceRole, inputText, ros.map(ro => ro.roNumber))
      setActions(normalizePaintWorkflowActions(
        normalizeBodyWorkflowActions(prepared.actions, inputText, ros, employees),
        inputText,
        ros,
        employees,
      ))
    }
  }, [result, ros, employees, text])

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(GIB_HISTORY_KEY) || '[]')
      setHistory(Array.isArray(saved) ? saved : [])
    } catch {
      setHistory([])
    }
  }, [])

  const rememberHistory = (value) => {
    const entry = value.trim()
    if (!entry) return
    setHistory(prev => {
      const next = [entry, ...prev.filter(item => item !== entry)].slice(0, 12)
      localStorage.setItem(GIB_HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }

  const useHistoryItem = (value) => {
    setText(value)
    setResult(null)
    setActions([])
    setApplied(false)
    setShowHistory(false)
  }

  // ── Auto re-parse when textarea changes after AI result is shown ─────────
  // Debounce 1.2s — silently refresh action cards without full spinner
  useEffect(() => {
    if (!result || images.length > 0 || loading || applying) return
    if (text.trim() === submittedText.current.trim()) return
    if (text.trim().length < 6) return

    clearTimeout(reparseTimer.current)
    reparseTimer.current = setTimeout(async () => {
      try {
        setReparse(true)
        const key = await getApiKey()
        if (!key) return
        const parsed = await parseShopInput({ text, ros, employees, images: [], sourceRole })
        if (!parsed.raw) {
          setResult(prepareParsedResult(parsed, sourceRole, text, ros.map(ro => ro.roNumber)))
          submittedText.current = text
        }
      } catch { /* silent — user can re-submit manually */ }
      finally { setReparse(false) }
    }, 1200)

    return () => clearTimeout(reparseTimer.current)
  }, [text, sourceRole])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Voice input — Whisper (OpenAI) ───────────────────────────────────────
  // Records audio via MediaRecorder, sends to Whisper on stop.
  // Whisper auto-detects language — Chinese / English / Spanish mixed works perfectly.
  const toggleVoice = async () => {
    // ── STOP recording → send to Whisper ──────────────────────────────────
    if (listening) {
      setListening(false)

      // Stop timers & audio analysis
      clearInterval(recordTimerRef.current)
      cancelAnimationFrame(levelAnimRef.current)
      audioContextRef.current?.close().catch(() => {})
      setAudioLevel(0); setRecordSecs(0)

      const mr = mediaRecorderRef.current
      if (!mr) return

      // Wait for MediaRecorder to flush remaining data
      const blob = await new Promise(resolve => {
        mr.onstop = () => resolve(new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' }))
        mr.stop()
        mr.stream.getTracks().forEach(t => t.stop())
      })

      if (!blob || blob.size < 1000) return  // too short / empty

      setIsTranscribing(true)
      try {
        const transcript = await transcribeWithWhisper(blob)
        if (transcript.trim()) {
          setText(prev => prev.trimEnd() ? prev.trimEnd() + ' ' + transcript.trim() : transcript.trim())
        }
      } catch (err) {
        if (err.message === 'NO_OPENAI_KEY') {
          setError('Add your OpenAI API key in Settings to use voice input.')
        } else {
          setError('Transcription failed: ' + err.message)
        }
      } finally {
        setIsTranscribing(false)
      }
      return
    }

    // ── START recording ────────────────────────────────────────────────────
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

      // Audio level analyzer (drives the animated bars)
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = audioCtx
      analyserRef.current     = analyser
      const levelBuf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(levelBuf)
        const avg = levelBuf.reduce((a, b) => a + b, 0) / levelBuf.length
        setAudioLevel(avg / 255)
        levelAnimRef.current = requestAnimationFrame(tick)
      }
      tick()

      // Recording timer
      setRecordSecs(0)
      recordTimerRef.current = setInterval(() => setRecordSecs(s => s + 1), 1000)

      // MediaRecorder — prefer webm, fallback to mp4 for Safari
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                     : MediaRecorder.isTypeSupported('audio/webm')              ? 'audio/webm'
                     : 'audio/mp4'
      const mr = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start(250)  // collect chunks every 250ms so onstop gets everything
      mediaRecorderRef.current = mr

      setListening(true)
    } catch (err) {
      setError('Microphone access denied — please allow microphone in browser settings.')
    }
  }

  const readImageFile = (file) => {
    if (!file.type.startsWith('image/')) return
    compressImageFile(file).then(blob => {
      const preview = URL.createObjectURL(blob)
      setImages(prev => [...prev, { blob, preview, name: file.name }])
    })
  }

  const handleFileChange = (e) => {
    Array.from(e.target.files).forEach(readImageFile)
    e.target.value = ''  // reset so same file can be re-selected
  }

  const removeImage = (idx) => setImages(prev => {
    URL.revokeObjectURL(prev[idx]?.preview)  // free memory
    return prev.filter((_, i) => i !== idx)
  })

  // ── Upload one blob via uploadBytesResumable with stall detection ────────────
  // If no bytes transfer for STALL_MS, we cancel and reject.
  // This is far more reliable than uploadBytes on iOS Safari.
  const uploadOneBlob = (sRef, blob) => new Promise((resolve, reject) => {
    const STALL_MS = 15000   // 15s with zero progress = stall → fail
    let stallTimer = null

    const resetStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        task.cancel()
        reject(new Error('Upload stalled — check network connection'))
      }, STALL_MS)
    }

    const task = uploadBytesResumable(sRef, blob, { contentType: 'image/jpeg' })
    resetStall()

    task.on('state_changed',
      (snap) => {
        // Any bytes transferred means connection is alive — reset stall clock
        if (snap.bytesTransferred > 0) resetStall()
      },
      (err) => { clearTimeout(stallTimer); reject(err) },
      ()    => { clearTimeout(stallTimer); resolve(task.snapshot) }
    )
  })

  // ── Submit ────────────────────────────────────────────────────────────────
  // ── Direct image upload — no AI, just regex RO# + keyword label ─────────────
  const handleDirectImageUpload = async () => {
    setLoading(true); setError('')
    setUploadProgress({ done: 0, total: images.length })
    const roNumber = extractRoNumber(text, ros)
    if (!roNumber) {
      setError('Include an RO number, e.g. "9556 check-in photos"')
      setLoading(false); return
    }
    const roDoc = ros.find(r => r.roNumber === roNumber)
    if (!roDoc) {
      setError(`RO #${roNumber} not found`)
      setLoading(false); return
    }
    const { label: typeLabel, slug: typeSlug } = detectPhotoType(text)
    const author = employees.find(e => e.uid === user.uid)?.name ?? user.email
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const now    = new Date().toISOString()
    const ts     = Date.now()

    try {
      // Upload sequentially — avoids overwhelming mobile radio with concurrent streams
      const attachments = []
      for (let idx = 0; idx < images.length; idx++) {
        const img    = images[idx]
        const padded = String(idx + 1).padStart(2, '0')
        const filename = `${ts}_${typeSlug}_${padded}.jpg`
        const sRef = storageRef(storage, `ros/${roDoc.id}/attachments/${filename}`)

        await uploadOneBlob(sRef, img.blob)
        const url = await getDownloadURL(sRef)

        attachments.push({ url, name: `${typeSlug}_${padded}`, label: typeLabel, uploadedAt: now })
        setUploadProgress({ done: idx + 1, total: images.length })
      }

      // Write attachments + auto-note in one updateDoc
      const n         = images.length
      const noteEntry = `[${stamp} - ${author}] Uploaded ${n} ${typeLabel} photo${n !== 1 ? 's' : ''}`
      await updateDoc(doc(db, 'ros', roDoc.id), {
        attachments: arrayUnion(...attachments),
        notes:       `${noteEntry}\n${roDoc.notes ?? ''}`,
        updatedAt:   serverTimestamp(),
      })

      toast.success(`${n} ${typeLabel} photo${n !== 1 ? 's' : ''} → RO #${roNumber}`)
      rememberHistory(text)
      setText(''); setImages([])
    } catch (err) {
      console.error('[AIInputBox] Direct upload failed:', err)
      setError('Upload failed: ' + err.message)
    } finally {
      setLoading(false)
      setUploadProgress({ done: 0, total: 0 })
    }
  }

  // ── Submit: images → direct upload; text-only → AI parse ─────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim() && images.length === 0) return

    // Images present → bypass AI entirely: regex RO# + auto-label + upload
    if (images.length > 0) {
      await handleDirectImageUpload()
      return
    }

    // Text-only → Claude AI parsing
    setLoading(true); setError(''); setResult(null); setApplied(false)
    try {
      const key = await getApiKey()
      if (!key) { setNoKey(true); setLoading(false); return }
      const parsed = await parseShopInput({ text, ros, employees, images: [], sourceRole })
      if (parsed.raw) throw new Error('AI returned unexpected format. Please rephrase.')
      setResult(prepareParsedResult(parsed, sourceRole, text, ros.map(ro => ro.roNumber)))
      rememberHistory(text)
      submittedText.current = text
    } catch (err) {
      if (err.message === 'NO_API_KEY')  { setNoKey(true); return }
      if (err.message === 'INVALID_KEY') { setError('API key is invalid. Please update it in Settings.'); return }
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Apply actions + upload images ─────────────────────────────────────────
  const handleApply = async () => {
    if (!actions.length && images.length === 0) return
    setApplying(true)

    // Outer guard: any throw in action-bucketing (Step 1/2) happens BEFORE the
    // inner try below, so without this the button would stay stuck on "Applying…".
    try {
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees.find(e => e.uid === user.uid)?.name ?? user.email
    const now    = new Date().toISOString()
    const submittedInput = submittedText.current || text

    // ── Step 1: bucket all actions by RO, building one merged update per doc ──
    // This cuts N sequential Firestore writes down to 1 per RO.
    const roMap = new Map() // roId → { roDoc, fields, changeLogEntries }
    const standaloneTaskPromises = []
    const createdTaskRefs = []
    const addTask = (data) => {
      // Firestore rejects `undefined` field values — strip them defensively.
      const clean = {}
      for (const k of Object.keys(data)) {
        if (data[k] !== undefined) clean[k] = data[k]
      }
      return addDoc(collection(db, 'tasks'), clean).then(ref => {
        createdTaskRefs.push(ref)
        return ref
      })
    }

    const getEntry = (roDoc) => {
      if (!roMap.has(roDoc.id)) {
        roMap.set(roDoc.id, { roDoc, fields: { updatedAt: serverTimestamp() }, changeLogEntries: [], taskPromises: [] })
      }
      return roMap.get(roDoc.id)
    }

    for (const action of actions) {
      const roDoc = ros.find(r => r.id === action.roId || r.roNumber === action.roNumber)
      if (!roDoc) {
        if (action.type === 'assign_task') {
          const assignee = findEmployeeByName(employees, action.assigneeName)
          if (!assignee) {
            setError(`Could not match task assignee "${action.assigneeName}". Edit the suggested action and choose a valid employee name.`)
            setApplying(false)
            return
          }
          standaloneTaskPromises.push(addTask({
            assignedTo: assignee.uid,
            assignedBy: user.uid,
            assignedByName: author,
            assignedToName: assignee.name ?? '',
            assignedAt: serverTimestamp(),
            title: taskTitleFromAction(action),
            description: action.description ?? '',
            category: 'standalone',
            priority: action.priority || 'medium',
            status: 'pending',
            source: 'gib',
            autoTriggered: false,
            createdAt: serverTimestamp(),
          }))
        }
        continue
      }
      const entry = getEntry(roDoc)

      switch (action.type) {
        case 'add_note': {
          const prev = roDoc.notes ?? ''
          const line = `[${stamp} - ${author}] ${action.note}`
          // Merge multiple notes if >1 action on same RO
          entry.fields.notes = entry.fields.notes
            ? `${line}\n${entry.fields.notes}`
            : `${line}\n${prev}`
          break
        }
        case 'update_status': {
          if (action.status === 'body_work' && !releaseHasBodyTech(roDoc, entry.fields, actions, employees)) {
            setError(BODY_RELEASE_ERROR)
            setApplying(false)
            return
          }
          entry.fields.status = action.status
          entry.changeLogEntries.push({ type: 'update_status', value: action.status, by: author, at: now, source: 'gib' })
          impliedCompletedPhasesForStatus(action.status).forEach(phase => {
            entry.taskPromises.push(completePhaseTasksPromise(roDoc.id, phase))
          })
          await addDownstreamTasksForEntry({ entry, status: action.status, roDoc, employees, user, author, addTask })
          break
        }
        case 'update_parts_status':
          if (action.noReplacementPartsNeeded) {
            entry.fields.partsStatus = 'all_received'
            entry.fields.partsOrders = []
            entry.fields.noReplacementPartsNeeded = true
            entry.fields.partsSubtasks = {
              ...(roDoc.partsSubtasks || {}),
              verifiedAllReceived: true,
            }
            entry.changeLogEntries.push({ type: 'update_parts_status', value: 'all_received', label: 'No replacement parts needed', by: author, at: now, source: 'gib' })
            break
          }
          if (action.partsStatus && action.partsStatus !== 'not_ordered') {
            const orders = currentPartsOrders(roDoc, entry)
            if (!orders.length) {
              const placeholder = {
                id: newRecordId('parts_order'),
                vendor: '',
                vendorFull: '',
                description: '',
                qty: null,
                status: orderStatusFromPartsStatus(action.partsStatus),
                eta: null,
                qtyReceived: 0,
                orderedAt: null,
                orderedBy: null,
                receivedAt: action.partsStatus === 'all_received' ? now : null,
                notes: 'Missing vendor, quantity, and ETA.',
              }
              const nextOrders = [placeholder]
              entry.fields.partsOrders = nextOrders
              entry.fields.partsStatus = calculatePartsStatus(nextOrders, action.partsStatus)
            } else {
              entry.fields.partsStatus = calculatePartsStatus(orders, action.partsStatus)
            }
          } else {
            entry.fields.partsStatus = action.partsStatus
          }
          entry.changeLogEntries.push({ type: 'update_parts_status', value: action.partsStatus, by: author, at: now, source: 'gib' })
          break
        case 'update_parts_order': {
          const orders = currentPartsOrders(roDoc, entry)
          const qty = numericQty(action.qty ?? action.quantity, 0) || null
          let matched = false
          const explicitQtyReceived = action.qtyReceived ?? action.receivedQty
          const qtyReceived = explicitQtyReceived === 0 || explicitQtyReceived === '0'
            ? 0
            : numericQty(explicitQtyReceived, 0)
          const order = {
            id: newRecordId('parts_order'),
            vendor: (action.vendor || '').trim(),
            vendorFull: (action.vendorFull || '').trim(),
            description: (action.description || '').trim(),
            qty,
            status: action.status || 'ordered',
            eta: action.eta || null,
            qtyReceived,
            orderedAt: now,
            orderedBy: user.uid,
            receivedAt: null,
            notes: action.notes || '',
          }
          const nextOrders = orders.map(existing => {
            if (action.forceNewOrder || matched || !orderMatchesVendor(existing, action.vendor, action.vendorFull)) return existing
            matched = true
            const existingQty = numericQty(existing.qty ?? existing.quantity, 0)
            const nextQty = qty || existingQty || null
            const etaOnlyUpdate = Boolean(action.eta)
              && !qty
              && !(action.description || '').trim()
              && !qtyReceived
            return {
              ...existing,
              vendor: existing.vendor || order.vendor,
              vendorFull: existing.vendorFull || order.vendorFull,
              description: order.description || existing.description || '',
              qty: nextQty,
              status: etaOnlyUpdate ? (existing.status || 'ordered') : (action.status || existing.status || 'ordered'),
              eta: action.eta || existing.eta || null,
              qtyReceived: explicitQtyReceived === undefined || explicitQtyReceived === null
                ? numericQty(existing.qtyReceived ?? existing.receivedQty, 0)
                : qtyReceived,
              notes: action.notes || existing.notes || '',
            }
          })
          if (!matched) nextOrders.push(order)
          entry.fields.partsOrders = nextOrders
          entry.fields.noReplacementPartsNeeded = false
          entry.fields['partsSubtasks.verifiedAllReceived'] = false
          entry.fields.partsStatus = calculatePartsStatus(nextOrders, roDoc.partsStatus)
          entry.changeLogEntries.push({ type: 'update_parts_order', value: order.vendor || 'Missing vendor', label: action.eta ? `ETA ${action.eta}` : order.description, by: author, at: now, source: 'gib' })
          break
        }
        case 'log_parts_received': {
          const actionVendor = (action.vendor || '').trim()
          const received = numericQty(action.qtyReceived ?? action.receivedQty, 0)
          const total = numericQty(action.totalQty ?? action.qty, 0)
          const orders = currentPartsOrders(roDoc, entry)
          let matched = false
          let receivedVendorLabel = actionVendor || 'Missing vendor'
          const nextOrders = orders.map(order => {
            const vendorMatches = !actionVendor || orderMatchesVendor(order, actionVendor, action.vendorFull)
            if (matched || !vendorMatches) return order
            if (isOrderFullyReceived(order)) return order
            matched = true
            receivedVendorLabel = order.vendor || order.vendorFull || actionVendor || 'Missing vendor'
            const qty = numericQty(order.qty ?? order.quantity, total) || null
            const currentReceived = numericQty(order.qtyReceived ?? order.receivedQty, 0)
            const nextReceived = action.receiveMode === 'set'
              ? received
              : Math.min(qty || currentReceived + received, currentReceived + received)
            return {
              ...order,
              qty,
              qtyReceived: nextReceived,
              status: qty && nextReceived >= qty ? 'received' : 'partial',
              eta: action.eta || order.eta || null,
              receivedAt: qty && nextReceived >= qty ? now : order.receivedAt ?? null,
              notes: action.note || order.notes || '',
            }
          })
          if (!matched) {
            nextOrders.push({
              id: newRecordId('parts_order'),
              vendor: action.vendor || '',
              vendorFull: action.vendorFull || '',
              description: action.description || 'Parts received',
              qty: total || null,
              status: total && received >= total ? 'received' : 'partial',
              eta: null,
              qtyReceived: received,
              orderedAt: null,
              orderedBy: null,
              receivedAt: now,
              notes: action.note || '',
            })
          }
          entry.fields.partsOrders = nextOrders
          entry.fields.noReplacementPartsNeeded = false
          entry.fields.partsStatus = calculatePartsStatus(nextOrders, roDoc.partsStatus)
          if (entry.fields.partsStatus === 'all_received') {
            entry.fields['partsSubtasks.verifiedAllReceived'] = true
          }
          const roActionText = sameRoActionText(actions, action.roNumber)
          if (/\b(repair\s+parts?|body\s*\/?\s*painter|painter)\b.*\b(deliver|delivered|gave|handed|handoff|handed\s+off)\b|\b(deliver|delivered|gave|handed|handoff|handed\s+off)\b.*\b(repair\s+parts?|body\s*\/?\s*painter|painter)\b/i.test(roActionText)) {
            entry.fields['partsSubtasks.deliveredToRepair'] = true
          }
          if (/\b(all\s+parts?|body\s*man|bodyman|body\s+technician|body\s+tech|tech|reassembl)\b.*\b(deliver|delivered|gave|handed|handoff|handed\s+off)\b|\b(deliver|delivered|gave|handed|handoff|handed\s+off)\b.*\b(all\s+parts?|body\s*man|bodyman|body\s+technician|body\s+tech|tech|reassembl)\b/i.test(roActionText)) {
            entry.fields['partsSubtasks.deliveredToReassembly'] = true
          }
          entry.changeLogEntries.push({ type: 'log_parts_received', value: receivedVendorLabel, label: `${received}/${total || '?'}`, by: author, at: now, source: 'gib' })
          if (action.note) {
            prependRoNote(entry, roDoc, `[${stamp} - ${author}] Parts received from ${receivedVendorLabel}: ${action.note}`)
          }
          break
        }
        case 'log_parts_return': {
          const returns = Array.isArray(entry.fields.partsReturns)
            ? entry.fields.partsReturns
            : Array.isArray(roDoc.partsReturns) ? roDoc.partsReturns : []
          const ret = {
            id: newRecordId('parts_return'),
            vendor: action.vendor || 'Unknown',
            qty: numericQty(action.qty ?? action.quantity, 1),
            reason: action.reason || action.description || '',
            needsReplacement: Boolean(action.needsReplacement),
            status: action.status || 'pending',
            returnedAt: now,
            returnedBy: user.uid,
            notes: action.notes || '',
          }
          entry.fields.partsReturns = [...returns, ret]
          if (ret.needsReplacement) {
            entry.fields.noReplacementPartsNeeded = false
            entry.fields['partsSubtasks.verifiedAllReceived'] = false
          }
          prependRoNote(entry, roDoc, `[${stamp} - ${author}] Parts return logged: ${ret.vendor} ${ret.qty} pc${ret.qty === 1 ? '' : 's'}${ret.reason ? ` - ${ret.reason}` : ''}.`)
          entry.changeLogEntries.push({ type: 'log_parts_return', value: ret.vendor, label: ret.reason, by: author, at: now, source: 'gib' })
          break
        }
        case 'update_car_status':
          entry.fields.carStatus = action.carStatus
          entry.changeLogEntries.push({ type: 'update_car_status', value: action.carStatus, by: author, at: now, source: 'gib' })
          break
        case 'update_dropoff_date': {
          const isDuplicate = roDoc.dropOffDate && roDoc.dropOffDate === action.dropOffDate
          if (!isDuplicate) {
            // New or updated date — write it
            entry.fields.dropOffDate = action.dropOffDate
            entry.changeLogEntries.push({ type: 'update_dropoff_date', value: action.dropOffDate, by: author, at: now, source: 'gib' })
          }
          // Auto-add drop-off note if GIB didn't already include one for this RO.
          // For duplicates: note is still written if it contains new info (time detail etc.)
          // For non-duplicates: always add a note if GIB didn't provide one.
          const hasDropoffNote = actions.some(a => a.type === 'add_note' && a.roNumber === action.roNumber)
          if (!hasDropoffNote && !isDuplicate) {
            const autoNote = `[${stamp} - ${author}] Vehicle dropped off on ${action.dropOffDate}.`
            const prevNotes = entry.fields.notes ?? roDoc.notes ?? ''
            entry.fields.notes = prevNotes ? `${autoNote}\n${prevNotes}` : autoNote
          }
          break
        }
        case 'update_due_date':
          {
            const roActionText = sameRoActionText(actions, action.roNumber)
            const orders = currentPartsOrders(roDoc, entry)
            const isPartsEtaUpdate = /\b(parts?|vendor|dealer|dealership|eta)\b/i.test(roActionText)
              && !looksLikeShopRepairEtaInput(roActionText)
              && orders.some(order => orderMentionedInText(order, roActionText))
            if (isPartsEtaUpdate) {
              let updated = false
              entry.fields.partsOrders = orders.map(order => {
                if (updated || !orderMentionedInText(order, roActionText)) return order
                updated = true
                return { ...order, eta: action.dueDate }
              })
              entry.fields.partsStatus = calculatePartsStatus(entry.fields.partsOrders, roDoc.partsStatus)
              entry.changeLogEntries.push({ type: 'update_parts_order', value: 'Vendor ETA', label: action.dueDate, by: author, at: now, source: 'gib' })
            } else {
              entry.fields.eta = action.dueDate
              entry.changeLogEntries.push({ type: 'update_due_date', value: action.dueDate, by: author, at: now, source: 'gib' })
            }
          }
          break
        case 'update_rental':
          entry.fields.hasRental = action.hasRental
          entry.changeLogEntries.push({ type: 'update_rental', value: String(action.hasRental), by: author, at: now, source: 'gib' })
          break
        case 'assign_body_man': {
          const assignee = findEmployeeByName(employees, action.assigneeName, 'body_man')
          if (assignee) {
            entry.fields.assignedBodyMan = assignee.uid
            entry.changeLogEntries.push({ type: 'assign_body_man', value: assignee.uid, label: assignee.name, by: author, at: now, source: 'gib' })
            const actionInput = scopedInputForRo(submittedInput, action.roNumber, actions, ros)
            const phase = bodyPhaseFromActionsForRo(actions, action.roNumber, actionInput)
            const hasExplicitPrimaryBodyTask = actions.some(other =>
              other !== action
              && other.type === 'assign_task'
              && String(other.roNumber ?? '') === String(action.roNumber ?? '')
              && normalizeName(other.assigneeName) === normalizeName(action.assigneeName)
              && isExplicitPrimaryBodyTaskAction(other)
            )
            if (phase && !hasExplicitPrimaryBodyTask) {
              const roDueDate = roDoc.eta || roDoc.cccDateOut || roDoc.promisedDate || null
              entry.taskPromises.push(addTask({
                roId: roDoc.id, roNumber: roDoc.roNumber, vehicleInfo: roDoc.vehicle,
                assignedTo: assignee.uid, assignedBy: user.uid, assignedByName: author,
                assignedToName: assignee.name ?? '',
                title: bodyPhaseTitle(phase),
                description: '',
                phase,
                category: 'body',
                partsStatus: roDoc.partsStatus ?? '',
                priority: dueDateToPriority(roDoc),
                dueDate: roDueDate,
                status: 'pending',
                source: 'gib',
                autoTriggered: true,
                taskKind: 'primary',
                createdAt: serverTimestamp(),
              }))
            }
          }
          break
        }
        case 'assign_painter': {
          const assignee = findEmployeeByName(employees, action.assigneeName, 'painter')
          if (assignee) {
            entry.fields.assignedPainter = assignee.uid
            entry.changeLogEntries.push({ type: 'assign_painter', value: assignee.uid, label: assignee.name, by: author, at: now, source: 'gib' })
          }
          break
        }
        case 'assign_task': {
          const actionInput = scopedInputForRo(submittedInput, action.roNumber, actions, ros)
          const roActionText = `${sameRoActionText(actions, action.roNumber)} ${actionInput}`
          const contextPhase = bodyPhaseFromText(roActionText)
          const isSecondaryBodyTask = action.taskKind === 'secondary'
            || (!isExplicitPrimaryBodyTaskAction(action) && contextPhase && looksLikeSecondaryBodyTaskStrict(action, roActionText))
          const isBodyTask = !isSecondaryBodyTask && isBodyTaskAction(action)
          const assignee = action.assigneeUid
            ? findEmployeeByUid(employees, action.assigneeUid)
            : findEmployeeByName(employees, action.assigneeName, (isBodyTask || isSecondaryBodyTask) ? 'body_man' : null)
          if (!assignee) {
            setError(`Could not match task assignee "${action.assigneeName}". Edit the suggested action and choose a valid employee name.`)
            setApplying(false)
            return
          }
          if ((isBodyTask || isSecondaryBodyTask) && assignee.role !== 'body_man') {
            setError(`Body tasks can only be assigned to employees with the Body Technician role. "${assignee.name}" is ${assignee.role || 'not a body technician'}.`)
            setApplying(false)
            return
          }
          const roDueDate  = roDoc.eta || roDoc.cccDateOut || roDoc.promisedDate || null
          const bodyCore = isBodyTask ? bodyTaskCore(action, roActionText) : null
          if (isBodyTask || isSecondaryBodyTask) entry.fields.assignedBodyMan = assignee.uid
          const isPaintAssignee = assignee.role === 'painter' || assignee.role === 'paint_helper'
          const taskBase = {
            roId: roDoc.id, roNumber: roDoc.roNumber, vehicleInfo: roDoc.vehicle,
            assignedTo: assignee.uid, assignedBy: user.uid, assignedByName: author,
            assignedToName: assignee.name ?? '',
            category: (isBodyTask || isSecondaryBodyTask) ? 'body' : isPaintAssignee ? 'paint' : '',
            partsStatus: roDoc.partsStatus ?? '',
            priority: dueDateToPriority(roDoc),
            dueDate: roDueDate,
            status: 'pending',
            source: 'gib',
            autoTriggered: false,
            createdAt: serverTimestamp(),
          }
          if (isPaintAssignee && action.taskKind === 'primary') {
            const tmpl = {
              title: action.phase === 'paint_prep' ? 'Paint Prep' : 'Paint',
              phase: action.phase === 'paint_prep' ? 'paint_prep' : 'paint',
              category: 'paint',
              taskKind: 'primary',
            }
            if (!(await hasOpenTaskForTemplate(roDoc.id, tmpl))) {
              entry.taskPromises.push(addTask({
                ...taskBase,
                title: tmpl.title,
                description: '',
                phase: tmpl.phase,
                category: 'paint',
                taskKind: 'primary',
                autoTriggered: true,
              }))
            }
            break
          }
          if (isPaintAssignee && !isBodyTask && !isSecondaryBodyTask) {
            const detail = taskTitleFromAction(action, '').trim()
            const phase = action.phase === 'paint_prep' || action.phase === 'paint'
              ? action.phase
              : paintSecondaryPhase(action, roActionText)
            entry.taskPromises.push(addTask({
              ...taskBase,
              title: detail || action.title || 'Paint reminder',
              description: action.description || '',
              phase,
              taskKind: 'secondary',
              parentPhase: phase,
            }))
            break
          }
          if (isSecondaryBodyTask) {
            const detail = taskTitleFromAction(action, '').trim()
            entry.taskPromises.push(addTask({
              ...taskBase,
              title: inferSecondaryBodyTaskTitle(detail),
              description: action.description || detail,
              phase: contextPhase,
              taskKind: 'secondary',
              parentPhase: contextPhase,
            }))
            break
          }
          entry.taskPromises.push(addTask({
            ...taskBase,
            title: bodyCore?.title ?? normalizedTaskTitle(action, isBodyTask),
            description: '',
            phase: bodyCore?.phase ?? null,
            taskKind: isBodyTask ? 'primary' : 'standard',
          }))
          if (bodyCore?.secondaryTask) {
            entry.taskPromises.push(addTask({
              ...taskBase,
              title: bodyCore.secondaryTask.title,
              description: bodyCore.secondaryTask.description,
              phase: bodyCore.phase,
              taskKind: 'secondary',
              parentPhase: bodyCore.phase,
            }))
          }
          break
        }
        case 'complete_phase': {
          const { phase } = action
          // Advance RO status via engine (don't override if another action already set it)
          const suggestion = getSuggestedNextStatus(phase, roDoc)
          if (suggestion) {
            if (!entry.fields.status) entry.fields.status = suggestion.nextStatus
            const noteLine = `[${stamp} - ${author}] ${suggestion.noteText}`
            entry.fields.notes = entry.fields.notes
              ? `${noteLine}\n${entry.fields.notes}`
              : `${noteLine}\n${roDoc.notes ?? ''}`
            entry.changeLogEntries.push({ type: 'complete_phase', value: phase, label: `${phase} phase complete`, by: author, at: now, source: 'gib' })
            await addDownstreamTasksForEntry({ entry, status: suggestion.nextStatus, roDoc, employees, user, author, addTask })
          }
          // Mark all tasks for this RO + phase as completed.
          // Primary query: tasks with the phase field (new tasks created after this fix).
          // Fallback: tasks without phase field (legacy) — query by category + title keyword.
          const PHASE_CATEGORY = { teardown: 'body', body: 'body', paint_prep: 'paint', paint: 'paint', reassembly: 'body', sublet: 'sublet', detail: 'detail' }
          const PHASE_TITLE_RE = { teardown: /teardown/i, body: /body work/i, paint_prep: /paint.?prep/i, paint: /paint/i, reassembly: /reassembl/i, sublet: /sublet/i, detail: /detail|qc/i }
          entry.taskPromises.push(
            getDocs(query(collection(db, 'tasks'), where('roId', '==', roDoc.id), where('phase', '==', phase)))
              .then(async snap => {
                let pending = snap.docs.filter(d => d.data().status !== 'completed')
                // Fallback for legacy tasks that have no phase field
                if (pending.length === 0) {
                  const cat = PHASE_CATEGORY[phase]
                  const re  = PHASE_TITLE_RE[phase]
                  if (cat) {
                    const fallback = await getDocs(query(collection(db, 'tasks'), where('roId', '==', roDoc.id), where('category', '==', cat)))
                    pending = fallback.docs.filter(d => {
                      const data = d.data()
                      return data.status !== 'completed' && (!re || re.test(data.title ?? ''))
                    })
                  }
                }
                return Promise.all(pending.map(d => updateDoc(doc(db, 'tasks', d.id), {
                  status: 'completed', completedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                })))
              })
          )
          break
        }
      }
    }

    for (const entry of roMap.values()) {
      const roDoc = entry.roDoc
      const roInput = scopedInputForRo(submittedInput, roDoc.roNumber, actions, ros)
      const roActionText = `${sameRoActionText(actions, roDoc.roNumber)} ${roInput}`.toLowerCase()
      if (mentionsAuthorization(roActionText)) {
        entry.fields.customerAuthorized = true
      }
      const authorized = entry.fields.customerAuthorized === true || roDoc.customerAuthorized === true
      const partsStatus = effectivePartsStatus(roDoc, entry)
      const currentStatus = entry.fields.status || roDoc.status
      const shouldReleaseRepair = authorized
        && partsAreActionable(partsStatus)
        && ['teardown', 'waiting_parts'].includes(currentStatus)
      if (shouldReleaseRepair) {
        if (!releaseHasBodyTech(roDoc, entry.fields, actions, employees)) {
          setError(BODY_RELEASE_ERROR)
          setApplying(false)
          return
        }
        entry.fields.status = 'body_work'
        prependRoNote(entry, roDoc, `[${stamp} - ${author}] Authorization and parts status confirmed. Repair task released to body technician.`)
        entry.changeLogEntries.push({ type: 'auto_release_repair', value: 'body_work', label: 'Repair task released', by: author, at: now, source: 'auto' })
        await addDownstreamTasksForEntry({ entry, status: 'body_work', roDoc, employees, user, author, addTask })
      }
    }

    // ── Step 2: fire all Firestore doc writes + task creates in parallel ───────
    // (Images are now handled in handleDirectImageUpload — never reach here with images)
    const roRestores = [...roMap.values()].map(({ roDoc, fields, changeLogEntries }) => {
      const restoreFields = {}
      Object.keys(fields).forEach(key => {
        if (key === 'updatedAt') return
        const prev = getPathValue(roDoc, key)
        restoreFields[key] = prev === undefined ? deleteField() : prev
      })
      return { roId: roDoc.id, fields: restoreFields, changeLogEntries }
    })

    const firestorePromises = [...roMap.values()].map(({ roDoc, fields, changeLogEntries, taskPromises }) => {
      const updates = { ...fields }
      if (changeLogEntries.length) updates.changeLog = arrayUnion(...changeLogEntries)
      return Promise.all([
        updateDoc(doc(db, 'ros', roDoc.id), updates),
        ...taskPromises,
      ])
    })
    firestorePromises.push(...standaloneTaskPromises)

    // ── Step 3: await everything ───────────────────────────────────────────────
    try {
      await withApplyTimeout(Promise.all(firestorePromises))

      // ── Toasts ──────────────────────────────────────────────────────────────
      if (actions.length > 0) {
        const allNums = [...new Set(actions.map(a => a.roNumber).filter(Boolean))].map(n => `#${n}`).join(', ')
        toast.success(`${actions.length} update${actions.length !== 1 ? 's' : ''} applied to RO ${allNums}`)
      }

      setApplied(true)
      setRecentApplied({
        at: new Date().toISOString(),
        summary: actions.map(actionSummary).slice(0, 4),
        actionCount: actions.length,
        roRestores,
        taskRefs: createdTaskRefs,
      })
      setResult(null)
      setActions([])
      setText('')
      setImages([])
      setTimeout(() => setApplied(false), 2500)
    } catch (err) {
      console.error('[handleApply]', err)
      setError('Apply failed: ' + err.message)
    } finally {
      setApplying(false)   // ALWAYS unblock the button, even on error
    }
    } catch (err) {
      // Catches throws from Step 1/2 (action bucketing) that escape the inner try.
      console.error('[handleApply:outer]', err)
      setError('Apply failed: ' + err.message)
      setApplying(false)
    }
  }

  const canSubmit = (text.trim() || images.length > 0) && !loading && !applying && !isTranscribing
  const mentionCandidates = useMemo(() => buildMentionCandidates(employees, []), [employees])
  const reviewGroups = useMemo(() => groupActionsForPreview(actions, ros), [actions, ros])
  const visibleClarification = result?.needsClarification
    && !shouldHideResolvedBodyTechClarification(result.needsClarification, result.actions || [], submittedText.current || text, ros, employees)
    ? result.needsClarification
    : ''

  const handleUndoRecent = async () => {
    if (!recentApplied || undoing) return
    setUndoing(true)
    setError('')
    try {
      const roRestores = recentApplied.roRestores.map(item => updateDoc(doc(db, 'ros', item.roId), {
        ...item.fields,
        ...(item.changeLogEntries?.length ? { changeLog: arrayRemove(...item.changeLogEntries) } : {}),
        updatedAt: serverTimestamp(),
      }))
      const taskDeletes = recentApplied.taskRefs.map(ref => deleteDoc(ref))
      await Promise.all([...roRestores, ...taskDeletes])
      toast.success('Last GIB update undone')
      setRecentApplied(null)
    } catch (err) {
      setError('Undo failed: ' + err.message)
    } finally {
      setUndoing(false)
    }
  }

  if (compact) {
    return (
      <>
        {showPhotoSheet && (
          <PhotoSheet
            onCamera={() => { setShowPhotoSheet(false); setTimeout(() => setShowCamera(true), 50) }}
            onLibrary={() => { setShowPhotoSheet(false); setTimeout(() => fileInputRef.current?.click(), 50) }}
            onClose={() => setShowPhotoSheet(false)}
          />
        )}
        {showCamera && (
          <CameraModal
            onDone={(shots) => { setImages(prev => [...prev, ...shots]); setShowCamera(false) }}
            onClose={() => setShowCamera(false)}
          />
        )}
        <div className="rounded-xl border border-blue-200 bg-white/95 p-2.5 shadow-xl shadow-black/10 backdrop-blur dark:border-blue-800 dark:bg-zinc-900/95">
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <div className="hidden w-[112px] shrink-0 md:block">
              <p className="text-xs font-bold uppercase leading-tight tracking-wide text-gray-700 dark:text-zinc-200">Quick Update</p>
              <p className="truncate text-[11px] leading-tight text-gray-400 dark:text-zinc-500">{compactSubtitle}</p>
            </div>
            <MentionTextarea
              value={text}
              onChange={e => setText(e.target.value)}
              candidates={mentionCandidates}
              dropdownPlacement="inside"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                  e.preventDefault()
                  if (canSubmit) handleSubmit(e)
                }
              }}
              placeholder={compactPlaceholder}
              rows={1}
              className="h-[44px] min-h-[44px] w-full resize-none overflow-hidden rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-7 text-gray-900 placeholder-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-gray-100 dark:placeholder-zinc-600"
              disabled={loading || applying}
            />
            <button
              type="button"
              onClick={toggleVoice}
              disabled={isTranscribing}
              title="Voice"
              className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border transition-colors ${
                listening
                  ? 'border-red-500 bg-red-500 text-white'
                  : isTranscribing
                  ? 'border-purple-300 bg-purple-100 text-purple-600 dark:border-purple-700 dark:bg-purple-950/40'
                  : 'border-gray-300 bg-white text-gray-500 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {isTranscribing
                ? <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                : <IconMic active={listening} />
              }
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Photos"
              className="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-500 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
            >
              <IconImage />
              {images.length > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                  {images.length}
                </span>
              )}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="h-[42px] shrink-0 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
            >
              {loading ? 'Parsing...' : applying ? 'Applying...' : images.length > 0 ? 'Upload' : 'Submit'}
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
          </form>

          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="relative h-12 w-12 overflow-hidden rounded-lg border border-blue-200 dark:border-blue-900">
                  <img src={img.preview} alt={img.name} className="h-full w-full object-cover" />
                  <button type="button" onClick={() => removeImage(i)} className="absolute inset-0 flex items-center justify-center bg-black/60 text-white opacity-0 transition-opacity hover:opacity-100">
                    <IconX2 />
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {visibleClarification && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              ? {result.needsClarification}
            </div>
          )}
          {actions.length > 0 && !applied && (
            <div className="mt-2 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-400">
                {actions.length} action{actions.length > 1 ? 's' : ''} to confirm
              </p>
              <div className="max-h-[42vh] overflow-y-auto pr-1">
                {reviewGroups.map(group => (
                  <ActionReviewGroup
                    key={group.key}
                    group={group}
                    employees={employees}
                    ros={ros}
                    onChangeAt={(idx, updated) => setActions(prev => prev.map((a, i) => i === idx ? updated : a))}
                    onDeleteAt={(idx) => setActions(prev => prev.filter((_, i) => i !== idx))}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={applying || actions.length === 0}
                  className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                >
                  {applying ? 'Applying...' : `Apply ${actions.length}`}
                </button>
                <button
                  type="button"
                  onClick={() => { setResult(null); setActions([]); setImages([]) }}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {applied && (
            <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              All updates applied successfully.
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <>
    {showPhotoSheet && (
      <PhotoSheet
        onCamera={() => { setShowPhotoSheet(false); setTimeout(() => setShowCamera(true), 50) }}
        onLibrary={() => { setShowPhotoSheet(false); setTimeout(() => fileInputRef.current?.click(), 50) }}
        onClose={() => setShowPhotoSheet(false)}
      />
    )}
    {showCamera && (
      <CameraModal
        onDone={(shots) => { setImages(prev => [...prev, ...shots]); setShowCamera(false) }}
        onClose={() => setShowCamera(false)}
      />
    )}
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-blue-100 dark:border-blue-900 shadow-sm p-4 mb-4">

      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 leading-tight">Quick Update</h2>
          <p className="text-xs text-gray-400 dark:text-zinc-500">
            {images.length > 0 ? '📷 Photos ready — tap Submit to upload' : 'type or speak — AI will parse & apply'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHistory(v => !v)}
          className={`shrink-0 p-1.5 rounded-lg border text-xs transition-colors ${
            showHistory
              ? 'bg-blue-50 border-blue-300 text-blue-600 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
              : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'
          }`}
          title="GIB history"
        >
          <IconHistory />
        </button>
      </div>

      {showHistory && (
        <div className="mb-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
            <p className="text-xs font-semibold text-gray-700 dark:text-zinc-200">Recent GIB inputs</p>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(GIB_HISTORY_KEY)
                setHistory([])
              }}
              className="text-xs text-gray-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
            >
              Clear
            </button>
          </div>
          {history.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-400 dark:text-zinc-500">No history yet.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto p-1">
              {history.map((item, idx) => (
                <button
                  key={`${idx}-${item}`}
                  type="button"
                  onClick={() => useHistoryItem(item)}
                  className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800"
                >
                  <span className="line-clamp-2">{item}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2.5 mb-4">
          {images.map((img, i) => (
            <div key={i} className="relative group w-20 h-20 rounded-xl overflow-hidden border-2 border-blue-200 dark:border-blue-900 shadow-sm">
              <img src={img.preview} alt={img.name} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute inset-0 bg-black/60 text-white opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity flex items-center justify-center"
              >
                <IconX2 />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* ── Textarea ─────────────────────────────────────────────────── */}
        <MentionTextarea
          value={text}
          onChange={e => setText(e.target.value)}
          candidates={mentionCandidates}
          dropdownPlacement="inside"
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault()
              if (canSubmit) handleSubmit(e)
            }
          }}
          placeholder={images.length > 0
            ? 'RO number + photo type, e.g. "9556 check-in" or "9556 in progress photos"'
            : fullPlaceholder}
          rows={4}
          className="w-full min-h-[118px] px-4 py-3 mb-3 border border-gray-200 dark:border-zinc-700 rounded-xl text-base sm:text-sm leading-relaxed bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-800 resize-none transition-colors"
          disabled={loading || applying}
        />

        {/* ── Mobile button layout ──────────────────────────────────────── */}
        <div className="sm:hidden space-y-2.5">
          {/* Voice + Photos — 2-col */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* Voice button — Whisper powered */}
            <button
              type="button"
              onClick={toggleVoice}
              disabled={isTranscribing}
              className={`flex items-center justify-center gap-2.5 h-12 rounded-xl border text-sm font-semibold transition-all active:scale-95
                ${listening
                  ? 'bg-red-500 border-red-400 text-white'
                  : isTranscribing
                  ? 'bg-purple-100 border-purple-300 dark:bg-purple-950/40 dark:border-purple-800 text-purple-600 dark:text-purple-300'
                  : 'bg-gray-50 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-300'}`}
            >
              {listening ? (
                /* Live audio-level bars driven by AudioContext analyser */
                <>
                  <span className="flex items-end gap-[3px] h-4">
                    {[0,1,2,3,4].map(i => (
                      <span key={i} className="w-[3px] rounded-full bg-white transition-none"
                        style={{ height: `${Math.max(20, Math.min(100, (audioLevel * 100) * [0.6,1,0.8,0.9,0.7][i] + 15))}%` }} />
                    ))}
                  </span>
                  <span className="text-xs font-mono">
                    {String(Math.floor(recordSecs/60)).padStart(2,'0')}:{String(recordSecs%60).padStart(2,'0')}
                  </span>
                </>
              ) : isTranscribing ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  <span className="text-xs">Transcribing</span>
                </>
              ) : (
                <>
                  <IconMic active={false} cls="w-5 h-5" />
                  <span>Voice</span>
                </>
              )}
            </button>

            {/* Photos — opens PhotoSheet: 拍照 / 照片图库 */}
            <button
              type="button"
              onClick={() => setShowPhotoSheet(true)}
              className="relative flex items-center justify-center gap-2.5 h-12 rounded-xl border bg-gray-50 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-sm font-semibold transition-all active:scale-95"
            >
              <IconImage cls="w-5 h-5" />
              {images.length > 0 ? `Photos (${images.length})` : 'Photos'}
            </button>
          </div>

          {/* Full-width submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full h-[52px] bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white text-base font-bold rounded-xl transition-all active:scale-[0.98]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                {uploadProgress.total > 0
                  ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                  : images.length > 0 ? 'Uploading…' : 'Parsing…'}
              </span>
            ) : applying ? 'Applying…' : images.length > 0 ? `Upload ${images.length} Photo${images.length !== 1 ? 's' : ''} →` : 'Submit →'}
          </button>
        </div>

        {/* ── Desktop button layout (inline row) ───────────────────────── */}
        <div className="hidden sm:flex items-center gap-2">
          <button
            type="button"
            onClick={toggleVoice}
            disabled={isTranscribing}
            className={`flex items-center justify-center px-2.5 py-2 rounded-lg border transition-colors shrink-0
              ${listening
                ? 'bg-red-500 border-red-500 text-white'
                : isTranscribing
                ? 'bg-purple-100 border-purple-300 text-purple-600 dark:bg-purple-950/40 dark:border-purple-700'
                : 'border-gray-300 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'}`}
          >
            {isTranscribing
              ? <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
              : <IconMic active={listening} />
            }
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="relative flex items-center justify-center px-2.5 py-2 rounded-lg border border-gray-300 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800 transition-colors shrink-0"
          >
            <IconImage />
            {images.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {images.length}
              </span>
            )}
          </button>

          {listening      && <span className="text-xs text-red-500 font-medium">🎙 {String(Math.floor(recordSecs/60)).padStart(2,'0')}:{String(recordSecs%60).padStart(2,'0')}</span>}
          {isTranscribing && <span className="text-xs text-purple-600 font-medium animate-pulse">✨ Transcribing…</span>}
          <div className="flex-1" />

          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                {uploadProgress.total > 0
                  ? `${uploadProgress.done}/${uploadProgress.total}…`
                  : images.length > 0 ? 'Uploading…' : 'Parsing…'}
              </span>
            ) : images.length > 0 ? `Upload ${images.length} Photo${images.length !== 1 ? 's' : ''}` : 'Submit'}
          </button>
        </div>

        {/* Gallery picker — multiple select */}
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
        {/* Camera capture — opens native camera directly, reset after each shot for re-use */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
      </form>

      {noKey && (
        <div className="mt-3 flex items-center gap-2 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <span>⚙</span>
          <span>AI not configured. <a href="/settings" className="underline font-medium">Add your Anthropic API key in Settings</a>.</span>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {result?.translation && (
        <div className="mt-3 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 rounded px-3 py-1.5">
          🌐 Translated: "{result.translation}"
        </div>
      )}

      {visibleClarification && (
        <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ❓ {result.needsClarification}
        </div>
      )}

      {/* Action cards — editable */}
      {actions.length > 0 && !applied && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide flex items-center gap-2">
            {actions.length} action{actions.length > 1 ? 's' : ''} — edit or remove, then confirm:
            {reparsing && (
              <span className="flex items-center gap-1 text-blue-400 font-normal normal-case tracking-normal">
                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                updating…
              </span>
            )}
          </p>
          {reviewGroups.map(group => (
            <ActionReviewGroup
              key={group.key}
              group={group}
              employees={employees}
              ros={ros}
              onChangeAt={(idx, updated) => setActions(prev => prev.map((a, i) => i === idx ? updated : a))}
              onDeleteAt={(idx) => setActions(prev => prev.filter((_, i) => i !== idx))}
            />
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleApply}
              disabled={applying || actions.length === 0}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {applying ? 'Applying…' : `✓ Apply ${actions.length} Action${actions.length !== 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => { setResult(null); setActions([]); setImages([]) }}
              className="px-3 py-1.5 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div className="mt-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          ✅ All updates applied successfully!
        </div>
      )}

      {recentApplied && !actions.length && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/70">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-700 dark:text-zinc-200">
                Recently applied · {recentApplied.actionCount} action{recentApplied.actionCount === 1 ? '' : 's'}
              </p>
              <div className="mt-1 space-y-0.5">
                {recentApplied.summary.map((item, idx) => (
                  <p key={`${idx}-${item}`} className="truncate text-xs text-gray-500 dark:text-zinc-400">- {item}</p>
                ))}
                {recentApplied.actionCount > recentApplied.summary.length && (
                  <p className="text-xs text-gray-400 dark:text-zinc-500">+ {recentApplied.actionCount - recentApplied.summary.length} more</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={handleUndoRecent}
              disabled={undoing}
              className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-red-700 dark:hover:text-red-300"
            >
              {undoing ? 'Undoing...' : 'Undo'}
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  )
}
