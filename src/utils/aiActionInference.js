import { buildRoInputScopes, getRoScopedText } from './gibInputScope.js'
import { findDateToken, parseFlexibleDate } from './dateParsing.js'

function contextDateEvidence(text = '', contextPattern, allowDateBefore = false) {
  const source = String(text || '')
  const context = source.match(contextPattern)
  if (!context) return null
  const start = (context.index || 0) + context[0].length
  const window = source.slice(start, start + 100)
  const hardBoundary = window.search(/[.;\n。；!?！？]/u)
  const vendorClauseBoundary = window.search(/,\s*(?=[A-Za-z][^,;\n]{0,50}\b(?:eta|due|arriv(?:e|es|ing|al)?)\b)/i)
  const boundaries = [hardBoundary, vendorClauseBoundary].filter(index => index >= 0)
  const boundedWindow = boundaries.length ? window.slice(0, Math.min(...boundaries)) : window
  const token = findDateToken(boundedWindow)
  if (token) return { ...token, index: token.index + start }
  if (!allowDateBefore) return null

  const prefix = source.slice(Math.max(0, context.index - 60), context.index)
  const lastBoundary = Math.max(
    prefix.lastIndexOf(','),
    prefix.lastIndexOf('，'),
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('；'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
  )
  const boundedPrefix = prefix.slice(lastBoundary + 1)
  const prefixToken = findDateToken(boundedPrefix)
  const prefixStart = Math.max(0, context.index - 60) + lastBoundary + 1
  return prefixToken ? { ...prefixToken, index: prefixToken.index + prefixStart } : null
}

function inferDueDateEvidence(text = '') {
  return contextDateEvidence(
    text,
    /\b(?:target\s+completion(?:\s+date)?|completion\s+date|target\s+date|due\s+date|shop\s+eta|repair\s+eta|customer\s+eta|promised\s+date)\b/i,
  ) || contextDateEvidence(text, /(?:交车|交車|完工|目标日期|目標日期|预计交付|預計交付)/u, true)
}

function inferDropoffDateEvidence(text = '') {
  return contextDateEvidence(
    text,
    /\b(?:dropped\s+off|drop[- ]?off(?:\s+date)?|arrived\s+at\s+(?:the\s+)?shop)\b/i,
  ) || contextDateEvidence(text, /(?:放车|放車|送来|送來|已到|进店|進店)/u, true)
}

function inferPartsDateEvidence(text = '') {
  return contextDateEvidence(
    text,
    /\b(?:(?:parts?|vendor|dealer)\s+)?(?:eta|due|arriv(?:e|es|ing|al)?)\b/i,
  ) || contextDateEvidence(text, /(?:到货|到貨|会到|會到|预计到|預計到)/u, true)
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lastPatternIndex(text = '', pattern) {
  let index = -1
  for (const match of String(text).matchAll(pattern)) index = match.index ?? index
  return index
}

function partsClauseIntent(source = '', vendorStart = 0, localTail = '') {
  const prefix = source.slice(Math.max(0, vendorStart - 120), vendorStart)
  const lastHardBoundary = Math.max(
    prefix.lastIndexOf(','),
    prefix.lastIndexOf('，'),
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('；'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
  )
  const localPrefix = prefix.slice(lastHardBoundary + 1)
  const receiptIndex = Math.max(
    lastPatternIndex(localPrefix, /\b(?:received|recieved|rcvd|got|complete|completed)\b/gi),
    lastPatternIndex(localPrefix, /\b\d+\s*\/\s*\d+\b/g),
    lastPatternIndex(localPrefix, /\ball\s+parts?\s+from\b/gi),
    lastPatternIndex(localPrefix, /(?:收到|收齐|收齊|已收)/gu),
  )
  const orderIndex = Math.max(
    lastPatternIndex(localPrefix, /\b(?:order|ordered|ordering|wait|waiting|await|awaiting|backorder|backordered)\b/gi),
    lastPatternIndex(localPrefix, /(?:订|訂|下单|下單|等待)/gu),
  )
  if (receiptIndex >= 0 || orderIndex >= 0) {
    return receiptIndex > orderIndex ? 'receipt' : 'order'
  }

  const tailBeforeEta = localTail.split(/\b(?:(?:parts?|vendor|dealer)\s+)?(?:eta|due|arriv(?:e|es|ing|al)?)\b/i)[0]
  if (/\b(?:received|recieved|rcvd|got|complete|completed)\b|\b\d+\s*\/\s*\d+\b|(?:收到|收齐|收齊|已收)/iu.test(tailBeforeEta)) return 'receipt'
  if (/\b(?:order|ordered|ordering|wait|waiting|await|awaiting|backorder|backordered)\b|(?:订|訂|下单|下單|等待)/iu.test(tailBeforeEta)) return 'order'
  return 'neutral'
}

function inferPartsDateEvidenceForAction(text = '', action = {}, allActions = []) {
  const source = String(text || '')
  const vendors = [...new Set([action.vendorFull, action.vendor]
    .map(value => String(value || '').trim())
    .filter(Boolean))]
  if (!vendors.length) return null
  const actionRoNumber = String(action.roNumber || '')
  const knownVendors = [...new Set(allActions
    .filter(candidate => String(candidate?.roNumber || '') === actionRoNumber)
    .flatMap(candidate => [candidate?.vendorFull, candidate?.vendor])
    .map(value => String(value || '').trim())
    .filter(Boolean))]

  for (const vendor of vendors) {
    const pattern = escapeRegex(vendor).replace(/\s+/g, '\\s+')
    const vendorRe = new RegExp(`(?:^|[^A-Za-z0-9])(${pattern})(?![A-Za-z0-9])`, 'gi')
    for (const match of source.matchAll(vendorRe)) {
      const vendorStart = (match.index || 0) + match[0].lastIndexOf(match[1])
      const vendorEnd = vendorStart + match[1].length
      const normalizedVendor = vendor.toLowerCase().replace(/\s+/g, ' ')
      const isLongerKnownVendor = knownVendors.some(candidate => {
        const normalizedCandidate = candidate.toLowerCase().replace(/\s+/g, ' ')
        if (!normalizedCandidate.startsWith(`${normalizedVendor} `)) return false
        const candidatePattern = escapeRegex(candidate).replace(/\s+/g, '\\s+')
        return new RegExp(`^${candidatePattern}(?![A-Za-z0-9])`, 'i').test(source.slice(vendorStart))
      })
      if (isLongerKnownVendor) continue
      const tail = source.slice(vendorEnd, vendorEnd + 120)
      const hardBoundary = tail.search(/[.;\n。；!?！？]/u)
      const vendorClauseBoundary = tail.search(/(?:[,，/&+]|\band\b)\s*(?=(?:\d+\s*(?:pc|pcs|part|parts|piece|pieces)?\s+from\b|[A-Za-z][^,;\n]{0,50}\b(?:eta|due|arriv(?:e|es|ing|al)?)\b|(?:从|跟)\s*[A-Za-z]))/iu)
      const nextActionBoundary = tail.search(/\b(?:and|then)\s+(?=(?:order|ordered|ordering|received|recieved|rcvd|got)\b)/i)
      const nextChineseVendorBoundary = tail.search(/(?:从|跟)\s*[A-Za-z][A-Za-z0-9&+.' -]*?\s*(?:订|訂|定|下单|下單)/u)
      const boundaries = [hardBoundary, vendorClauseBoundary, nextActionBoundary, nextChineseVendorBoundary]
        .filter(index => index >= 0)
      const localTail = boundaries.length ? tail.slice(0, Math.min(...boundaries)) : tail
      const intent = partsClauseIntent(source, vendorStart, localTail)
      if (action.type === 'log_parts_received' && intent !== 'receipt') continue
      if (action.type === 'update_parts_order' && intent === 'receipt') continue
      const evidence = inferPartsDateEvidence(localTail)
      if (evidence) return evidence
    }
  }
  return null
}

function withValidDate(action, field, normalized) {
  const { invalidDate: _invalidDate, ...rest } = action
  return { ...rest, [field]: normalized }
}

function withInvalidDate(action, field, rawValue) {
  return {
    ...action,
    [field]: '',
    invalidDate: String(rawValue || action[field] || '').trim(),
    confidence: 'low',
  }
}

function normalizeExistingActionDate(action, field) {
  const value = action?.[field]
  if (value == null || value === '') return action
  const normalized = parseFlexibleDate(value)
  return normalized
    ? withValidDate(action, field, normalized)
    : withInvalidDate(action, field, value)
}

function inferRental(text = '') {
  if (/\b(?:no|without|w\/o|declined)\s+(?:rental|rental\s+car)\b|\b(?:rental|rental\s+car)\s+(?:declined|no|not needed)\b/i.test(text)) {
    return false
  }
  if (/\b(?:rental|rental\s+car)\s+(?:confirmed|yes|provided|active|set|needed|has)\b|\b(?:has|with|w\/)\s+(?:a\s+)?(?:rental|rental\s+car)\b/i.test(text)) {
    return true
  }
  return null
}

function actionText(action = {}) {
  return [
    action.note,
    action.notes,
    action.description,
    action.title,
  ].filter(Boolean).join(' ')
}

function actionHas(actions, roNumber, type) {
  return actions.some(action =>
    action?.type === type
    && String(action.roNumber ?? '') === String(roNumber ?? '')
  )
}

export function inferStructuredActionsFromText(actions = [], inputText = '', knownRoNumbers = []) {
  if (!Array.isArray(actions)) return actions

  const actionRoNumbers = actions.map(action => action?.roNumber).filter(Boolean)
  const candidateRoNumbers = [...knownRoNumbers, ...actionRoNumbers]
  const scopes = buildRoInputScopes(inputText, candidateRoNumbers)
  const targetRoNumbers = [...new Set([...actionRoNumbers.map(String), ...scopes.keys()])]
  const normalizedActions = actions.map(action => {
    let normalized = action
    const scopedInput = action?.roNumber
      ? getRoScopedText(inputText, action.roNumber, candidateRoNumbers, actionRoNumbers)
      : ''

    if (action?.type === 'update_rental' && action.roNumber) {
      const supportedRental = inferRental(scopedInput)
      if (supportedRental !== null) normalized = { ...normalized, hasRental: supportedRental }
    }

    if (action?.type === 'update_due_date') {
      const evidence = inferDueDateEvidence(scopedInput)
      const invalidPartsEvidence = evidence ? null : inferPartsDateEvidence(scopedInput)
      if (evidence) {
        normalized = evidence.normalized
          ? withValidDate(normalized, 'dueDate', evidence.normalized)
          : withInvalidDate(normalized, 'dueDate', evidence.raw)
      } else if (invalidPartsEvidence && invalidPartsEvidence.normalized === null) {
        normalized = withInvalidDate(normalized, 'dueDate', invalidPartsEvidence.raw)
      } else {
        normalized = normalizeExistingActionDate(normalized, 'dueDate')
      }
    } else if (action?.type === 'update_dropoff_date') {
      const evidence = inferDropoffDateEvidence(scopedInput)
      normalized = evidence
        ? (evidence.normalized
            ? withValidDate(normalized, 'dropOffDate', evidence.normalized)
            : withInvalidDate(normalized, 'dropOffDate', evidence.raw))
        : normalizeExistingActionDate(normalized, 'dropOffDate')
    } else if (['update_parts_order', 'log_parts_received'].includes(action?.type)) {
      const evidence = inferPartsDateEvidenceForAction(scopedInput, action, actions)
      normalized = evidence && evidence.normalized === null
        ? withInvalidDate(normalized, 'eta', evidence.raw)
        : normalizeExistingActionDate(normalized, 'eta')
    }

    return normalized
  })
  const extras = []
  for (const roNumber of targetRoNumbers) {
    if (!roNumber) continue
    const scopedInput = getRoScopedText(inputText, roNumber, candidateRoNumbers, actionRoNumbers)
    const sourceAction = normalizedActions.find(action => String(action?.roNumber ?? '') === String(roNumber))
    const generatedText = sourceAction ? actionText(sourceAction) : ''

    // The user's RO-scoped words are stronger evidence than model-generated notes.
    // Fall back to action text only when the scoped input contains no usable fact.
    const hasRental = inferRental(scopedInput) ?? inferRental(generatedText)
    if (hasRental !== null && !actionHas(normalizedActions.concat(extras), roNumber, 'update_rental')) {
      extras.push({
        type: 'update_rental',
        roNumber,
        hasRental,
        confidence: sourceAction?.confidence || 'high',
      })
    }

    const dueEvidence = inferDueDateEvidence(scopedInput) || inferDueDateEvidence(generatedText)
    if (dueEvidence && !actionHas(normalizedActions.concat(extras), roNumber, 'update_due_date')) {
      extras.push({
        type: 'update_due_date',
        roNumber,
        dueDate: dueEvidence.normalized || '',
        ...(dueEvidence.normalized ? {} : { invalidDate: dueEvidence.raw }),
        confidence: dueEvidence.normalized ? (sourceAction?.confidence || 'high') : 'low',
      })
    }
  }

  return extras.length ? [...normalizedActions, ...extras] : normalizedActions
}
