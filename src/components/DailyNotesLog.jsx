import { useState, useMemo } from 'react'
import { format } from 'date-fns'
import HighlightedNote from './HighlightedNote'

const SUMMARY_CATEGORIES = [
  { label: 'Parts', pattern: /\b(parts?|eta|vendor|ordered|received|pending|keystone|toyota|pac|lkq|dealer|supplement)\b/i },
  { label: 'Customer', pattern: /\b(customer|called|notified|authorized|rental|pickup|phone|owner|concern)\b/i },
  { label: 'Repair', pattern: /\b(repair|teardown|body|paint|reassembly|detail|qc|calibration|sublet|bumper|shield|install)\b/i },
  { label: 'Status', pattern: /\b(status|moved|complete|completed|ready|delivered|checked|drop|tow|in shop)\b/i },
]

function cleanSummaryText(text = '') {
  return String(text)
    .replace(/^\s*[-•]\s*/, '')
    .replace(/^\s*(parts?|customer|repair|status|general)\s*(?:[-–—:]\s*)/i, '')
    .trim()
}

function summaryCategory(text = '') {
  return SUMMARY_CATEGORIES.find(item => item.pattern.test(String(text)))?.label || 'General'
}

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

function DayGroup({ mmdd, isToday, lines, summary, isSummarizing, canUndo = false, onUndoLine }) {
  const [open, setOpen] = useState(true)
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
      {isSummarizing && <span className="text-xs text-blue-400 animate-pulse shrink-0">*</span>}
      <span className="text-[10px] text-gray-300 dark:text-zinc-600 shrink-0">{open ? '▲' : '▼'}</span>
    </button>
  )

  if (!open) return <div className="rounded-xl border border-gray-100 dark:border-zinc-800">{header}</div>

  return (
    <div className="rounded-xl border border-gray-100 dark:border-zinc-800 overflow-hidden">
      {header}
      <div className="px-3 pb-3 space-y-1.5">
        {!isToday && summary && (
          <div className="mb-1.5 space-y-1.5">
            {summary.bullets.map((b, i) => (
              <div key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-gray-300 dark:bg-zinc-600" />
                <span className="w-16 shrink-0 font-semibold text-gray-500 dark:text-zinc-400">{summaryCategory(b)}</span>
                <span className="min-w-0 flex-1 text-gray-600 dark:text-zinc-300">{cleanSummaryText(b)}</span>
              </div>
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

        {(isToday || !summary || rawOpen) && lines.map((line, i) => (
          <div key={i} className="px-3 py-2 bg-gray-50 dark:bg-zinc-800/50 rounded-lg border border-gray-100 dark:border-zinc-700/40">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-xs text-gray-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
                <HighlightedNote text={line} />
              </p>
              {canUndo && (
                <button
                  type="button"
                  onClick={() => onUndoLine?.(line)}
                  className="shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-500 hover:border-red-300 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:text-red-300"
                >
                  Undo
                </button>
              )}
            </div>
          </div>
        ))}

        {!isToday && !summary && isSummarizing === false && lines.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-zinc-600 italic px-1">No notes.</p>
        )}
      </div>
    </div>
  )
}

export default function DailyNotesLog({
  noteString,
  noteSummaries,
  summarizingDates,
  canUndo = false,
  onUndoLine,
  canRefresh = false,
  onRefresh,
  refreshBusy = false,
}) {
  const [undoMode, setUndoMode] = useState(false)
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
        mmdd,
        isoDate,
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
      {(canRefresh || canUndo) && (
        <div className="flex justify-end gap-1.5">
          {canRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshBusy}
              title={refreshBusy ? 'Refreshing notes...' : 'Refresh note summaries'}
              aria-label={refreshBusy ? 'Refreshing notes' : 'Refresh note summaries'}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-400 transition-colors hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500 dark:hover:border-blue-800 dark:hover:text-blue-300"
            >
              <svg className={`h-3.5 w-3.5 ${refreshBusy ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 9a7 7 0 0111.2-2.8M17 15a7 7 0 01-11.2 2.8" />
              </svg>
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              onClick={() => setUndoMode(v => !v)}
              title={undoMode ? 'Hide undo controls' : 'Show undo controls'}
              aria-label={undoMode ? 'Hide undo controls' : 'Show undo controls'}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-sm font-bold transition-colors ${
                undoMode
                  ? 'border-red-200 bg-red-50 text-red-600 hover:border-red-300 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300'
                  : 'border-gray-200 bg-white text-gray-400 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500 dark:hover:border-blue-800 dark:hover:text-blue-300'
              }`}
            >
              ↶
            </button>
          )}
        </div>
      )}
      {dateGroups.map(g => (
        <DayGroup
          key={g.mmdd}
          mmdd={g.mmdd}
          isToday={g.isToday}
          lines={g.lines}
          summary={g.summary}
          isSummarizing={summarizingDates?.has(g.isoDate) ?? false}
          canUndo={canUndo && undoMode}
          onUndoLine={onUndoLine}
        />
      ))}
    </div>
  )
}
