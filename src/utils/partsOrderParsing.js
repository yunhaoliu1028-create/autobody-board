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

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

const ORDER_CONTEXT_RE = /\b(?:order|ordered|ordering)\b|订|訂|下单|下單/iu
const RESOLVED_RECEIPT_RE = /\b(?:the\s+)?(?:\d+\s+)?parts?\s+ordered\s+(?:from|via|thru|through)\b[^.;\n]*?\b(?:have|has|were|was|are)?\s*(?:all\s+)?(?:been\s+)?(?:received|recieved|rcvd|complete)\b/i
const RESOLVED_CHINESE_RECEIPT_RE = /(?:从|跟)\s*[A-Za-z][A-Za-z0-9&+.' -]*?\s*(?:订|訂|定|下单|下單)[^。；!?！？\n]*?(?:全[^。；!?！？\n]*(?:收齐|收齊|收到)|已[^。；!?！？\n]*(?:收齐|收齊|收到))/u
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

function formatDate(year, month, day) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const fullYear = y < 100 ? 2000 + y : y
  const candidate = new Date(Date.UTC(fullYear, m - 1, d))
  if (candidate.getUTCFullYear() !== fullYear || candidate.getUTCMonth() !== m - 1 || candidate.getUTCDate() !== d) return null
  return `${fullYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseDateText(value = '', defaultYear = new Date().getFullYear()) {
  const text = String(value)
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)
  if (numeric) return formatDate(numeric[3] || defaultYear, numeric[1], numeric[2])

  const named = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i)
  if (named) return formatDate(named[3] || defaultYear, MONTHS[named[1].toLowerCase()], named[2])

  const chinese = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/u)
  if (chinese) return formatDate(chinese[1] || defaultYear, chinese[2], chinese[3])
  return null
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
    .split(/(?:\r?\n)+|[.;。；!?！？]+|,(?=\s*(?:order|ordered|ordering)\b)/i)
    .map(scope => scope.trim())
    .filter(Boolean)
}

function nearbyEta(scope, matchEnd, defaultYear) {
  const tail = scope.slice(matchEnd, matchEnd + 100)
  const etaContext = tail.match(/^[\s,]*(?:today\s*)?(?:all\s+)?(?:eta|due|arriv(?:e|es|ing|al)?)(.{0,40})/i)
  return etaContext ? parseDateText(etaContext[0], defaultYear) : null
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

/**
 * Extract explicit new parts orders without treating a completed historical
 * order ("parts ordered from X have all been received") as another order.
 */
export function extractPartsOrderCandidates(inputText = '', { defaultYear = new Date().getFullYear() } = {}) {
  const text = String(inputText || '')
  if (!ORDER_CONTEXT_RE.test(text)) return []

  const defaultRoNumber = text.match(/\b(?:RO|#)?\s*(\d{4,6})\b/i)?.[1] || ''
  const candidates = []
  const seen = new Map()

  const push = ({ vendor: rawVendor, qty = null, eta = null, roNumber = defaultRoNumber }) => {
    if (VENDOR_RECEIPT_FRAGMENT_RE.test(String(rawVendor || ''))) return
    const vendor = cleanVendor(rawVendor)
    const vendorKey = normalizeKey(vendor)
    if (!vendorKey) return
    const key = `${roNumber || '*'}:${vendorKey}`
    const next = { roNumber, vendor, qty: parseQty(qty), eta: eta || null }
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, candidates.length)
      candidates.push(next)
      return
    }
    const existing = candidates[existingIndex]
    candidates[existingIndex] = {
      ...existing,
      qty: existing.qty || next.qty,
      eta: existing.eta || next.eta,
    }
  }

  for (const scope of splitOrderScopes(text)) {
    if (!ORDER_CONTEXT_RE.test(scope) || RESOLVED_RECEIPT_RE.test(scope) || RESOLVED_CHINESE_RECEIPT_RE.test(scope)) continue

    const roNumber = scope.match(/\b(?:RO|#)?\s*(\d{4,6})\b/i)?.[1] || defaultRoNumber
    const scopeEta = parseDateText(scope, defaultYear)
    const scopeCommonEtaMatch = scope.match(/\ball\s+eta\b(.{0,40})/i)
    const scopeCommonEta = scopeCommonEtaMatch ? parseDateText(scopeCommonEtaMatch[0], defaultYear) : null

    const qtyFromVendorRe = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:pc|pcs|part|parts|piece|pieces)?\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\b(?:and|then)\s+(?:order|ordered|ordering)\b|\ball\s+eta\b|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(qtyFromVendorRe)) {
      if (receiptIntentIsNearest(scope, match.index || 0)) continue
      push({
        roNumber,
        qty: match[1],
        vendor: match[2],
        eta: nearbyEta(scope, (match.index || 0) + match[0].length, defaultYear) || scopeCommonEta || scopeEta,
      })
    }

    const describedOrderRe = /(?:^|[,/]|\band\b)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][a-z0-9 &+.'-]*?)\s+ordered\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(describedOrderRe)) {
      push({ roNumber, qty: match[1], vendor: match[3], eta: nearbyEta(scope, (match.index || 0) + match[0].length, defaultYear) || scopeCommonEta || scopeEta })
    }

    const partsViaVendorRe = /\b(?:order|ordered|ordering)\s+parts?\s+(?:from|via|thru|through)\s+(.+?)(?=\s*(?:,|$|\beta\b|\bdue\b|\barriv(?:e|es|ing|al)?\b))/gi
    for (const match of scope.matchAll(partsViaVendorRe)) {
      push({ roNumber, vendor: match[1], eta: nearbyEta(scope, (match.index || 0) + match[0].length, defaultYear) || scopeCommonEta || scopeEta })
    }

    const chineseVendorRe = /(?:从|跟)\s*([A-Za-z][A-Za-z0-9&+.' -]*?)\s*(?:订|訂|定|下单|下單)/gu
    for (const match of scope.matchAll(chineseVendorRe)) {
      push({ roNumber, vendor: match[1], eta: scopeEta })
    }
  }

  return candidates
}
