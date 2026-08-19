function normalizeRoNumber(value) {
  const normalized = String(value ?? '').trim()
  return /^\d{3,8}$/.test(normalized) ? normalized : ''
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function connectorOnly(value = '') {
  return value
    .replace(/\b(?:and|plus)\b/gi, '')
    .replace(/[\s,&/+，、和及与]/g, '') === ''
}

function findRoMentions(inputText, roNumbers) {
  const mentions = []
  for (const roNumber of roNumbers) {
    const escaped = escapeRegExp(roNumber)
    const pattern = new RegExp(`(?:\\bRO\\s*#?\\s*|#\\s*|\\b)${escaped}\\b`, 'gi')
    for (const match of inputText.matchAll(pattern)) {
      mentions.push({ roNumber, start: match.index, end: match.index + match[0].length })
    }
  }

  return mentions
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((mention, index, all) => index === 0 || (
      mention.start !== all[index - 1].start
      || mention.end !== all[index - 1].end
      || mention.roNumber !== all[index - 1].roNumber
    ))
}

export function buildRoInputScopes(inputText = '', candidateRoNumbers = []) {
  const text = String(inputText || '')
  const roNumbers = [...new Set(candidateRoNumbers.map(normalizeRoNumber).filter(Boolean))]
  const mentions = findRoMentions(text, roNumbers)
  const groups = []

  for (let index = 0; index < mentions.length; index += 1) {
    const members = [mentions[index]]
    while (
      index + 1 < mentions.length
      && connectorOnly(text.slice(members.at(-1).end, mentions[index + 1].start))
    ) {
      index += 1
      members.push(mentions[index])
    }
    groups.push({ start: members[0].start, members })
  }

  const scopes = new Map()
  groups.forEach((group, index) => {
    const end = groups[index + 1]?.start ?? text.length
    const scopedText = text.slice(group.start, end).trim()
    if (!scopedText) return

    for (const member of group.members) {
      const previous = scopes.get(member.roNumber)
      scopes.set(member.roNumber, previous ? `${previous}\n${scopedText}` : scopedText)
    }
  })
  return scopes
}

export function getRoScopedText(
  inputText = '',
  roNumber,
  candidateRoNumbers = [],
  actionRoNumbers = [],
) {
  const target = normalizeRoNumber(roNumber)
  if (!target) return ''

  const scopes = buildRoInputScopes(inputText, candidateRoNumbers)
  if (scopes.has(target)) return scopes.get(target)

  const activeRos = [...new Set(actionRoNumbers.map(normalizeRoNumber).filter(Boolean))]
  if (scopes.size === 0 && activeRos.length === 1 && activeRos[0] === target) {
    return String(inputText || '')
  }
  return ''
}
