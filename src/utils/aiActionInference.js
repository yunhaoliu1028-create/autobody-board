function normalizeDateParts(month, day, year = null) {
  const m = Number.parseInt(month, 10)
  const d = Number.parseInt(day, 10)
  const y = year ? Number.parseInt(year, 10) : new Date().getFullYear()
  if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const fullYear = y < 100 ? 2000 + y : y
  return `${fullYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function inferDueDate(text = '') {
  const scoped = text.match(/\b(?:target\s+completion(?:\s+date)?|completion\s+date|target\s+date|due\s+date|shop\s+eta|repair\s+eta|promised\s+date)\b[^.\n;,]*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/i)
  if (!scoped) return null
  return normalizeDateParts(scoped[1], scoped[2], scoped[3])
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

function inferRoNumber(text = '') {
  return text.match(/\b(?:RO|#)?\s*(\d{4,6})\b/i)?.[1] ?? null
}

export function inferStructuredActionsFromText(actions = [], inputText = '') {
  if (!Array.isArray(actions) || actions.length === 0) return actions

  const extras = []
  for (const action of actions) {
    const roNumber = action.roNumber ?? inferRoNumber(inputText)
    if (!roNumber) continue
    const text = `${inputText} ${actionText(action)}`

    const hasRental = inferRental(text)
    if (hasRental !== null && !actionHas(actions.concat(extras), roNumber, 'update_rental')) {
      extras.push({
        type: 'update_rental',
        roNumber,
        hasRental,
        confidence: action.confidence || 'high',
      })
    }

    const dueDate = inferDueDate(text)
    if (dueDate && !actionHas(actions.concat(extras), roNumber, 'update_due_date')) {
      extras.push({
        type: 'update_due_date',
        roNumber,
        dueDate,
        confidence: action.confidence || 'high',
      })
    }
  }

  return extras.length ? [...actions, ...extras] : actions
}
