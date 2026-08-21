import { buildRoInputScopes } from './gibInputScope.js'
import { findDateToken } from './dateParsing.js'

const NUMBER_WORDS = {
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

const ORDER_CONTEXT_RE = /\b(?:order|ordered|ordering)\b|订|訂|下单|下單/iu
const RESOLVED_RECEIPT_RE = /\b(?:the\s+)?(?:\d+\s+)?parts?\s+ordered\s+(?:from|via|thru|through)\b[^.;\n]*?\b(?:have|has|were|was|are)?\s*(?:all\s+)?(?:been\s+)?(?:received|recieved|rcvd|complete)\b/i
const RESOLVED_CHINESE_RECEIPT_RE = /(?:从|跟|向)\s*[A-Za-z][A-Za-z0-9&+.' -]*?\s*(?:订购|訂購|订|訂|定|下单|下單)[^。；!?！？\n]*?(?:全[^。；!?！？\n]*(?:收齐|收齊|收到)|已[^。；!?！？\n]*(?:收齐|收齊|收到))/u
const PROSPECTIVE_CHINESE_RECEIPT_RE = /(?:预计|預計|大概|约|約|会|會)[^。；!?！？\n]{0,40}(?:收到|收齐|收齊|到齐|到齊)/u
const VENDOR_RECEIPT_FRAGMENT_RE = /\b(?:have|has|were|was|are)?\s*(?:all\s+)?(?:been\s+)?(?:received|recieved|rcvd)\b/i
const PARSING_METADATA_WORDS = new Set([
  'today', 'tomorrow', 'yesterday',
  'have', 'has', 'had', 'all', 'been',
  'received', 'recieved', 'rcvd', 'complete',
])

function normalizeKey(value = '') {
  const key = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (['kaystone', 'keyston', 'kystone', 'key stone'].includes(key)) return 'keystone'
  return key.replace(/\s+/g, ' ')
}

function withoutParsingMetadata(value = '') {
  const words = normalizeKey(value).split(' ').filter(Boolean)
  while (words.length > 1 && PARSING_METADATA_WORDS.has(words.at(-1))) words.pop()
  return words.join(' ')
}

export function vendorsMatchIgnoringParsingMetadata(left = '', right = '') {
  const a = withoutParsingMetadata(left)
  const b = withoutParsingMetadata(right)
  return Boolean(a && b && a === b)
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function receivedNumber(action = {}) {
  const raw = action.qtyReceived ?? action.receivedQty
  const number = Number(raw)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function orderCompleteness(action = {}) {
  let score = 0
  if (action.eta) score += 4
  if (positiveNumber(action.qty ?? action.quantity)) score += 3
  if (String(action.vendorFull || '').trim()) score += 2
  if (String(action.description || '').trim()) score += 1
  return score
}

export function mergePreferredPartsOrderActions(existing = {}, incoming = {}) {
  const incomingWins = orderCompleteness(incoming) > orderCompleteness(existing)
  const winner = incomingWins ? incoming : existing
  const fallback = incomingWins ? existing : incoming
  return {
    ...fallback,
    ...winner,
    vendor: winner.vendor || fallback.vendor,
    vendorFull: winner.vendorFull || fallback.vendorFull,
    eta: winner.eta || fallback.eta || null,
    qty: positiveNumber(winner.qty ?? winner.quantity) || positiveNumber(fallback.qty ?? fallback.quantity),
    qtyReceived: receivedNumber(winner) ?? receivedNumber(fallback) ?? 0,
  }
}

function parseQty(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return NUMBER_WORDS[String(value || '').toLowerCase()] ?? null
}

function cleanVendor(value = '') {
  const cleaned = String(value)
    .replace(VENDOR_RECEIPT_FRAGMENT_RE, '')
    .replace(/\b(?:all\s+)?eta\b.*$/i, '')
    .replace(/\b(?:due|arriv(?:e|es|ing|al)?)\b.*$/i, '')
    .replace(/\s+(?:today|tomorrow|yesterday)\s*$/i, '')
    .replace(/(?:今天|明天|昨天)\s*$/u, '')
    .replace(/^[\s:：,，;；/.-]+|[\s:：,，;；/.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalizeKey(cleaned) === 'keystone' ? 'Keystone' : cleaned
}

function splitOrderScopes(text = '') {
  return String(text)
    .split(/(?:\r?\n)+|[•]|[.;。；!?！？]+|,(?=\s*(?:order|ordered|ordering)\b)/i)
    .map(scope => scope.trim())
    .filter(Boolean)
}

function nearbyEtaEvidence(scope, matchEnd, defaultYear) {
  const tail = scope.slice(matchEnd, matchEnd + 100)
  const etaContext = tail.match(/^[\s,]*(?:today\s*)?(?:all\s+)?(?:eta|due|arriv(?:e|es|ing|al)?)(.{0,40})/i)
  if (!etaContext) return null
  return findDateToken(etaContext[0], defaultYear)
}

function nearbyChineseOrderDateEvidence(scope, matchEnd, defaultYear) {
  const tail = scope.slice(matchEnd, matchEnd + 100)
  const nextVendorMatch = tail.match(/(?:从|跟|向)\s*[A-Za-z][A-Za-z0-9&+.' -]*?\s*(?:订购|訂購|订|訂|定|下单|下單)/u)
  const nextVendorBoundary = nextVendorMatch?.index ?? -1
  const hardBoundary = tail.search(/[.;。；!?！？\n]/u)
  const boundaries = [nextVendorBoundary, hardBoundary].filter(index => index >= 0)
  const localClause = boundaries.length ? tail.slice(0, Math.min(...boundaries)) : tail
  return findDateToken(localClause, defaultYear)
}

function receiptIntentIsNearest(scope, matchIndex) {
  const prefix = scope.slice(0, matchIndex)
  const lastIndex = (pattern) => {
    let index = -1
    for (const match of prefix.matchAll(pattern)) index = match.index ?? index
    return index
  }
  const lastOrder = lastIndex(/\b(?:order|ordered|ordering)\b/gi)
  const lastReceipt = lastIndex(/\b(?:received|recieved|rcvd|got)\b/gi)
  return lastReceipt > lastOrder
}

function candidateRoNumbersFromText(inputText = '') {
  const text = String(inputText || '')
  const numbers = []
  const add = (value) => {
    const normalized = String(value || '').trim()
    if (/^\d{3,8}$/.test(normalized) && !numbers.includes(normalized)) numbers.push(normalized)
  }

  for (const match of text.matchAll(/\b(?:RO\s*#?|#)\s*(\d{3,8})\b/gi)) add(match[1])
  for (const match of text.matchAll(/(?:^|[\r\n.;。；!?！？])\s*(\d{4,6})\b/gu)) add(match[1])
  return numbers
}

function mergeCandidateRecords(candidates = []) {
  const merged = []
  const seen = new Map()
  for (const candidate of candidates) {
    const key = `${candidate.roNumber || '*'}:${normalizeKey(candidate.vendor)}`
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, merged.length)
      merged.push(candidate)
      continue
    }
    const existing = merged[existingIndex]
    const mergedCandidate = {
      ...existing,
      qty: existing.qty || candidate.qty,
      eta: existing.eta || candidate.eta,
    }
    const invalidDate = existing.invalidDate || candidate.invalidDate
    if (invalidDate) mergedCandidate.invalidDate = invalidDate
    merged[existingIndex] = mergedCandidate
  }
  return merged
}

/**
 * Extract explicit new parts orders without treating a completed historical
 * order ("parts ordered from X have all been received") as another order.
 */
function extractPartsOrderCandidatesInScope(
  inputText = '',
  { defaultYear = new Date().getFullYear(), scopedRoNumber = '' } = {},
) {
  const text = String(inputText || '')
  if (!ORDER_CONTEXT_RE.test(text)) return []

  const defaultRoNumber = String(scopedRoNumber || candidateRoNumbersFromText(text)[0] || '')
  const candidates = []
  const seen = new Map()

  const push = ({ vendor: rawVendor, qty = null, eta = null, invalidDate = null, roNumber = defaultRoNumber }) => {
    if (VENDOR_RECEIPT_FRAGMENT_RE.test(String(rawVendor || ''))) return
    const vendor = cleanVendor(rawVendor)
    const vendorKey = normalizeKey(vendor)
    if (!vendorKey) return
    const key = `${roNumber || '*'}:${vendorKey}`
    const next = { roNumber, vendor, qty: parseQty(qty), eta: eta || null }
    if (invalidDate) next.invalidDate = invalidDate
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, candidates.length)
      candidates.push(next)
      return
    }
    const existing = candidates[existingIndex]
    const mergedCandidate = {
      ...existing,
      qty: existing.qty || next.qty,
      eta: existing.eta || next.eta,
    }
    const mergedInvalidDate = existing.invalidDate || next.invalidDate
    if (mergedInvalidDate) mergedCandidate.invalidDate = mergedInvalidDate
    candidates[existingIndex] = mergedCandidate
  }

  for (const scope of splitOrderScopes(text)) {
    const resolvedChineseReceipt = RESOLVED_CHINESE_RECEIPT_RE.test(scope)
      && !PROSPECTIVE_CHINESE_RECEIPT_RE.test(scope)
    if (!ORDER_CONTEXT_RE.test(scope) || RESOLVED_RECEIPT_RE.test(scope) || resolvedChineseReceipt) continue

    const roNumber = String(scopedRoNumber || candidateRoNumbersFromText(scope)[0] || defaultRoNumber)
    const scopeCommonEtaMatch = scope.match(/\ball\s+eta\b(.{0,40})/i)
    const scopeCommonEtaEvidence = scopeCommonEtaMatch
      ? findDateToken(scopeCommonEtaMatch[0], defaultYear)
      : null
    const scopeCommonEta = scopeCommonEtaEvidence?.normalized || null
    const scopeCommonInvalidDate = scopeCommonEtaEvidence && scopeCommonEtaEvidence.normalized === null
      ? scopeCommonEtaEvidence.raw
      : null

    const dateFieldsForMatch = (match) => {
      const nearbyEvidence = nearbyEtaEvidence(
        scope,
        (match.index || 0) + match[0].length,
        defaultYear,
      )
      const invalidDate = nearbyEvidence && nearbyEvidence.normalized === null
        ? nearbyEvidence.raw
        : scopeCommonInvalidDate
      return {
        // A vendor-specific ETA belongs only to the vendor immediately before it.
        // Share a date across vendors only when the user explicitly says "all ETA".
        eta: nearbyEvidence?.normalized || scopeCommonEta,
        invalidDate,
      }
    }

    const qtyFromVendorRe = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:pc|pcs|part|parts|piece|pieces)?\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\b(?:and|then)\s+(?:order|ordered|ordering)\b|\ball\s+eta\b|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(qtyFromVendorRe)) {
      if (receiptIntentIsNearest(scope, match.index || 0)) continue
      const dateFields = dateFieldsForMatch(match)
      push({
        roNumber,
        qty: match[1],
        vendor: match[2],
        ...dateFields,
      })
    }

    const describedOrderRe = /(?:^|[,/]|\band\b)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][a-z0-9 &+.'-]*?)\s+ordered\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(describedOrderRe)) {
      push({ roNumber, qty: match[1], vendor: match[3], ...dateFieldsForMatch(match) })
    }

    const partsViaVendorRe = /\b(?:order|ordered|ordering)\s+parts?\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(partsViaVendorRe)) {
      push({ roNumber, vendor: match[1], ...dateFieldsForMatch(match) })
    }

    const chineseVendorRe = /(?:从|跟|向)\s*([A-Za-z][A-Za-z0-9&+.' -]*?)\s*(?:订购|訂購|订|訂|定|下单|下單)(?:了|的)?\s*(?:(\d+)\s*个?\s*(?:部件|零件|件))?/gu
    for (const match of scope.matchAll(chineseVendorRe)) {
      const nearbyEvidence = nearbyChineseOrderDateEvidence(
        scope,
        (match.index || 0) + match[0].length,
        defaultYear,
      )
      const invalidDate = nearbyEvidence && nearbyEvidence.normalized === null
        ? nearbyEvidence.raw
        : scopeCommonInvalidDate
      push({
        roNumber,
        vendor: match[1],
        qty: match[2],
        eta: nearbyEvidence?.normalized || scopeCommonEta,
        invalidDate,
      })
    }
  }

  return candidates
}

export function extractPartsOrderCandidates(
  inputText = '',
  { defaultYear = new Date().getFullYear(), knownRoNumbers = [] } = {},
) {
  const text = String(inputText || '')
  const candidates = [...knownRoNumbers, ...candidateRoNumbersFromText(text)]
  const scopes = buildRoInputScopes(text, candidates)

  if (scopes.size === 0) {
    return extractPartsOrderCandidatesInScope(text, { defaultYear })
  }

  const scopedCandidates = []
  for (const [roNumber, scopedText] of scopes) {
    scopedCandidates.push(...extractPartsOrderCandidatesInScope(scopedText, {
      defaultYear,
      scopedRoNumber: roNumber,
    }))
  }
  return mergeCandidateRecords(scopedCandidates)
}

export function removeCrossRoPartsOrderLeakage(
  actions = [],
  inputText = '',
  explicitOrders = [],
  { knownRoNumbers = [] } = {},
) {
  if (!Array.isArray(actions) || explicitOrders.length === 0) return actions
  const scopes = buildRoInputScopes(inputText, [
    ...knownRoNumbers,
    ...explicitOrders.map(order => order.roNumber),
  ])
  if (scopes.size < 2) return actions

  return actions.filter(action => {
    if (action?.type !== 'update_parts_order' || !action.roNumber) return true
    const actionRoNumber = String(action.roNumber)
    const sameRoOrders = explicitOrders.filter(order => String(order.roNumber || '') === actionRoNumber)
    const actionVendor = withoutParsingMetadata(action.vendorFull || action.vendor)
    const vendorAppearsOnSameRo = Boolean(actionVendor) && sameRoOrders.some(order => (
      withoutParsingMetadata(order.vendor) === actionVendor
    ))
    if (vendorAppearsOnSameRo) return true

    const vendorAppearsOnAnotherRo = Boolean(actionVendor) && explicitOrders.some(order => (
      String(order.roNumber || '') !== actionRoNumber
      && withoutParsingMetadata(order.vendor) === actionVendor
    ))
    if (vendorAppearsOnAnotherRo) return false

    // Keep unmatched actions such as a legitimate vendor ETA update. We only
    // reject an action when its vendor is explicitly tied to another RO scope.
    return true
  })
}
