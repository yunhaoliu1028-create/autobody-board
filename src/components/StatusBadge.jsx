import { STATUS_MAP, PARTS_STATUSES, CAR_STATUS_MAP } from '../constants/roles'
import { format, parseISO, isValid } from 'date-fns'

// ── Icons ─────────────────────────────────────────────────────────────────────
function IconCalendar() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  )
}

function IconKey() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  )
}

function IconCarSmall() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 6l-1.5-3h-5L8 6M3 10l1-4h16l1 4M5 10v7a1 1 0 001 1h1a1 1 0 001-1v-1h8v1a1 1 0 001 1h1a1 1 0 001-1v-7"/>
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="16.5" cy="11.5" r="1" fill="currentColor"/>
    </svg>
  )
}

// ── Status Badge ──────────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const s = STATUS_MAP[status]
  if (!s) return <span className="text-xs text-gray-400 dark:text-zinc-600">—</span>
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${s.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      {s.label}
    </span>
  )
}

// ── Parts Status Badge ────────────────────────────────────────────────────────
export function PartsStatusBadge({ status, label }) {
  const s = PARTS_STATUSES.find(p => p.key === status)
  if (!s) return <span className="text-xs text-gray-400 dark:text-zinc-600">—</span>
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>
      {label || s.label}
    </span>
  )
}

// ── Drop-Off + Rental Info ────────────────────────────────────────────────────
// Replaces the old CarStatusBadge — shows drop-off date and rental status
function fmtDate(dateStr) {
  if (!dateStr) return null
  try {
    const d = parseISO(dateStr)
    return isValid(d) ? format(d, 'M/d') : dateStr
  } catch { return dateStr }
}

export function DropoffInfo({ dropOffDate, hasRental, carStatus, compact = false }) {
  const dateFormatted = fmtDate(dropOffDate)
  const inShop        = carStatus === 'car_in_shop'

  if (!dateFormatted && hasRental === undefined && hasRental === null && !inShop) return null

  if (compact) {
    // Inline compact version for kanban cards / table rows
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {dateFormatted && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-zinc-400">
            <IconCalendar />
            {inShop ? 'In ' : ''}{dateFormatted}
          </span>
        )}
        {inShop && !dateFormatted && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
            <IconCarSmall />
            In Shop
          </span>
        )}
        {hasRental === true && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-zinc-500">
            <IconKey />
            Rental
          </span>
        )}
        {hasRental === false && (
          <span className="text-xs text-gray-400 dark:text-zinc-500">No Rental</span>
        )}
      </div>
    )
  }

  // Full version for detail page
  return (
    <div className="flex flex-col gap-1">
      {dateFormatted && (
        <div className="flex items-center gap-1.5 text-sm">
          <IconCalendar />
          <span className="text-gray-500 dark:text-zinc-400 text-xs">Drop-Off</span>
          <span className={`font-medium ${inShop ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-300'}`}>
            {dateFormatted}
            {inShop && <span className="ml-1.5 text-xs font-normal text-emerald-500">· In Shop</span>}
          </span>
        </div>
      )}
      {!dateFormatted && inShop && (
        <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium">
          <IconCarSmall />
          Car In Shop
        </div>
      )}
      {hasRental !== undefined && hasRental !== null && (
        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-zinc-400">
          <IconKey />
          {hasRental ? 'Customer has rental' : 'No rental'}
        </div>
      )}
    </div>
  )
}

// ── Car Status Badge (kept for backward compat / toggle in detail page) ───────
export function CarStatusBadge({ status, onClick, canEdit }) {
  const s = CAR_STATUS_MAP[status]
  if (!s) return null
  return (
    <span
      onClick={canEdit ? onClick : undefined}
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold
        ${s.color}
        ${canEdit ? 'cursor-pointer hover:opacity-75' : ''}`}
      title={canEdit ? 'Click to toggle' : s.label}
    >
      <span className="text-[10px]">{s.icon}</span>
      {s.label}
    </span>
  )
}

// ── CCC-locked field label ────────────────────────────────────────────────────
function IconLock() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path strokeLinecap="round" d="M7 11V7a5 5 0 0110 0v4"/>
    </svg>
  )
}

export function CCCFieldLabel({ label }) {
  return (
    <div className="flex items-center gap-1 mb-0.5">
      <p className="text-xs text-gray-500 dark:text-zinc-400">{label}</p>
      <span className="text-amber-400 dark:text-amber-500" title="Sourced from CCC – auto-updated">
        <IconLock />
      </span>
    </div>
  )
}
