const NOTE_HIGHLIGHTS = [
  {
    label: 'Parts',
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
    pattern: /\b(parts?|parts? ordered|parts? received|all received|partially received|parts? arrived|parts? delayed|back ?ordered|ETA|eta|零件|料)\b/gi,
  },
  {
    label: 'Paint',
    className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200',
    pattern: /\b(paint|in paint|paint prep|paint booth|paint complete|paint done|entered (paint|booth)|喷漆|油漆)\b/gi,
  },
  {
    label: 'Body Work',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
    pattern: /\b(body|body work|body complete|body done|teardown|tear ?down|板金|拆解)\b/gi,
  },
  {
    label: 'Reassembly',
    className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
    pattern: /\b(reassembly|reassembl[yi]|assembly|装配|复原)\b/gi,
  },
  {
    label: 'Sublet',
    className: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200',
    pattern: /\b(sublet|calibration|alignment|4WA|4-?wheel|AC recharge|窗膜|贴膜)\b/gi,
  },
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
    label: 'Customer',
    className: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
    pattern: /\b(customer concern|customer concerned|concern|concerned|called customer|customer called|customer notified|customer updated)\b/gi,
  },
  {
    label: 'Supplement',
    className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
    pattern: /\b(supp|supplement|pending on supp|补项)\b/gi,
  },
  {
    label: 'Ready / Delivery',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
    pattern: /\b(release vehicle|vehicle release|release to customer|released|ready for pickup|ready for pick-?up|customer pickup|delivery|delivered|交车)\b/gi,
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
