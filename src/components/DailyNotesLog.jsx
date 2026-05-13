import { useState, useMemo } from 'react'
import { format } from 'date-fns'
import HighlightedNote from './HighlightedNote'

// ── Parse raw notes string → array of note blocks ──────────────────────────
export function parseNoteLines(raw) {
  if (!raw) return []
  const lines = []
  let current = ''
  raw.split('\n').forEach(line => {
    if (/^\[[^\]]+\]/.test(line)) {
      if (current.trim()) lines.push(current.trim())
      current = line
    } else {
      if (!line.trim()) return
      current = current ? `${current}\n${line}` : line
    }
  })
  if (current.trim()) lines.push(current.trim())
  return lines
}

// ── Single day card ─────────────────────────────────────────────────────────
function DayGroup({ mmdd, isToday, lines, summary, isSummarizing }) {
  const [open,    setOpen]    = useState(true)   // all days open by default
  const [rawOpen, setRawOpen] = useState(false)

  const header = (
    <button
      onClick={() => setOpen(v => !v)}
      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-zinc-800/60 transition-colors rounded-xl"
    >
      <span className="text-xs font-bold font-mono text-gray-600 dark:text-zinc-300 shrink-0">{mmdd}</span>
      {isToday && <span className="text-xs text-blue-500 dark:text-blue-400 font-medium">Today</span>}
      <span className="flex-1 text-xs text-gray-400 dark:text-zinc-500">
        {lines.length} note{lines.length !== 1 ? 's' : ''}
      </span>
      {isSummarizing && <span className="text-xs text-blue-400 animate-pulse shrink-0">✨</span>}
      <span className="text-[10px] text-gray-300 dark:text-zinc-600 shrink-0">{open ? '▲' : '▼'}</span>
    </button>
  )

  if (!open) return <div className="rounded-xl border border-gray-100 dark:border-zinc-800">{header}</div>

  return (
    <div className="rounded-xl border border-gray-100 dark:border-zinc-800 overflow-hidden">
      {header}
      <div className="px-3 pb-3 space-y-1.5">

        {/* ── Past day: show AI summary bullets ── */}
        {!isToday && summary && (
          <div className="mb-1.5 space-y-1">
            {summary.bullets.map((b, i) => (
              <p key={i} className="text-xs text-gray-600 dark:text-zinc-300 flex gap-2 leading-relaxed">
                <span className="text-gray-300 dark:text-zinc-600 shrink-0 mt-0.5">•</span>
                <span><HighlightedNote text={b} /></span>
              </p>
            ))}
            <button
              onClick={() => setRawOpen(v => !v)}
              className="text-xs text-blue-500 dark:text-blue-400 hover:underline mt-0.5 block"
            >
              {rawOpen
                ? '↑ Hide original notes'
                : `↓ Show ${lines.length} original note${lines.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}

        {/* ── Raw notes: always for today, toggle for summarized past days ── */}
        {(isToday || !summary || rawOpen) && lines.map((line, i) => (
          <div key={i} className="px-3 py-2 bg-gray-50 dark:bg-zinc-800/50 rounded-lg border border-gray-100 dark:border-zinc-700/40">
            <p className="text-xs text-gray-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
              <HighlightedNote text={line} />
            </p>
          </div>
        ))}

        {/* ── Past day without summary yet: raw notes shown directly ── */}
        {!isToday && !summary && isSummarizing === false && lines.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-zinc-600 italic px-1">No notes.</p>
        )}
      </div>
    </div>
  )
}

// ── Full notes log grouped by calendar day ──────────────────────────────────
export default function DailyNotesLog({ noteString, noteSummaries, summarizingDates }) {
  const todayMmdd = format(new Date(), 'MM/dd')
  const todayYear = new Date().getFullYear()

  const dateGroups = useMemo(() => {
    const lines = parseNoteLines(noteString)
    const map = new Map()
    for (const line of lines) {
      const m = line.match(/^\[(\d{2}\/\d{2})/)
      if (!m) continue
      const mmdd = m[1]
      if (!map.has(mmdd)) map.set(mmdd, [])
      map.get(mmdd).push(line)
    }
    return Array.from(map.entries()).map(([mmdd, ls]) => {
      const [month, day] = mmdd.split('/')
      const monthNum = parseInt(month, 10)
      const year = monthNum > new Date().getMonth() + 1 ? todayYear - 1 : todayYear
      const isoDate = `${year}-${month}-${day}`
      return {
        mmdd, isoDate,
        isToday: mmdd === todayMmdd,
        lines: ls,
        summary: noteSummaries?.find(s => s.date === isoDate) ?? null,
      }
    })
  }, [noteString, noteSummaries, todayMmdd, todayYear])

  if (!dateGroups.length) {
    return <p className="text-xs text-gray-400 dark:text-zinc-600 italic">No notes yet.</p>
  }

  return (
    <div className="space-y-2">
      {dateGroups.map(g => (
        <DayGroup
          key={g.mmdd}
          mmdd={g.mmdd}
          isToday={g.isToday}
          lines={g.lines}
          summary={g.summary}
          isSummarizing={summarizingDates?.has(g.isoDate) ?? false}
        />
      ))}
    </div>
  )
}
