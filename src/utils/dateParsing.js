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

function resolvedYear(value, defaultYear) {
  if (value == null || value === '') return Number(defaultYear)
  const numeric = Number(value)
  return numeric < 100 ? 2000 + numeric : numeric
}

export function formatCalendarDate(year, month, day) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null

  const candidate = new Date(Date.UTC(y, m - 1, d))
  if (
    candidate.getUTCFullYear() !== y
    || candidate.getUTCMonth() !== m - 1
    || candidate.getUTCDate() !== d
  ) return null

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function findDateToken(value = '', defaultYear = new Date().getFullYear()) {
  const text = String(value || '')
  const candidates = []

  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    candidates.push({
      raw: iso[0],
      normalized: formatCalendarDate(iso[1], iso[2], iso[3]),
      index: iso.index,
      priority: 0,
    })
  }

  const numeric = text.match(/(^|[^\d])(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)(?!\d)/)
  if (numeric) {
    const raw = numeric[2]
    const [month, day, year] = raw.split(/[/-]/)
    candidates.push({
      raw,
      normalized: formatCalendarDate(resolvedYear(year, defaultYear), month, day),
      index: (numeric.index || 0) + numeric[1].length,
      priority: 1,
    })
  }

  const named = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i)
  if (named) {
    candidates.push({
      raw: named[0],
      normalized: formatCalendarDate(
        resolvedYear(named[3], defaultYear),
        MONTHS[named[1].toLowerCase()],
        named[2],
      ),
      index: named.index,
      priority: 2,
    })
  }

  const chinese = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/u)
  if (chinese) {
    candidates.push({
      raw: chinese[0],
      normalized: formatCalendarDate(
        resolvedYear(chinese[1], defaultYear),
        chinese[2],
        chinese[3],
      ),
      index: chinese.index,
      priority: 3,
    })
  }

  const first = candidates.sort((left, right) => left.index - right.index || left.priority - right.priority)[0]
  if (!first) return null
  return { raw: first.raw, normalized: first.normalized, index: first.index }
}

export function parseFlexibleDate(value = '', defaultYear = new Date().getFullYear()) {
  return findDateToken(value, defaultYear)?.normalized ?? null
}

export function isValidIsoDate(value = '') {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return Boolean(match && formatCalendarDate(match[1], match[2], match[3]) === match[0])
}

export function actionDateValidationError(action = {}) {
  if (action.invalidDate) return `Invalid date "${action.invalidDate}"`
  for (const [field, label] of [['dueDate', 'target date'], ['dropOffDate', 'drop-off date'], ['eta', 'parts ETA']]) {
    const value = action[field]
    if (value != null && value !== '' && !isValidIsoDate(value)) {
      return `Invalid ${label} "${value}"`
    }
  }
  return null
}
