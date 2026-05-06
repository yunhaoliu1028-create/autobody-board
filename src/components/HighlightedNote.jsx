const NOTE_HIGHLIGHTS = [
  {
    label: 'Repair Authorization',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
    pattern: /\b(repair authorization|repair authorized|authorization|authorized|auth(?:orization)? pending|approved repair|repair approved)\b/gi,
  },
  {
    label: 'Dropped Off',
    className: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-200',
    pattern: /\b(vehicle\s+)?(dropped off|drop-?off|drop off|d\/o)\b/gi,
  },
  {
    label: 'Customer Concern',
    className: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
    pattern: /\b(customer concern|customer concerned|concern|concerned)\b/gi,
  },
  {
    label: 'Supplement',
    className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
    pattern: /\b(supp|supplement|pending on supp)\b/gi,
  },
  {
    label: 'Release Vehicle',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
    pattern: /\b(release vehicle|vehicle release|release to customer|released|ready for pickup|ready for pick up|customer pickup)\b/gi,
  },
  {
    label: 'Repair Status',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
    pattern: /\b(repair status|status update|repair update|in repair|repair complete|repairs? completed?|work in progress)\b/gi,
  },
]

export default function HighlightedNote({ text }) {
  const matches = []

  NOTE_HIGHLIGHTS.forEach(group => {
    for (const match of text.matchAll(group.pattern)) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        className: group.className,
        label: group.label,
      })
    }
  })

  const ordered = matches
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((match, idx, arr) => !arr.slice(0, idx).some(prev => match.start < prev.end))

  if (!ordered.length) return text

  const parts = []
  let cursor = 0

  ordered.forEach((match, idx) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start))
    parts.push(
      <mark
        key={`${match.start}-${idx}`}
        className={`rounded px-1 py-0.5 font-semibold ${match.className}`}
        title={match.label}
      >
        {match.text}
      </mark>
    )
    cursor = match.end
  })

  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
