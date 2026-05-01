import { useEffect, useState, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { collection, onSnapshot, query, orderBy, where } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { StatusBadge, PartsStatusBadge } from '../components/StatusBadge'
import AIInputBox from '../components/AIInputBox'
import RODrawer   from '../components/RODrawer'
import {
  RO_STATUSES, STATUS_MAP, PARTS_STATUSES,
  ROLE_STATUS_FILTER, MANAGER_ROLES, EDIT_RO_ROLES,
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
          <div className="text-xs text-gray-400 dark:text-zinc-500 mb-0.5 truncate">{ro.insuranceCompany}</div>
        )}
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
          {ro.vehicle}{ro.vehicleColor ? ` · ${ro.vehicleColor}` : ''}
        </div>
        <div className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5 truncate">{ro.customerName}</div>
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
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400 whitespace-nowrap">
        {fmtDate(ro.dropOffDate)}
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
function KanbanCard({ ro, onSelect }) {
  const dueDate = ro.cccDateOut || ro.promisedDate

  return (
    <div
      onClick={() => onSelect(ro)}
      className="relative bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-xl p-3.5 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-zinc-700 transition-all cursor-pointer group"
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
          <p className="text-xs text-gray-400 dark:text-zinc-500">{ro.vehicleColor}</p>
        )}

        {/* Owner */}
        <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5 truncate">{ro.customerName}</p>

        {/* Insurance + Claim — brand only, strip "INSURANCE SERVICES" etc. */}
        {(ro.insuranceCompany || ro.claimNumber) && (
          <div className="mt-2 text-xs text-gray-400 dark:text-zinc-600 truncate">
            {ro.insuranceCompany && <span>{shortInsurance(ro.insuranceCompany)}</span>}
            {ro.claimNumber && <span className="ml-1 opacity-70">#{ro.claimNumber}</span>}
          </div>
        )}

        {/* Dates row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          {/* Drop-off (manual entry, not CCC) */}
          {ro.dropOffDate ? (
            <span className="text-xs text-gray-400 dark:text-zinc-600">
              In: {fmtDate(ro.dropOffDate)}
            </span>
          ) : (
            <span className="text-xs text-gray-300 dark:text-zinc-700 italic">
              {ro.carStatus === 'pending_dropoff' ? 'Pending' : 'No drop-off'}
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

const VIEWS = ['list', 'kanban']

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ROBoard() {
  const { role, user } = useAuth()
  const toast      = useToast()
  const isManager  = MANAGER_ROLES.includes(role)
  const canEdit    = EDIT_RO_ROLES.includes(role)
  const prevRosRef = useRef(null)          // for change-detection

  const [ros,            setRos]            = useState([])
  const [employees,      setEmployees]      = useState({})
  const [selectedRO,     setSelectedRO]     = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('list')
  const [search,         setSearch]         = useState('')
  const [filterStatus,   setFilterStatus]   = useState('all')
  const [showDelivered,  setShowDelivered]  = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().name })
      setEmployees(map)
    })
    return unsub
  }, [])

  useEffect(() => {
    const roleFilter = ROLE_STATUS_FILTER[role]
    let q

    if (isManager) {
      q = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))
    } else if (roleFilter) {
      q = query(collection(db, 'ros'), where('status', 'in', roleFilter), orderBy('roNumber', 'asc'))
    } else if (role === 'estimator') {
      q = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))
    } else {
      q = query(collection(db, 'ros'), where('assignedBodyMan', '==', user.uid), orderBy('roNumber', 'asc'))
    }

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
  }, [role, user.uid, isManager])   // toast is stable, no need in deps

  const filtered = useMemo(() => ros.filter(ro => {
    // Delivered filter
    if (!showDelivered && ro.status === 'delivered') return false
    const matchStatus = filterStatus === 'all' || ro.status === filterStatus
    const q = search.toLowerCase()
    const matchSearch = !q
      || ro.roNumber?.toLowerCase().includes(q)
      || ro.customerName?.toLowerCase().includes(q)
      || ro.vehicle?.toLowerCase().includes(q)
      || ro.insuranceCompany?.toLowerCase().includes(q)
    return matchStatus && matchSearch
  }), [ros, filterStatus, search, showDelivered])

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

  const activeCount    = ros.filter(r => r.status !== 'delivered').length
  const deliveredCount = ros.filter(r => r.status === 'delivered').length

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

          {canEdit && (
            <Link
              to="/ro/new"
              className="inline-flex items-center gap-1.5 bg-gray-900 dark:bg-gray-100 hover:bg-gray-700 dark:hover:bg-gray-300 text-white dark:text-gray-900 text-sm font-medium px-3 sm:px-4 py-2 rounded-lg transition-colors"
            >
              <IconPlus />
              <span className="hidden sm:inline">New RO</span>
            </Link>
          )}
        </div>
      </div>

      {/* ── AI Quick Update — visible to all users (technicians use it for notes & photos) */}
      <AIInputBox
        ros={ros}
        employees={Object.entries(employees).map(([uid, name]) => ({ uid, name }))}
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
          {RO_STATUSES.map(s => {
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
              onClick={() => setShowDelivered(v => !v)}
              className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
                ${showDelivered
                  ? 'bg-zinc-700 dark:bg-zinc-300 text-white dark:text-zinc-900 border-transparent'
                  : 'bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
            >
              {showDelivered ? '✓ ' : ''}Delivered
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
          <div className="hidden sm:flex gap-3 overflow-x-auto pb-4 -mx-1 px-1">
            {kanbanGroups.map(group => (
              <div key={group.key} className="flex-shrink-0 w-64">
                <div className={`flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl border ${group.accent} ${group.color}`}>
                  <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                  <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                </div>
                <div className="space-y-2.5">
                  {group.items.map(ro => <KanbanCard key={ro.id} ro={ro} onSelect={setSelectedRO} />)}
                  {group.items.length === 0 && (
                    <div className="text-center py-6 text-gray-300 dark:text-zinc-700 text-xs">—</div>
                  )}
                </div>
              </div>
            ))}
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
    </div>
  )
}
