import { useEffect, useState, useMemo, useRef } from 'react'
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
  EDIT_RO_ROLES,
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
    return 'text-gray-500 dark:text-zinc-400'
  } catch { return '' }
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

// ── SVG icons ─────────────────────────────────────────────────────────────────
function IconSearch() { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg> }
function IconPlus()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M12 5v14M5 12h14"/></svg> }
function IconList()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg> }
function IconGrid()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IconPencil() { return <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> }
function IconPrint()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z"/></svg> }

// ── List row ─────────────────────────────────────────────────────────────────
function RORow({ ro, employees, onSelect }) {
  const bodyTech  = employees[ro.assignedBodyMan]   ?? '—'
  // Estimator: prefer CCC name, fall back to assigned UID lookup
  const estimator = ro.estimatorName || employees[ro.assignedEstimator] || '—'
  const dueDate   = ro.cccDateOut || ro.promisedDate  // CCC out-date takes priority

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
        <div className="text-xs text-gray-400 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</div>
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
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400 whitespace-nowrap">{estimator}</td>

      {/* Body Tech */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400 whitespace-nowrap">{bodyTech}</td>

      {/* Parts */}
      <td className="px-4 py-3 whitespace-nowrap">
        <PartsStatusBadge status={ro.partsStatus} />
      </td>

      {/* Drop-off Date (manual, not CCC) */}
      <td className="px-4 py-3 text-xs whitespace-nowrap">
        {ro.dropOffDate ? (
          <span className="text-gray-500 dark:text-zinc-400">{fmtDate(ro.dropOffDate)}</span>
        ) : (
          <span className="inline-flex items-center gap-1 font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 rounded">
            {ro.status !== 'checked_in' && (
              <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
              </svg>
            )}
            Pending
          </span>
        )}
      </td>

      {/* Due Date */}
      <td className={`px-4 py-3 text-xs whitespace-nowrap ${dueDateClass(dueDate)}`}>
        {fmtDate(dueDate)}
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
function KanbanCard({ ro, onSelect, onDragStart, draggable }) {
  const dueDate = ro.cccDateOut || ro.promisedDate

  return (
    <div
      onClick={() => onSelect(ro)}
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(ro.id) } : undefined}
      onDragEnd={draggable ? () => onDragStart(null) : undefined}
      className={`relative bg-white dark:bg-zinc-800/90 border border-gray-200 dark:border-zinc-700 rounded-xl p-3.5 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-zinc-500 transition-all group
        ${draggable ? 'cursor-grab active:cursor-grabbing active:opacity-60 active:scale-[0.98]' : 'cursor-pointer'}`}
    >
      {/* Edit icon — navigates to RODetail without opening drawer */}
      <Link
        to={`/ro/${ro.id}`}
        onClick={e => e.stopPropagation()}
        title="Open full detail"
        className="absolute top-2.5 right-2.5 p-1 rounded-md text-gray-300 dark:text-zinc-500 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/40 transition-colors opacity-0 group-hover:opacity-100"
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
          <p className="text-xs text-gray-400 dark:text-zinc-400">{ro.vehicleColor}</p>
        )}

        {/* Owner */}
        <p className="text-xs text-gray-500 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</p>

        {/* Insurance + Claim — brand only, strip "INSURANCE SERVICES" etc. */}
        {(ro.insuranceCompany || ro.claimNumber) && (
          <div className="mt-2 text-xs text-gray-400 dark:text-zinc-400 truncate">
            {ro.insuranceCompany && <span>{shortInsurance(ro.insuranceCompany)}</span>}
            {ro.claimNumber && <span className="ml-1 opacity-70">#{ro.claimNumber}</span>}
          </div>
        )}

        {/* Dates row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          {/* Drop-off (manual entry, not CCC) */}
          {ro.dropOffDate ? (
            <span className="text-xs text-gray-400 dark:text-zinc-400">
              In: {fmtDate(ro.dropOffDate)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 rounded">
              {ro.status !== 'checked_in' && (
                <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                </svg>
              )}
              Pending
            </span>
          )}

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
    </div>
  )
}

// ── PENDING → BODY confirmation modal ────────────────────────────────────────
// Ensures body man, painter, authorization, drop-off date, and rental are set
// before the RO moves from any PENDING status into body work.
function PendingToBodyModal({ ro, employeeList, targetStatus, onConfirm, onCancel }) {
  // Find body men and painters from employee list
  const bodyMen  = employeeList.filter(e => e.role === 'body_man')
  const painters = employeeList.filter(e => e.role === 'painter')

  // Pre-fill from existing RO data
  const [bodyManUid,  setBodyManUid]  = useState(ro.assignedBodyMan ?? '')
  const [painterUid,  setPainterUid]  = useState(
    ro.assignedPainter ?? (painters.length === 1 ? painters[0].uid : '')
  )
  const [authorized,  setAuthorized]  = useState(ro.customerAuthorized ?? null) // null = not yet answered
  const [dropOffDate, setDropOffDate] = useState(ro.dropOffDate ?? '')
  const [hasRental,   setHasRental]   = useState(ro.hasRental ?? null)           // null = not yet answered

  const targetLabel = STATUS_MAP[targetStatus]?.label ?? targetStatus

  // Validation
  const missingBodyMan  = !bodyManUid
  const missingAuth     = authorized === null
  const missingDropOff  = !dropOffDate
  const missingRental   = hasRental === null
  const canConfirm      = !missingBodyMan && !missingAuth && !missingDropOff && !missingRental

  const handleConfirm = () => {
    if (!canConfirm) return
    onConfirm({
      status:           targetStatus,
      assignedBodyMan:  bodyManUid,
      assignedPainter:  painterUid,
      customerAuthorized: authorized,
      dropOffDate,
      hasRental,
      carStatus:        'car_in_shop',
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-800 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-0.5">Status Change Confirmation</p>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              RO #{ro.roNumber} → {targetLabel}
            </h2>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">{ro.vehicle} · {ro.customerName}</p>
          </div>
          <button onClick={onCancel} className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* 1. Body Man */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-zinc-400 mb-1.5">
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0 ${bodyManUid ? 'bg-green-500' : 'bg-red-400'}`}>
                {bodyManUid ? '✓' : '!'}
              </span>
              Assigned Body Tech <span className="text-red-400">*</span>
            </label>
            <select
              value={bodyManUid}
              onChange={e => setBodyManUid(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select body tech —</option>
              {bodyMen.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* 2. Painter (auto-filled if only one) */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-zinc-400 mb-1.5">
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0 ${painterUid ? 'bg-green-500' : 'bg-gray-300 dark:bg-zinc-600'}`}>
                {painterUid ? '✓' : '—'}
              </span>
              Assigned Painter
              {painters.length === 1 && <span className="ml-1 text-gray-400 dark:text-zinc-500 font-normal">(auto-filled)</span>}
            </label>
            <select
              value={painterUid}
              onChange={e => setPainterUid(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select painter —</option>
              {painters.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* 3. Customer authorization */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-zinc-400 mb-1.5">
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0 ${authorized === true ? 'bg-green-500' : authorized === false ? 'bg-red-400' : 'bg-red-400'}`}>
                {authorized !== null ? '✓' : '!'}
              </span>
              Customer Authorized to Start Repair? <span className="text-red-400">*</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setAuthorized(true)}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold border-2 transition-all
                  ${authorized === true
                    ? 'bg-green-500 border-green-500 text-white'
                    : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-green-400 hover:text-green-600'}`}
              >
                ✓ Yes — Authorized
              </button>
              <button
                onClick={() => setAuthorized(false)}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold border-2 transition-all
                  ${authorized === false
                    ? 'bg-red-500 border-red-500 text-white'
                    : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-red-400 hover:text-red-600'}`}
              >
                ✗ No — Not Yet
              </button>
            </div>
          </div>

          {/* 4. Drop-off date + Rental */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-zinc-400 mb-1.5">
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0 ${dropOffDate ? 'bg-green-500' : 'bg-red-400'}`}>
                  {dropOffDate ? '✓' : '!'}
                </span>
                Drop-Off Date <span className="text-red-400">*</span>
              </label>
              <input
                type="date"
                value={dropOffDate}
                onChange={e => setDropOffDate(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-zinc-400 mb-1.5">
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0 ${hasRental !== null ? 'bg-green-500' : 'bg-red-400'}`}>
                  {hasRental !== null ? '✓' : '!'}
                </span>
                Rental Car? <span className="text-red-400">*</span>
              </label>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setHasRental(true)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border-2 transition-all
                    ${hasRental === true
                      ? 'bg-amber-500 border-amber-500 text-white'
                      : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-amber-400'}`}
                >Yes</button>
                <button
                  onClick={() => setHasRental(false)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border-2 transition-all
                    ${hasRental === false
                      ? 'bg-gray-500 border-gray-500 text-white'
                      : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-gray-400'}`}
                >No</button>
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 dark:border-zinc-800 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400 dark:text-zinc-500">
            {!canConfirm ? 'Please fill in all required fields marked with !' : 'All checks passed — ready to confirm.'}
          </p>
          <div className="flex gap-2 shrink-0">
            <button onClick={onCancel} className="px-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              Confirm & Move →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const VIEWS = ['list', 'kanban']

// ── Print list ────────────────────────────────────────────────────────────────
function handlePrint(filtered, employees, filterLabel) {
  const now     = new Date()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  const rows = filtered.map(ro => {
    const bodyTech  = employees[ro.assignedBodyMan]   || '—'
    const estimator = ro.estimatorName || employees[ro.assignedEstimator] || '—'
    const dueDate   = ro.cccDateOut || ro.promisedDate
    const status    = STATUS_MAP[ro.status]?.label ?? ro.status ?? '—'
    const parts     = ro.partsStatus?.replace(/_/g, ' ') ?? '—'
    const dropOff   = ro.dropOffDate ? fmtDate(ro.dropOffDate) : '—'
    const due       = dueDate ? fmtDate(dueDate) : '—'
    const dueOverdue = dueDate && differenceInDays(parseISO(dueDate), now) < 0

    return `<tr>
      <td><span class="ro-num">#${ro.roNumber}</span>${ro.hasRental ? ' <span class="tag rental">Rental</span>' : ''}</td>
      <td>
        <div class="veh">${ro.vehicle || '—'}${ro.vehicleColor ? ' · ' + ro.vehicleColor : ''}</div>
        <div class="sub">${ro.customerName || '—'}</div>
        ${ro.insuranceCompany ? `<div class="sub ins">${ro.insuranceCompany}${ro.claimNumber ? ' #' + ro.claimNumber : ''}</div>` : ''}
      </td>
      <td><span class="tag">${status}</span></td>
      <td>${estimator}</td>
      <td>${bodyTech}</td>
      <td>${parts}</td>
      <td>${dropOff === '—' ? '<span class="pending-cell">Pending</span>' : dropOff}</td>
      <td class="${dueOverdue ? 'overdue' : ''}">${due}</td>
    </tr>`
  }).join('')

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Production Board — CS SCA Collision</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 14px; border-bottom: 2px solid #111; padding-bottom: 10px; }
    .shop { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
    .meta { font-size: 10px; color: #555; text-align: right; line-height: 1.6; }
    .filter-label { display: inline-block; margin-bottom: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #444; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #111; color: #fff; text-align: left; padding: 6px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; }
    tbody td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; line-height: 1.45; }
    tbody tr:nth-child(even) td { background: #f9fafb; }
    tbody tr:hover td { background: #eff6ff; }
    .ro-num { font-family: 'Courier New', monospace; font-weight: 800; font-size: 12px; }
    .veh { font-weight: 600; font-size: 11px; }
    .sub { font-size: 9.5px; color: #555; margin-top: 1px; }
    .ins { color: #777; }
    .tag { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 9px; font-weight: 700; background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
    .rental { background: #fef3c7; color: #92400e; border-color: #fde68a; }
    .pending-cell { color: #d97706; font-weight: 700; font-size: 10px; }
    .overdue { color: #dc2626; font-weight: 700; }
    .footer { margin-top: 16px; font-size: 9px; color: #aaa; text-align: right; }
    @page { size: landscape; margin: 0.5in; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="shop">CS SCA Collision</div>
      <div style="font-size:11px;color:#555;margin-top:3px;">Production Board</div>
    </div>
    <div class="meta">
      Printed: ${dateStr} ${timeStr}<br>
      ${filtered.length} active RO${filtered.length !== 1 ? 's' : ''}${filterLabel ? ' · Filter: ' + filterLabel : ''}
    </div>
  </div>

  ${filterLabel ? `<div class="filter-label">Showing: ${filterLabel}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th style="width:80px">RO #</th>
        <th>Vehicle · Owner · Insurance</th>
        <th style="width:90px">Status</th>
        <th style="width:90px">Estimator</th>
        <th style="width:90px">Body Tech</th>
        <th style="width:80px">Parts</th>
        <th style="width:65px">Drop-off</th>
        <th style="width:55px">Due</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="footer">CS SCA Collision — Confidential</div>

  <script>window.onload = () => { window.print(); window.onafterprint = () => window.close(); }<\/script>
</body>
</html>`

  const win = window.open('', '_blank', 'width=1100,height=700')
  win.document.write(html)
  win.document.close()
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ROBoard() {
  const { role } = useAuth()
  const toast      = useToast()
  const canEdit    = EDIT_RO_ROLES.includes(role)
  const prevRosRef = useRef(null)          // for change-detection

  const [ros,            setRos]            = useState([])
  const [employees,      setEmployees]      = useState({})
  const [employeeList,   setEmployeeList]   = useState([])
  const [selectedRO,     setSelectedRO]     = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('kanban')
  const [search,         setSearch]         = useState('')
  const [filterStatus,   setFilterStatus]   = useState('all')
  const [showDelivered,  setShowDelivered]  = useState(false)
  const [dragRoId,       setDragRoId]       = useState(null)   // id of card being dragged
  const [dragOverGroup,  setDragOverGroup]  = useState(null)   // group key being hovered
  const [statusPicker,   setStatusPicker]   = useState(null)   // { ro, statuses, pos }  — shown after drop
  const [pendingToBody,  setPendingToBody]  = useState(null)   // { ro, targetStatus }  — PENDING→BODY confirmation

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      const list = []
      snap.forEach(d => {
        const data = d.data()
        map[d.id] = data.name
        list.push({ uid: d.id, id: d.id, ...data })
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
    // Always exclude delivered from main board (they live in the Delivered section below)
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

  // Count per status (for filter pills)
  const statusCounts = useMemo(() => {
    const counts = {}
    ros.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })
    return counts
  }, [ros])

  // Kanban: 6 fixed group columns
  const kanbanGroups = useMemo(() => {
    return STATUS_GROUPS.map(group => ({
      ...group,
      items: filtered.filter(ro => group.statuses.includes(ro.status)),
    }))
  }, [filtered])

  const deliveredRos   = useMemo(() => ros.filter(r => r.status === 'delivered'), [ros])
  const activeCount    = ros.filter(r => r.status !== 'delivered').length
  const deliveredCount = ros.filter(r => r.status === 'delivered').length

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const handleDrop = (e, targetGroup) => {
    e.preventDefault()
    setDragOverGroup(null)
    if (!dragRoId) return
    const ro = ros.find(r => r.id === dragRoId)
    setDragRoId(null)
    if (!ro) return

    // Stay in same group? No-op.
    const currentGroup = STATUS_GROUPS.find(g => g.statuses.includes(ro.status))
    if (currentGroup?.key === targetGroup.key) return

    // PENDING → BODY: show the special confirmation modal
    const isPendingToBody = currentGroup?.key === 'PENDING' && targetGroup.key === 'BODY'
    if (isPendingToBody) {
      setPendingToBody({ ro, targetStatus: 'body_work' })
      return
    }

    // All other transitions: if only 1 status apply directly, else show status picker
    if (targetGroup.statuses.length === 1) {
      applyStatusDrop(ro, targetGroup.statuses[0])
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      setStatusPicker({ ro, statuses: targetGroup.statuses, x: rect.left + rect.width / 2, y: rect.top + 60 })
    }
  }

  const applyStatusDrop = async (ro, newStatus) => {
    setStatusPicker(null)
    const now   = new Date()
    const stamp = `${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`
    try {
      await updateDoc(doc(db, 'ros', ro.id), {
        status:    newStatus,
        updatedAt: serverTimestamp(),
        changeLog: arrayUnion({ type: 'status', value: newStatus, by: 'drag', at: stamp, source: 'board' }),
      })
      toast.success(`RO #${ro.roNumber} → ${STATUS_MAP[newStatus]?.label ?? newStatus}`)
    } catch (err) {
      toast.error('Update failed: ' + err.message)
    }
  }

  // Apply PENDING → BODY after modal confirmation
  const applyPendingToBody = async ({ status, assignedBodyMan, assignedPainter, customerAuthorized, dropOffDate, hasRental, carStatus }) => {
    const ro  = pendingToBody.ro
    setPendingToBody(null)
    const now   = new Date()
    const stamp = `${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`

    // Build the auto-note
    const bodyTechName  = employeeList.find(e => e.uid === assignedBodyMan)?.name  ?? assignedBodyMan
    const painterName   = employeeList.find(e => e.uid === assignedPainter)?.name  ?? ''
    const authText      = customerAuthorized ? 'Customer authorized repair.' : 'Customer NOT yet authorized — repair started pending authorization.'
    const dropText      = `Drop-off: ${dropOffDate}.`
    const rentalText    = hasRental ? 'Rental car: Yes.' : 'Rental car: No.'
    const paintText     = painterName ? ` Painter: ${painterName}.` : ''
    const noteText      = `${authText} Body tech: ${bodyTechName}.${paintText} ${dropText} ${rentalText}`
    const noteLine      = `[${stamp} - Status Move] ${noteText}`

    try {
      const updates = {
        status,
        assignedBodyMan,
        dropOffDate,
        hasRental,
        carStatus,
        customerAuthorized,
        updatedAt: serverTimestamp(),
        notes: `${noteLine}\n${ro.notes ?? ''}`,
        changeLog: arrayUnion({ type: 'status', value: status, by: 'drag', at: stamp, source: 'board' }),
      }
      if (assignedPainter) updates.assignedPainter = assignedPainter
      await updateDoc(doc(db, 'ros', ro.id), updates)
      toast.success(`RO #${ro.roNumber} moved to Body Work ✓`)
    } catch (err) {
      toast.error('Update failed: ' + err.message)
    }
  }

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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">Production Board</h1>
          <p className="text-sm text-gray-400 dark:text-zinc-500 mt-0.5">
            {activeCount} active · {deliveredCount} delivered
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle — hidden on mobile (kanban too wide for small screens) */}
          <div className="hidden sm:flex bg-gray-100 dark:bg-zinc-800 rounded-lg p-1 gap-0.5">
            {VIEWS.map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md font-medium transition-colors
                  ${view === v
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-gray-900 dark:text-gray-100'
                    : 'text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
              >
                {v === 'list' ? <><IconList /> List</> : <><IconGrid /> Kanban</>}
              </button>
            ))}
          </div>

          {/* Print — only in list view */}
          {view === 'list' && filtered.length > 0 && (
            <button
              onClick={() => handlePrint(filtered, employees, filterStatus !== 'all' ? (STATUS_MAP[filterStatus]?.label ?? filterStatus) : '')}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-500 dark:text-zinc-400 border border-gray-200 dark:border-zinc-700 rounded-lg hover:border-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              title="Print list as PDF"
            >
              <IconPrint />
              <span className="hidden sm:inline">Print</span>
            </button>
          )}

          {/* +New RO hidden — not needed for this location */}
        </div>
      </div>

      {/* ── AI Quick Update — visible to all users (technicians use it for notes & photos) */}
      <AIInputBox
        ros={ros}
        employees={employeeList}
      />

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
            All <span className="opacity-60 ml-0.5">{ros.length}</span>
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

          {/* Delivered moved to bottom section */}
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
          {canEdit && (
            <Link to="/ro/new" className="mt-3 inline-block text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-gray-100 underline underline-offset-2">
              Add your first RO
            </Link>
          )}
        </div>
      )}

      {/* ── List view ────────────────────────────────────────────────────── */}
      {view === 'list' && filtered.length > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-sm">
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
      )}

      {/* ── Kanban view ───────────────────────────────────────────────────── */}
      {view === 'kanban' && filtered.length > 0 && (
        <>
          {/* Mobile: render as list (kanban columns are too wide for small screens) */}
          <div className="sm:hidden bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-zinc-800 text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wider">
                    <th className="px-4 py-3 text-left font-semibold">RO #</th>
                    <th className="px-4 py-3 text-left font-semibold">Vehicle · Owner</th>
                    <th className="px-4 py-3 text-left font-semibold">Status</th>
                    <th className="px-4 py-3 text-left font-semibold">Parts</th>
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

          {/* Desktop: full kanban */}
          <div className="hidden sm:flex gap-2 pb-4">
            {kanbanGroups.map(group => {
              const isOver = dragOverGroup === group.key && dragRoId !== null
              return (
                <div
                  key={group.key}
                  className="flex-1 min-w-0"
                  onDragOver={canEdit ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverGroup(group.key) } : undefined}
                  onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverGroup(null) } : undefined}
                  onDrop={canEdit ? (e) => handleDrop(e, group) : undefined}
                >
                  {/* Column header — lights up when dragging over */}
                  <div className={`flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl border transition-all
                    ${isOver
                      ? `${group.accent} ring-2 ring-offset-1 ring-current opacity-100 scale-[1.01]`
                      : `${group.accent} ${group.color}`}
                    ${isOver ? group.color : ''}`}
                  >
                    <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                    <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                    {isOver && <span className="text-xs opacity-80 animate-pulse">Drop here</span>}
                  </div>
                  {/* Cards + drop target zone */}
                  <div className={`space-y-2.5 min-h-[60px] rounded-xl transition-all
                    ${isOver ? 'bg-blue-50/60 dark:bg-blue-900/20 ring-1 ring-blue-300 dark:ring-blue-700 ring-inset' : ''}`}
                  >
                    {group.items.map(ro => (
                      <KanbanCard
                        key={ro.id}
                        ro={ro}
                        onSelect={setSelectedRO}
                        draggable={canEdit}
                        onDragStart={setDragRoId}
                      />
                    ))}
                    {group.items.length === 0 && (
                      <div className={`text-center py-6 text-xs transition-colors
                        ${isOver ? 'text-blue-400 dark:text-blue-500' : 'text-gray-300 dark:text-zinc-700'}`}>
                        {isOver ? '↓ Release to move here' : '—'}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── RODrawer ────────────────────────────────────────────────────────── */}
      {selectedRO && (
        <RODrawer
          ro={selectedRO}
          employees={employees}
          onClose={() => setSelectedRO(null)}
        />
      )}

      {/* ── Delivered Vehicles ───────────────────────────────────────────────── */}
      {deliveredCount > 0 && (
        <div className="border-t border-gray-100 dark:border-zinc-800 pt-4 mt-2">
          <button
            onClick={() => setShowDelivered(v => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            <svg
              className={`w-4 h-4 transition-transform duration-200 ${showDelivered ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
            <span>🚗 Delivered Vehicles</span>
            <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-zinc-800 text-xs font-medium text-gray-500 dark:text-zinc-400">
              {deliveredCount}
            </span>
          </button>

          {showDelivered && (
            <div className="mt-3 bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-zinc-800 text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wider">
                      <th className="px-4 py-3 text-left font-semibold">RO #</th>
                      <th className="px-4 py-3 text-left font-semibold">Vehicle · Owner</th>
                      <th className="px-4 py-3 text-left font-semibold">Insurance</th>
                      <th className="px-4 py-3 text-left font-semibold">Estimator</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                    {deliveredRos.map(ro => (
                      <tr
                        key={ro.id}
                        onClick={() => setSelectedRO(ro)}
                        className="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer group"
                      >
                        <td className="px-4 py-3">
                          <span className="font-mono text-sm font-bold text-gray-500 dark:text-zinc-400">
                            #{ro.roNumber}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-sm text-gray-700 dark:text-gray-300">{ro.vehicle}</div>
                          <div className="text-xs text-gray-400 dark:text-zinc-500">{ro.customerName}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400">
                          {ro.insuranceCompany || '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400">
                          {ro.estimatorName || employees[ro.assignedEstimator] || '—'}
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
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── PENDING → BODY confirmation modal ─────────────────────────────── */}
      {pendingToBody && (
        <PendingToBodyModal
          ro={pendingToBody.ro}
          employeeList={employeeList}
          targetStatus={pendingToBody.targetStatus}
          onConfirm={applyPendingToBody}
          onCancel={() => setPendingToBody(null)}
        />
      )}

      {/* ── Status picker (shown after drag-drop into a multi-status column) ── */}
      {statusPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setStatusPicker(null)}>
          <div
            className="absolute bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-2xl shadow-2xl p-3 min-w-[180px]"
            style={{ left: Math.min(statusPicker.x - 90, window.innerWidth - 200), top: Math.min(statusPicker.y, window.innerHeight - 200) }}
            onClick={e => e.stopPropagation()}
          >
            <p className="text-xs font-semibold text-gray-500 dark:text-zinc-400 mb-2 px-1">
              RO #{statusPicker.ro.roNumber} — set status to:
            </p>
            {statusPicker.statuses.map(s => {
              const st = STATUS_MAP[s]
              return (
                <button
                  key={s}
                  onClick={() => applyStatusDrop(statusPicker.ro, s)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-700 text-left transition-colors"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${st?.dot ?? 'bg-gray-400'}`} />
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{st?.label ?? s}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
