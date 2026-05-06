import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { collection, onSnapshot, query, orderBy, doc, updateDoc, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { StatusBadge, PartsStatusBadge } from '../components/StatusBadge'
import AIInputBox from '../components/AIInputBox'
import RODrawer   from '../components/RODrawer'
import {
  RO_STATUSES, STATUS_MAP, PARTS_STATUSES,
  MANAGER_ROLES, EDIT_RO_ROLES,
  STATUS_GROUPS,
} from '../constants/roles'
import { parseISO, differenceInDays, isValid, format } from 'date-fns'

// ── Change detection ──────────────────────────────────────────────────────────
const PARTS_LABEL = Object.fromEntries(
  (typeof PARTS_STATUSES !== 'undefined' ? PARTS_STATUSES : []).map(p => [p.key, p.label])
)
function detectRoChanges(prev, next) {
  const changes = []
  if (prev.status      !== next.status)      changes.push(`Status → ${STATUS_MAP[next.status]?.label ?? next.status}`)
  if (prev.partsStatus !== next.partsStatus) changes.push(`Parts → ${PARTS_LABEL[next.partsStatus] ?? next.partsStatus}`)
  if (prev.totalAmount !== next.totalAmount && next.totalAmount) changes.push(`Amount → $${Number(next.totalAmount).toLocaleString()}`)
  if (prev.hasRental   !== next.hasRental)   changes.push(next.hasRental ? 'Rental added' : 'Rental removed')
  if (prev.dropOffDate !== next.dropOffDate && next.dropOffDate) changes.push(`Drop-off → ${next.dropOffDate}`)
  return changes
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dueDateClass(dateStr) {
  if (!dateStr) return ''
  try {
    const days = differenceInDays(parseISO(dateStr), new Date())
    if (days < 0)  return 'text-red-500 dark:text-red-400 font-semibold'
    if (days <= 2) return 'text-amber-500 dark:text-amber-400 font-medium'
  return 'text-gray-500 dark:text-zinc-300'
  } catch { return '' }
}

const PRE_PAINT_STATUSES = new Set(['checked_in', 'teardown', 'waiting_parts', 'body_work', 'body_complete', 'paint_prep'])
const PARTS_DELAY_LABELS = { back_ordered: 'Back Ordered', delayed: 'Delayed', wrong_part: 'Wrong Part', defective: 'Defective' }

function isPaintDueSoon(ro) {
  if (!PRE_PAINT_STATUSES.has(ro.status)) return false
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate
  if (!dueDate) return false
  try {
    return differenceInDays(parseISO(dueDate), new Date()) <= 2
  } catch { return false }
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = parseISO(dateStr)
    return isValid(d) ? format(d, 'M/dd') : dateStr
  } catch { return dateStr }
}

// Strip generic insurance suffixes — keep the brand name only
// e.g. "TESLA INSURANCE SERVICES" → "TESLA"
//      "STATE FARM INSURANCE"     → "STATE FARM"
function shortInsurance(name) {
  if (!name) return ''
  const trimmed = name.replace(/\s+INSURANCE\b.*/i, '').trim()
  return trimmed || name
}

function needsDropOffWarning(ro) {
  return !ro.dropOffDate && ro.status !== 'checked_in' && ro.carStatus !== 'pending_dropoff'
}

function DropOffInfo({ ro, compact = false }) {
  if (ro.dropOffDate) {
    return <span className={compact ? 'text-xs text-gray-500 dark:text-zinc-300' : ''}>{compact ? `In: ${fmtDate(ro.dropOffDate)}` : fmtDate(ro.dropOffDate)}</span>
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/60 dark:text-amber-200 ${compact ? '' : 'whitespace-nowrap'}`}>
      Pending
      {needsDropOffWarning(ro) && (
        <span title="Drop-off date needs update" className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold text-red-700 dark:bg-red-900/60 dark:text-red-200">!</span>
      )}
    </span>
  )
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
function IconSearch() { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg> }
function IconList()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg> }
function IconGrid()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IconPencil() { return <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> }

// ── List row ─────────────────────────────────────────────────────────────────
function RORow({ ro, employees, onSelect }) {
  const bodyTech  = employees[ro.assignedBodyMan]   ?? '—'
  // Estimator: prefer CCC name, fall back to assigned UID lookup
  const estimator = ro.estimatorName || employees[ro.assignedEstimator] || '—'
  const dueDate   = ro.eta || ro.cccDateOut || ro.promisedDate

  return (
    <tr
      onClick={() => onSelect(ro)}
      className="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors group cursor-pointer"
    >
      {/* RO# */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="font-mono text-sm font-bold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {ro.roNumber}
        </span>
      </td>

      {/* Insurance + Vehicle + Owner */}
      <td className="px-4 py-3 min-w-[180px]">
        {ro.insuranceCompany && (
          <div className="text-xs text-gray-400 dark:text-zinc-400 mb-0.5 truncate">{ro.insuranceCompany}</div>
        )}
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
          {ro.vehicle}{ro.vehicleColor ? ` · ${ro.vehicleColor}` : ''}
        </div>
        <div className="text-xs text-gray-500 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</div>
        {/* Rental highlight */}
        {ro.hasRental === true && (
          <span className="inline-block mt-1 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 font-medium">
            Rental
          </span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge status={ro.status} />
      </td>

      {/* Estimator (CCC) */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-300 whitespace-nowrap">{estimator}</td>

      {/* Body Tech */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-300 whitespace-nowrap">{bodyTech}</td>

      {/* Parts + delay badge */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex flex-col gap-1">
          <PartsStatusBadge status={ro.partsStatus} />
          {ro.partsDelay && (
            <span
              title={ro.partsDelay.note || PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts delay'}
              className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 font-medium"
            >
              ⚠ {PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts Delay'}
            </span>
          )}
        </div>
      </td>

      {/* Drop-off Date (manual, not CCC) */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400 whitespace-nowrap">
        <DropOffInfo ro={ro} />
      </td>

      {/* Due Date + paint alert */}
      <td className={`px-4 py-3 text-xs whitespace-nowrap ${dueDateClass(dueDate)}`}>
        <div className="flex flex-col gap-1">
          <span>{fmtDate(dueDate)}</span>
          {isPaintDueSoon(ro) && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-medium">
              ⚠ Paint Due
            </span>
          )}
        </div>
      </td>

      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
        <Link
          to={`/ro/${ro.id}`}
          className="text-xs text-gray-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Detail →
        </Link>
      </td>
    </tr>
  )
}

// ── Kanban card ───────────────────────────────────────────────────────────────
function KanbanCard({ ro, onSelect, draggable, onDragStart, onDragEnd }) {
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate

  return (
    <div
      onClick={() => onSelect(ro)}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="relative bg-white dark:bg-zinc-800/90 border border-gray-200 dark:border-zinc-700 rounded-xl p-3.5 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-zinc-600 transition-all cursor-grab active:cursor-grabbing group"
    >
      {/* Edit icon — navigates to RODetail without opening drawer */}
      <Link
        to={`/ro/${ro.id}`}
        onClick={e => e.stopPropagation()}
        title="Open full detail"
        className="absolute top-2.5 right-2.5 p-1 rounded-md text-gray-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors opacity-0 group-hover:opacity-100"
      >
        <IconPencil />
      </Link>

        {/* Top row: RO# | right col (Parts badge + Status badge stacked) */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <span className="text-base font-mono font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
            #{ro.roNumber}
          </span>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <PartsStatusBadge status={ro.partsStatus} />
            {ro.status && STATUS_MAP[ro.status] && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_MAP[ro.status].color}`}>
                {STATUS_MAP[ro.status].label}
              </span>
            )}
          </div>
        </div>

        {/* Vehicle */}
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate leading-snug">{ro.vehicle}</p>
        {ro.vehicleColor && (
        <p className="text-xs text-gray-400 dark:text-zinc-300">{ro.vehicleColor}</p>
        )}

        {/* Owner */}
        <p className="text-xs text-gray-500 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</p>

        {/* Insurance + Claim — brand only, strip "INSURANCE SERVICES" etc. */}
        {(ro.insuranceCompany || ro.claimNumber) && (
          <div className="mt-2 text-xs text-gray-400 dark:text-zinc-400 truncate">
            {ro.insuranceCompany && <span>{shortInsurance(ro.insuranceCompany)}</span>}
            {ro.claimNumber && <span className="ml-1 text-gray-400 dark:text-zinc-500">#{ro.claimNumber}</span>}
          </div>
        )}

        {/* Dates row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          {/* Drop-off (manual entry, not CCC) */}
          <DropOffInfo ro={ro} compact />

          {/* Due date */}
          {dueDate && (
            <span className={`text-xs font-medium ${dueDateClass(dueDate)}`}>
              Due {fmtDate(dueDate)}
            </span>
          )}
        </div>

        {/* Rental indicator */}
        {ro.hasRental === true && (
          <div className="mt-1.5">
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 font-medium">
              Rental
            </span>
          </div>
        )}

        {/* Alert badges */}
        {(ro.partsDelay || isPaintDueSoon(ro)) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ro.partsDelay && (
              <span
                title={ro.partsDelay.note || PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts delay'}
                className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 font-medium"
              >
                ⚠ {PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts Delay'}
              </span>
            )}
            {isPaintDueSoon(ro) && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-medium">
                ⚠ Paint Due
              </span>
            )}
          </div>
        )}
    </div>
  )
}

function MobileROCard({ ro, onSelect, expanded = false, onToggle }) {
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate
  const status = STATUS_MAP[ro.status]

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => onSelect(ro)} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-extrabold text-gray-950 dark:text-gray-100">#{ro.roNumber}</span>
              {status && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.color}`}>
                  {status.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">{ro.vehicle || 'Vehicle missing'}</p>
            {ro.vehicleColor && <p className="text-xs text-gray-400 dark:text-zinc-500">{ro.vehicleColor}</p>}
          </div>
          <PartsStatusBadge status={ro.partsStatus} />
        </div>
      </button>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-gray-500 dark:text-zinc-400">{shortInsurance(ro.insuranceCompany) || ro.customerName || 'No owner'}</span>
        {dueDate && <span className={`shrink-0 font-semibold ${dueDateClass(dueDate)}`}>Due {fmtDate(dueDate)}</span>}
      </div>

      {(ro.partsDelay || isPaintDueSoon(ro)) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {ro.partsDelay && (
            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/50 dark:text-orange-300">
              Parts Delay
            </span>
          )}
          {isPaintDueSoon(ro) && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/50 dark:text-red-300">
              Paint Due
            </span>
          )}
        </div>
      )}

      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 text-xs font-semibold text-blue-600 dark:text-blue-400"
        >
          {expanded ? 'Hide details' : 'Show full info'}
        </button>
      )}

      {expanded && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-gray-50 p-2 text-xs dark:bg-zinc-800/70">
          <dt className="text-gray-400">Owner</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.customerName || '-'}</dd>
          <dt className="text-gray-400">Insurance</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.insuranceCompany || '-'}</dd>
          <dt className="text-gray-400">Claim</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.claimNumber || '-'}</dd>
          <dt className="text-gray-400">Drop-off</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.dropOffDate ? fmtDate(ro.dropOffDate) : 'Pending'}</dd>
        </dl>
      )}
    </article>
  )
}

function MobileListCard({ ro, onSelect }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <MobileROCard
      ro={ro}
      onSelect={onSelect}
      expanded={expanded}
      onToggle={() => setExpanded(v => !v)}
    />
  )
}

// ── PendingToBodyModal ────────────────────────────────────────────────────────
function PendingToBodyModal({ ro, employees, onConfirm, onCancel }) {
  const bodyMen = employees.filter(e => e.role === 'body_man')
  const painters = employees.filter(e => e.role === 'painter' || e.role === 'paint_helper')

  const prefilled = !!ro.dropOffDate  // was already set via GIB before drag

  const [bodyManUid,    setBodyManUid]    = useState(ro.assignedBodyMan || '')
  const [painterUid,    setPainterUid]    = useState(ro.assignedPainter || (painters[0]?.uid ?? ''))
  const [authorized,    setAuthorized]    = useState(ro.customerAuthorized ?? null)
  const [dropOffDate,   setDropOffDate]   = useState(ro.dropOffDate || '')
  const [hasRental,     setHasRental]     = useState(ro.hasRental ?? false)
  const [error,         setError]         = useState('')

  const handleConfirm = () => {
    if (!bodyManUid)           return setError('Please assign a body technician.')
    if (authorized === null)   return setError('Please confirm customer authorization.')
    if (!dropOffDate)          return setError('Please enter the drop-off date.')
    setError('')
    onConfirm({ bodyManUid, painterUid, authorized, dropOffDate, hasRental })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm border border-gray-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-800">
          <h3 className="font-bold text-gray-900 dark:text-gray-100">Move to Body Work</h3>
          <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">RO #{ro.roNumber} · {ro.vehicle}</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          {/* Body Tech */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Body Technician <span className="text-red-500">*</span>
            </label>
            <select
              value={bodyManUid}
              onChange={e => setBodyManUid(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select body tech —</option>
              {bodyMen.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* Painter (auto-fill) */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Painter
            </label>
            <select
              value={painterUid}
              onChange={e => setPainterUid(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— None —</option>
              {painters.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* Customer Authorization */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Customer Authorized to Start? <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setAuthorized(true)}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors
                  ${authorized === true ? 'bg-green-600 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
              >Yes</button>
              <button
                onClick={() => setAuthorized(false)}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors
                  ${authorized === false ? 'bg-red-500 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
              >No</button>
            </div>
          </div>

          {/* Drop-off Date */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300">
                Drop-off Date <span className="text-red-500">*</span>
              </label>
              {prefilled && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300 font-medium">
                  ✓ from GIB
                </span>
              )}
            </div>
            <input
              type="date"
              value={dropOffDate}
              onChange={e => setDropOffDate(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Rental */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Rental Car?</span>
            <button
              onClick={() => setHasRental(v => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${hasRental ? 'bg-blue-600' : 'bg-gray-300 dark:bg-zinc-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                ${hasRental ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-zinc-800 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 border border-gray-300 dark:border-zinc-700 rounded-xl text-sm font-medium text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
          >Cancel</button>
          <button
            onClick={handleConfirm}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-xl text-sm font-medium text-white transition-colors"
          >Confirm →</button>
        </div>
      </div>
    </div>
  )
}

const VIEWS = ['list', 'kanban']

// ── Main ──────────────────────────────────────────────────────────────────────
function handlePrintRos(rosToPrint, employees) {
  const popup = window.open('', '_blank', 'width=1200,height=800')
  if (!popup) return

  const rows = rosToPrint.map(ro => `
    <tr>
      <td>#${ro.roNumber ?? ''}</td>
      <td>${ro.vehicle ?? ''}</td>
      <td>${ro.customerName ?? ''}</td>
      <td>${ro.insuranceCompany ?? ''}</td>
      <td>${STATUS_MAP[ro.status]?.label ?? ro.status ?? ''}</td>
      <td>${ro.partsStatus ?? ''}</td>
      <td>${ro.dropOffDate || 'Pending'}</td>
      <td>${ro.cccDateOut || ro.promisedDate || ''}</td>
      <td>${employees[ro.assignedBodyMan] ?? ''}</td>
    </tr>
  `).join('')

  popup.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>RO List</title>
        <style>
          @page { size: landscape; margin: 0.4in; }
          body { font-family: Arial, sans-serif; color: #111827; }
          h1 { font-size: 18px; margin: 0 0 4px; }
          p { margin: 0 0 14px; font-size: 12px; color: #4b5563; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; }
          th, td { border: 1px solid #d1d5db; padding: 6px 7px; text-align: left; vertical-align: top; }
          th { background: #f3f4f6; font-weight: 700; }
        </style>
      </head>
      <body>
        <h1>Repair Order List</h1>
        <p>${new Date().toLocaleString()} · ${rosToPrint.length} ROs</p>
        <table>
          <thead>
            <tr>
              <th>RO #</th><th>Vehicle</th><th>Owner</th><th>Insurance</th><th>Status</th>
              <th>Parts</th><th>Drop-off</th><th>Due</th><th>Body Tech</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <script>window.print(); window.onafterprint = () => window.close();<\/script>
      </body>
    </html>
  `)
  popup.document.close()
}

export default function ROBoard() {
  const { role, user } = useAuth()
  const toast      = useToast()
  const isManager  = MANAGER_ROLES.includes(role)
  const canEdit    = EDIT_RO_ROLES.includes(role)
  const prevRosRef = useRef(null)          // for change-detection

  const [ros,            setRos]            = useState([])
  const [employees,      setEmployees]      = useState({})   // uid -> name map
  const [employeeList,   setEmployeeList]   = useState([])   // [{uid, name, role}]
  const [selectedRO,     setSelectedRO]     = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('kanban')
  const [search,         setSearch]         = useState('')
  const [filterStatus,   setFilterStatus]   = useState('all')
  const [showDeliveredArchive, setShowDeliveredArchive] = useState(false)
  // Drag-and-drop state
  const [dragRoId,       setDragRoId]       = useState(null)
  const [dragOverGroup,  setDragOverGroup]  = useState(null)
  const [statusPicker,   setStatusPicker]   = useState(null)  // { roId, groupKey, statuses }
  const [pendingToBody,  setPendingToBody]  = useState(null)  // { ro }

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map  = {}
      const list = []
      snap.forEach(d => {
        const data = d.data()
        map[d.id] = data.name
        list.push({ uid: d.id, name: data.name, role: data.role ?? '' })
      })
      setEmployees(map)
      setEmployeeList(list)
    })
    return unsub
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))

    const unsub = onSnapshot(q, snap => {
      const newRos = snap.docs.map(d => ({ id: d.id, ...d.data() }))

      // Fire update toasts on live changes (skip initial load)
      if (prevRosRef.current !== null) {
        for (const newRo of newRos) {
          const prev = prevRosRef.current.find(r => r.id === newRo.id)
          if (!prev) continue
          const changes = detectRoChanges(prev, newRo)
          if (changes.length) {
            toast.info(`RO #${newRo.roNumber} · ${changes.join(' · ')}`)
          }
        }
      }
      prevRosRef.current = newRos
      setRos(newRos)
      setLoading(false)
    }, err => { console.error(err); setLoading(false) })
    return unsub
  }, [])   // toast is stable, no need in deps

  const filtered = useMemo(() => ros.filter(ro => {
    if (ro.status === 'delivered') return false
    const matchStatus = filterStatus === 'all' || ro.status === filterStatus
    const q = search.toLowerCase()
    const matchSearch = !q
      || ro.roNumber?.toLowerCase().includes(q)
      || ro.customerName?.toLowerCase().includes(q)
      || ro.vehicle?.toLowerCase().includes(q)
      || ro.insuranceCompany?.toLowerCase().includes(q)
    return matchStatus && matchSearch
  }), [ros, filterStatus, search])

  const deliveredRos = useMemo(() => {
    return ros.filter(ro => ro.status === 'delivered')
  }, [ros])

  // Count per status (for filter pills)
  const statusCounts = useMemo(() => {
    const counts = {}
    ros.forEach(r => {
      if (r.status !== 'delivered') counts[r.status] = (counts[r.status] || 0) + 1
    })
    return counts
  }, [ros])

  // Kanban: 6 fixed group columns
  const kanbanGroups = useMemo(() => {
    return STATUS_GROUPS.map(group => ({
      ...group,
      items: filtered.filter(ro => group.statuses.includes(ro.status)),
    }))
  }, [filtered])

  // ── Drag-and-drop handlers ───────────────────────────────────────────────────

  const handleDrop = (group) => {
    if (!dragRoId) return
    const ro = ros.find(r => r.id === dragRoId)
    if (!ro) return
    setDragRoId(null)
    setDragOverGroup(null)

    // PENDING → BODY: requires confirmation modal
    const currentGroup = STATUS_GROUPS.find(g => g.statuses.includes(ro.status))
    if (currentGroup?.key === 'PENDING' && group.key === 'BODY') {
      // Get full employee objects with roles
      const allEmps = employeeList.map(e => {
        const userData = ros // fallback; real role comes from users collection
        return e
      })
      setPendingToBody({ ro })
      return
    }

    if (group.statuses.length === 1) {
      applyStatusDrop(dragRoId, group.statuses[0])
    } else if (group.statuses.length > 1) {
      setStatusPicker({ roId: dragRoId, groupKey: group.key, statuses: group.statuses })
    }
  }

  const applyStatusDrop = async (roId, newStatus) => {
    const ro = ros.find(r => r.id === roId)
    if (!ro || ro.status === newStatus) return
    const author = employees[user?.uid] ?? 'Unknown'
    await updateDoc(doc(db, 'ros', roId), {
      status:    newStatus,
      updatedAt: serverTimestamp(),
      changeLog: arrayUnion({
        type:   'status_change',
        value:  newStatus,
        label:  STATUS_MAP[newStatus]?.label ?? newStatus,
        by:     author,
        at:     new Date().toISOString(),
        source: 'drag',
      }),
    })
  }

  const applyPendingToBody = async ({ bodyManUid, painterUid, authorized, dropOffDate, hasRental }) => {
    const ro     = pendingToBody?.ro
    if (!ro) return
    const author  = employees[user?.uid] ?? 'Unknown'
    const stamp   = new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    const noteText = `Moved to Body Work — Tech: ${employees[bodyManUid] ?? bodyManUid}` +
      (painterUid ? `, Painter: ${employees[painterUid] ?? painterUid}` : '') +
      `, Authorized: ${authorized ? 'Yes' : 'No'}` +
      `, Drop-off: ${dropOffDate}` +
      (hasRental ? ', Rental: Yes' : '')
    const noteLine   = `[${stamp} - ${author}] ${noteText}`
    const prevNotes  = typeof ro.notes === 'string' ? ro.notes : ''
    await updateDoc(doc(db, 'ros', ro.id), {
      status:              'body_work',
      assignedBodyMan:     bodyManUid,
      assignedPainter:     painterUid || null,
      customerAuthorized:  authorized,
      dropOffDate,
      hasRental,
      carStatus:           'car_in_shop',
      updatedAt:           serverTimestamp(),
      changeLog:           arrayUnion({
        type: 'status_change', value: 'body_work', label: 'Body Work',
        by: author, at: new Date().toISOString(), source: 'drag',
      }),
      notes: prevNotes ? `${noteLine}\n${prevNotes}` : noteLine,
    })
    setPendingToBody(null)
  }

  const activeCount    = ros.filter(r => r.status !== 'delivered').length
  const deliveredCount = deliveredRos.length

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-400 dark:text-zinc-600">
      <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      Loading…
    </div>
  )

  return (
    <div className="space-y-4">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">Production Board</h1>
          <p className="text-sm text-gray-400 dark:text-zinc-500 mt-0.5">
            {activeCount} active · {deliveredCount} delivered
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex bg-gray-100 dark:bg-zinc-800 rounded-lg p-1 gap-0.5">
            {VIEWS.map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs rounded-md font-medium transition-colors
                  ${view === v
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-gray-900 dark:text-gray-100'
                    : 'text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
              >
                {v === 'list' ? <><IconList /> List</> : <><IconGrid /> Kanban</>}
              </button>
            ))}
          </div>

          {view === 'list' && filtered.length > 0 && (
            <button
              onClick={() => handlePrintRos(filtered, employees)}
              className="hidden sm:inline-flex items-center gap-1.5 bg-gray-900 dark:bg-gray-100 hover:bg-gray-700 dark:hover:bg-gray-300 text-white dark:text-gray-900 text-sm font-medium px-3 sm:px-4 py-2 rounded-lg transition-colors"
            >
              Print
            </button>
          )}
        </div>
      </div>

      {/* ── AI Quick Update — desktop only (mobile uses the Update tab) */}
      <div className="hidden md:block">
        <AIInputBox
          ros={ros}
          employees={employeeList}
        />
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {/* Search */}
        <div className="relative">
          <span className="absolute left-3 top-2.5 text-gray-400 dark:text-zinc-500">
            <IconSearch />
          </span>
          <input
            type="text"
            placeholder="Search RO#, name, vehicle, insurance…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 dark:border-zinc-800 rounded-lg text-sm bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:ring-opacity-20"
          />
        </div>

        {/* Clickable status pills — horizontal scroll on mobile, wrap on desktop */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => setFilterStatus('all')}
            className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
              ${filterStatus === 'all'
                ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-transparent'
                : 'bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
          >
            All <span className="opacity-60 ml-0.5">{activeCount}</span>
          </button>
          {RO_STATUSES.filter(s => s.key !== 'delivered').map(s => {
            const count = statusCounts[s.key] || 0
            if (count === 0 && filterStatus !== s.key) return null
            return (
              <button
                key={s.key}
                onClick={() => setFilterStatus(prev => prev === s.key ? 'all' : s.key)}
                className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
                  ${filterStatus === s.key
                    ? `${s.color} border-transparent`
                    : 'bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${s.dot}`} />
                {s.label}
                <span className="opacity-60 ml-1">{count}</span>
              </button>
            )
          })}

          {/* Show Delivered toggle */}
          {deliveredCount > 0 && (
            <button
              onClick={() => setShowDeliveredArchive(v => !v)}
              className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
                ${showDeliveredArchive
                  ? 'bg-zinc-700 dark:bg-zinc-300 text-white dark:text-zinc-900 border-transparent'
                  : 'bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
            >
              {showDeliveredArchive ? '✓ ' : ''}Delivered
              <span className="opacity-60 ml-1">{deliveredCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <div className="text-center py-24 text-gray-400 dark:text-zinc-600">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M16 6l-1.5-3h-5L8 6M3 10l1-4h16l1 4M5 10v7a1 1 0 001 1h1a1 1 0 001-1v-1h8v1a1 1 0 001 1h1a1 1 0 001-1v-7"/>
            <circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="16.5" cy="11.5" r="1" fill="currentColor"/>
          </svg>
          <p className="font-medium">No repair orders found</p>
        </div>
      )}

      {/* ── List view ────────────────────────────────────────────────────── */}
      {view === 'list' && filtered.length > 0 && (
        <>
        <div className="space-y-2 sm:hidden">
          {filtered.map(ro => (
            <MobileListCard key={ro.id} ro={ro} onSelect={setSelectedRO} />
          ))}
        </div>
        <div className="hidden sm:block bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-zinc-800 text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left font-semibold">RO #</th>
                  <th className="px-4 py-3 text-left font-semibold">Insurance · Vehicle · Owner</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-left font-semibold">Estimator</th>
                  <th className="px-4 py-3 text-left font-semibold">Body Tech</th>
                  <th className="px-4 py-3 text-left font-semibold">Parts</th>
                  <th className="px-4 py-3 text-left font-semibold">Drop-off</th>
                  <th className="px-4 py-3 text-left font-semibold">Due</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                {filtered.map(ro => <RORow key={ro.id} ro={ro} employees={employees} onSelect={setSelectedRO} />)}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {/* ── Kanban view ───────────────────────────────────────────────────── */}
      {view === 'kanban' && filtered.length > 0 && (
        <>
          <div className="space-y-3 sm:hidden">
            {kanbanGroups.map(group => (
              <section key={group.key} className="space-y-2">
                <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${group.accent} ${group.color}`}>
                  <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                  <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map(ro => (
                    <MobileROCard key={ro.id} ro={ro} onSelect={setSelectedRO} />
                  ))}
                  {group.items.length === 0 && (
                    <div className="rounded-xl border border-dashed border-gray-200 py-4 text-center text-xs text-gray-300 dark:border-zinc-800 dark:text-zinc-700">No vehicles</div>
                  )}
                </div>
              </section>
            ))}
          </div>

          {/* Desktop: full kanban */}
          <div className="hidden sm:grid sm:grid-cols-5 gap-3 pb-4">
            {kanbanGroups.map(group => (
              <div
                key={group.key}
                className="min-w-0"
                onDragOver={e => { e.preventDefault(); setDragOverGroup(group.key) }}
                onDragLeave={() => setDragOverGroup(null)}
                onDrop={() => handleDrop(group)}
              >
                <div className={`flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl border transition-colors
                  ${dragOverGroup === group.key ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30' : `${group.accent} ${group.color}`}`}>
                  <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                  <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                </div>
                <div className={`space-y-2.5 min-h-[60px] rounded-xl transition-colors ${dragOverGroup === group.key ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                  {group.items.map(ro => (
                    <KanbanCard
                      key={ro.id}
                      ro={ro}
                      onSelect={setSelectedRO}
                      draggable={isManager}
                      onDragStart={() => setDragRoId(ro.id)}
                      onDragEnd={() => { setDragRoId(null); setDragOverGroup(null) }}
                    />
                  ))}
                  {group.items.length === 0 && (
                    <div className="text-center py-6 text-gray-300 dark:text-zinc-700 text-xs">—</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Status picker modal (for multi-status columns) ───────────────── */}
      {deliveredCount > 0 && (
        <div className="border-t border-gray-200 dark:border-zinc-800 pt-4">
          <button
            onClick={() => setShowDeliveredArchive(v => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500"
          >
            Delivered Vehicles
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-zinc-800 dark:text-zinc-400">{deliveredCount}</span>
          </button>
          {showDeliveredArchive && (
            <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-gray-400 dark:border-zinc-800 dark:text-zinc-500">
                      <th className="px-4 py-3 text-left font-semibold">RO #</th>
                      <th className="px-4 py-3 text-left font-semibold">Vehicle</th>
                      <th className="px-4 py-3 text-left font-semibold">Owner</th>
                      <th className="px-4 py-3 text-left font-semibold">Insurance</th>
                      <th className="px-4 py-3 text-left font-semibold">Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                    {deliveredRos.map(ro => (
                      <tr key={ro.id} onClick={() => setSelectedRO(ro)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50">
                        <td className="px-4 py-3 font-mono text-sm font-bold text-gray-900 dark:text-gray-100">#{ro.roNumber}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 dark:text-zinc-300">{ro.vehicle}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{ro.customerName}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{shortInsurance(ro.insuranceCompany)}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{fmtDate(ro.cccDateOut || ro.promisedDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {statusPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-xs border border-gray-200 dark:border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
              <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">Set Status</p>
            </div>
            <div className="p-3 space-y-1.5">
              {statusPicker.statuses.map(s => {
                const info = STATUS_MAP[s]
                return (
                  <button
                    key={s}
                    onClick={() => { applyStatusDrop(statusPicker.roId, s); setStatusPicker(null) }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className={`w-2 h-2 rounded-full ${info?.dot}`} />
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{info?.label ?? s}</span>
                  </button>
                )
              })}
            </div>
            <div className="px-4 py-3 border-t border-gray-100 dark:border-zinc-800">
              <button
                onClick={() => setStatusPicker(null)}
                className="w-full py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-gray-200"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── PendingToBodyModal ───────────────────────────────────────────── */}
      {pendingToBody && (
        <PendingToBodyModal
          ro={pendingToBody.ro}
          employees={employeeList}
          onConfirm={applyPendingToBody}
          onCancel={() => setPendingToBody(null)}
        />
      )}

      {/* ── RODrawer ────────────────────────────────────────────────────────── */}
      {selectedRO && (
        <RODrawer
          ro={selectedRO}
          employees={employees}
          onClose={() => setSelectedRO(null)}
        />
      )}
    </div>
  )
}
