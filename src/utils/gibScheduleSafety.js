import { findDateToken } from './dateParsing.js'
import { buildRoInputScopes } from './gibInputScope.js'
import { extractPartsOrderCandidates } from './partsOrderParsing.js'

function dropOffDateForScope(scope = '', defaultYear) {
  const patterns = [
    /((?:\d{1,2}\s*月\s*\d{1,2}\s*[日号號]?)|(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?))[^。；!?！？\n]{0,24}(?:放车|放過來|放过来|来放车|送来|送過來|进店|進店)/iu,
    /(?:放车|放過來|放过来|来放车|送来|送過來|进店|進店)[^。；!?！？\n]{0,24}((?:\d{1,2}\s*月\s*\d{1,2}\s*[日号號]?)|(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?))/iu,
    /(?:vehicle\s+)?(?:is\s+)?(?:expected\s+to\s+)?(?:drop(?:ped)?\s*off|drop-?off)(?:\s+(?:on|is|around|approximately))?\s*((?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)|(?:[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?))/i,
  ]
  for (const pattern of patterns) {
    const match = scope.match(pattern)
    const token = match ? findDateToken(match[1], defaultYear) : null
    if (token?.normalized) return token.normalized
  }
  return null
}

function normalizeVendor(value = '') {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
  return ['kaystone', 'keyston', 'kystone'].includes(normalized) ? 'keystone' : normalized
}

function actionMatchesOrder(action = {}, order = {}) {
  const vendors = [action.vendor, action.vendorFull].map(normalizeVendor).filter(Boolean)
  return String(action.roNumber ?? '') === String(order.roNumber ?? '')
    && vendors.includes(normalizeVendor(order.vendor))
}

function shortDate(date = '') {
  const match = String(date).match(/\d{4}-(\d{2})-(\d{2})/)
  return match ? `${Number(match[1])}/${Number(match[2])}` : date
}

function fixNote(note = '', futureDropOffDate = null, prospectiveOrders = []) {
  let next = String(note || '')
  if (futureDropOffDate) {
    next = next.replace(
      /Vehicle\s+(?:was\s+)?dropped off on\s+\d{1,2}[/-]\d{1,2}/i,
      `Vehicle scheduled to drop off on ${shortDate(futureDropOffDate)}`,
    )
  }

  for (const order of prospectiveOrders) {
    next = next.split(/(?<=\.)\s+/).map(sentence => {
      const normalizedSentence = normalizeVendor(sentence)
      if (!/\breceived\b/i.test(sentence) || !normalizedSentence.includes(normalizeVendor(order.vendor))) return sentence
      const qty = order.qty ? `${order.qty} part${order.qty === 1 ? '' : 's'}` : 'parts'
      const eta = order.eta ? `, ETA ${shortDate(order.eta)}` : ''
      return `Ordered ${qty} from ${order.vendor}${eta}.`
    }).join(' ')
  }
  return next
}

export function reconcileScheduledActions(
  actions = [],
  inputText = '',
  { today = new Date().toISOString().slice(0, 10), knownRoNumbers = [] } = {},
) {
  if (!Array.isArray(actions) || !actions.length) return actions
  const actionRoNumbers = actions.map(action => String(action.roNumber ?? '')).filter(Boolean)
  const candidates = [...knownRoNumbers, ...actionRoNumbers]
  const scopes = buildRoInputScopes(inputText, candidates)
  const defaultYear = Number(String(today).slice(0, 4)) || new Date().getFullYear()
  const explicitOrders = extractPartsOrderCandidates(inputText, { defaultYear, knownRoNumbers: candidates })

  return actions.map(action => {
    const roNumber = String(action.roNumber ?? '')
    const dropOffDate = dropOffDateForScope(scopes.get(roNumber), defaultYear)
    const futureDropOff = Boolean(dropOffDate && dropOffDate > today)
    const prospectiveOrders = explicitOrders.filter(order => String(order.roNumber) === roNumber)

    if (action.type === 'update_dropoff_date' && dropOffDate) return { ...action, dropOffDate }
    if (action.type === 'update_car_status' && futureDropOff) return { ...action, carStatus: 'pending_dropoff' }

    if (action.type === 'log_parts_received') {
      const order = prospectiveOrders.find(candidate => actionMatchesOrder(action, candidate))
      if (order) {
        const {
          note, notes, receiveMode, currentQtyReceived, nextQtyReceived, totalQty,
          receivedQty, ...rest
        } = action
        return {
          ...rest,
          type: 'update_parts_order',
          vendor: order.vendor,
          vendorFull: order.vendor,
          description: 'Parts order',
          qty: order.qty || totalQty || action.qtyReceived || action.receivedQty || null,
          qtyReceived: 0,
          eta: order.eta,
          status: 'ordered',
        }
      }
    }

    if (action.type === 'add_note' && action.note) {
      return { ...action, note: fixNote(action.note, futureDropOff ? dropOffDate : null, prospectiveOrders) }
    }
    return action
  })
}
