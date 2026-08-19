import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  addDoc, arrayUnion, collection, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc, writeBatch,
} from 'firebase/firestore'
import { differenceInCalendarDays, format, isValid, parseISO, subDays } from 'date-fns'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { MANAGER_ROLES, PARTS_STATUSES, STATUS_MAP, WORKER_ROLES } from '../constants/roles'
import { getSuggestedNextStatus, getDownstreamTasks, STATUS_PHASE_TRIGGER } from '../engine/taskRules'
import RODrawer from '../components/RODrawer'
import AIInputBox from '../components/AIInputBox'
import { buildWorkerView } from '../utils/workerTaskSource'

function etaOf(ro) {
  return ro?.eta || ro?.cccDateOut || ro?.promisedDate || null
}

function roEtaPriority(ro) {
  const dateStr = etaOf(ro)
  if (!dateStr) return 'low'
  try {
    const days = differenceInCalendarDays(parseISO(dateStr), new Date())
    if (days <= 2) return 'high'
    if (days <= 7) return 'medium'
    return 'low'
  } catch {
    return 'low'
  }
}

function fmtDate(s) {
  if (!s) return '-'
  try {
    const d = parseISO(s)
    return isValid(d) ? format(d, 'M/dd') : s
  } catch {
    return s
  }
}

function fmtTaskNoteTime(value) {
  if (!value) return ''
  try {
    const d = value?.toDate ? value.toDate() : new Date(value)
    return isValid(d) ? format(d, 'M/dd h:mm a') : ''
  } catch {
    return ''
  }
}

function fmtPaintDue(s) {
  if (!s) return null
  try {
    const d = parseISO(s)
    return isValid(d) ? format(subDays(d, 1), 'M/dd') : null
  } catch {
    return null
  }
}

function dueDateClass(s) {
  if (!s) return 'text-gray-400 dark:text-zinc-600'
  try {
    const d = differenceInCalendarDays(parseISO(s), new Date())
    if (d < 0) return 'text-red-500 dark:text-red-400 font-semibold'
    if (d <= 2) return 'text-amber-500 dark:text-amber-400 font-medium'
    return 'text-gray-500 dark:text-zinc-300'
  } catch {
    return ''
  }
}

function etaChipClass(s) {
  if (!s) return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
  try {
    const d = differenceInCalendarDays(parseISO(s), new Date())
    if (d < 0) return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200'
    if (d <= 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
    return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'
  } catch {
    return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
  }
}

function partsProgress(ro) {
  const orders = Array.isArray(ro.partsOrders) ? ro.partsOrders : []
  let total = 0, received = 0
  for (const order of orders) {
    const qty = Number(order.qty ?? order.quantity ?? 0)
    const rcvd = Number(order.qtyReceived ?? order.receivedQty ?? 0)
    if (Number.isFinite(qty)) total += qty
    if (Number.isFinite(rcvd)) received += rcvd
  }
  if (total > 0) return `${received}/${total} parts`
  if (ro.partsStatus) return PARTS_LABEL[ro.partsStatus] ?? ro.partsStatus
  return 'Parts unknown'
}

function taskSortKey(task) {
  if (task.sortOrder != null) return task.sortOrder
  const v = task.createdAt
  if (v?.toMillis) return v.toMillis()
  if (v?.seconds) return v.seconds * 1000
  return 0
}

function shortInsurance(name) {
  if (!name) return ''
  return name.replace(/\s+INSURANCE\b.*/i, '').trim() || name
}

const PRIORITY_STYLE = {
  high:   { bar: 'border-l-4 border-l-red-500',   tag: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
  medium: { bar: 'border-l-4 border-l-amber-400', tag: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  low:    { bar: 'border-l-4 border-l-gray-200',  tag: 'bg-gray-100 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400' },
}

const PARTS_LABEL = Object.fromEntries(PARTS_STATUSES.map(s => [s.key, s.label]))

function partsClass(status) {
  return PARTS_STATUSES.find(s => s.key === status)?.color || 'bg-gray-100 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400'
}

function rentalText(ro) {
  if (ro.hasRental === true) return 'Rental'
  if (ro.hasRental === false) return 'No rental'
  return 'Rental ?'
}

function rentalClass(ro) {
  if (ro.hasRental === true) return 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
  if (ro.hasRental === false) return 'bg-gray-100 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400'
  return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
}

function isNewTask(task) {
  if (!task.assignedAt) return false
  const millis = task.assignedAt?.toMillis?.() ?? (task.assignedAt?.seconds != null ? task.assignedAt.seconds * 1000 : null)
  if (millis == null) return false
  return Date.now() - millis < 86_400_000
}

function newTaskDate(task) {
  const millis = task.assignedAt?.toMillis?.() ?? (task.assignedAt?.seconds != null ? task.assignedAt.seconds * 1000 : null)
  if (millis == null) return ''
  return format(new Date(millis), 'M/d')
}

function groupTasksByRO(list) {
  const map = new Map()
  for (const task of list) {
    const key = task.roId || task.roNumber || task.id
    const group = map.get(key)
    if (group) {
      group.tasks.push(task)
      group.sortKey = Math.min(group.sortKey, taskSortKey(task))
    } else {
      map.set(key, {
        id: key,
        roId: task.roId,
        roNumber: task.roNumber,
        vehicleInfo: task.vehicleInfo,
        sortKey: taskSortKey(task),
        tasks: [task],
      })
    }
  }
  return [...map.values()]
    .map(group => ({ ...group, tasks: dedupeTasks([...group.tasks].sort((a, b) => taskSortKey(a) - taskSortKey(b))) }))
    .sort((a, b) => a.sortKey - b.sortKey)
}

function semanticTaskKey(task) {
  const title = (task.title || '').toLowerCase()
  const description = (task.description || '').toLowerCase()
  const text = `${title} ${description}`
  if (task.category === 'body' || /\b(teardown|tear down|process repair|perform teardown)\b/.test(text)) return 'teardown'
  return title.replace(/\b(on|for|the|a|an|vehicle|car)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim() || task.id
}

function statusRank(status) {
  if (status === 'in_progress') return 3
  if (status === 'pending') return 2
  if (status === 'completed') return 1
  return 0
}

function dedupeTasks(list) {
  const map = new Map()
  for (const task of list) {
    const key = semanticTaskKey(task)
    const current = map.get(key)
    if (!current || statusRank(task.status) > statusRank(current.status) || taskSortKey(task) > taskSortKey(current)) {
      map.set(key, task)
    }
  }
  return [...map.values()].sort((a, b) => taskSortKey(a) - taskSortKey(b))
}

function displayTaskTitle(task) {
  if (task.displayTitle) return task.displayTitle
  if (semanticTaskKey(task) === 'teardown') return 'Teardown'
  return task.title || 'Task'
}

function AssignedROCard({ ro, onOpenDrawer }) {
  const eta = etaOf(ro)
  const paintDue = fmtPaintDue(eta)
  const priority = roEtaPriority(ro)
  const status = STATUS_MAP[ro.status]
  const ps = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.low

  return (
    <button
      type="button"
      onClick={() => onOpenDrawer?.(ro.id)}
      className={`block w-full text-left overflow-hidden bg-white dark:bg-zinc-800/90 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-zinc-600 transition-all p-3.5 ${ps.bar}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-mono text-sm font-extrabold text-gray-900 dark:text-gray-100">
          #{ro.roNumber}
        </span>
        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-bold ${ps.tag}`}>
          {priority.toUpperCase()}
        </span>
      </div>

      <div className="mb-2 flex min-w-0 gap-1">
        {ro.partsStatus && (
          <span className={`min-w-0 truncate text-[10px] px-1.5 py-0.5 rounded font-semibold ${partsClass(ro.partsStatus)}`}>
            {PARTS_LABEL[ro.partsStatus] ?? ro.partsStatus}
          </span>
        )}
        {status && (
          <span className={`min-w-0 truncate text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${status.color}`}>
            {status.label}
          </span>
        )}
      </div>

      <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate leading-snug">
        {ro.vehicle}
      </p>
      {ro.vehicleColor && (
        <p className="text-xs text-gray-400 dark:text-zinc-500">{ro.vehicleColor}</p>
      )}
      <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5 truncate">
        {shortInsurance(ro.insuranceCompany) || ro.customerName || ''}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="text-gray-400 dark:text-zinc-500">
          {ro.dropOffDate ? `In: ${fmtDate(ro.dropOffDate)}` : (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 font-semibold text-[10px]">Pending</span>
          )}
        </span>
        {eta && (
          <span className={`font-semibold ${dueDateClass(eta)}`}>
            Due {fmtDate(eta)}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${rentalClass(ro)}`}>
          {rentalText(ro)}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${paintDue ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-gray-100 text-gray-400 dark:bg-zinc-700 dark:text-zinc-500'}`}>
          {paintDue ? `Paint due ${paintDue}` : 'No paint due'}
        </span>
      </div>
    </button>
  )
}

function MobileAssignedROCard({ ro, onOpenDrawer }) {
  const eta = etaOf(ro)
  const paintDue = fmtPaintDue(eta)
  const status = STATUS_MAP[ro.status]
  const priority = roEtaPriority(ro)

  return (
    <button type="button" onClick={() => onOpenDrawer?.(ro.id)} className="w-full text-left">
      <article className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-extrabold text-gray-950 dark:text-gray-100">
                #{ro.roNumber}
              </span>
              {status && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.color}`}>
                  {status.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">
              {ro.vehicle || 'Vehicle missing'}
            </p>
            {ro.vehicleColor && (
              <p className="text-xs text-gray-400 dark:text-zinc-500">{ro.vehicleColor}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${(PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.low).tag}`}>
              {priority.toUpperCase()}
            </span>
            {ro.partsStatus && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${partsClass(ro.partsStatus)}`}>
                {PARTS_LABEL[ro.partsStatus] ?? ro.partsStatus}
              </span>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-gray-500 dark:text-zinc-400">
            {shortInsurance(ro.insuranceCompany) || ro.customerName || ''}
          </span>
          {eta && (
            <span className={`shrink-0 font-semibold ${dueDateClass(eta)}`}>
              Due {fmtDate(eta)}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${rentalClass(ro)}`}>
            {rentalText(ro)}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${paintDue ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-gray-100 text-gray-400 dark:bg-zinc-700 dark:text-zinc-500'}`}>
            {paintDue ? `Paint due ${paintDue}` : 'No paint due'}
          </span>
        </div>
      </article>
    </button>
  )
}

function StatusPromotionCard({ promotion, onConfirm, onDismiss }) {
  const [extraNote, setExtraNote] = useState('')
  const nextLabel = STATUS_MAP[promotion.nextStatus]?.label ?? promotion.nextStatus.replace(/_/g, ' ')

  return (
    <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
      <div className="mb-2 flex items-start gap-2">
        <span className="text-base">✅</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-green-800 dark:text-green-300">Phase complete</p>
          <p className="mt-0.5 text-xs text-green-700 dark:text-green-400">
            Advance RO → <span className="font-semibold">{nextLabel}</span>
          </p>
        </div>
      </div>
      <input
        type="text"
        value={extraNote}
        onChange={e => setExtraNote(e.target.value)}
        placeholder="Optional note..."
        className="mb-2 w-full rounded-lg border border-green-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 dark:border-green-700 dark:bg-zinc-900 dark:text-gray-200"
      />
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(promotion.roId, promotion.nextStatus, promotion.noteText, extraNote)}
          className="flex-1 rounded-lg bg-green-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-700"
        >
          Confirm
        </button>
        <button
          onClick={() => onDismiss(promotion.roId)}
          className="rounded-lg border border-green-300 px-3 py-1.5 text-xs text-green-700 transition-colors hover:bg-green-100 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900/40"
        >
          Later
        </button>
      </div>
    </div>
  )
}

function taskGlyph(status) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}

function taskGlyphTone(status) {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20'
  if (status === 'in_progress') return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-100 dark:ring-blue-400/20'
  return 'bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700'
}

function IconEdit({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m14 7 3 3" />
    </svg>
  )
}

function DailyTaskRow({
  task,
  onStatusChange, onNote, onDelete, canDelete = false,
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const inputRef = useRef(null)
  const isDone = task.status === 'completed'
  const notes = Array.isArray(task.taskNotes) ? task.taskNotes : []

  const sourceSubtitle = !task.autoTriggered && task.assignedByName ? `By ${task.assignedByName}` : null

  const handleNoteSubmit = async () => {
    const txt = noteText.trim()
    if (!txt) return
    await onNote(task, txt)
    setNoteText('')
    setNoteOpen(false)
  }

  const openNote = () => {
    setNoteOpen(true)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  const nextStatus = task.status === 'pending' ? 'in_progress' : 'completed'
  const btnLabel = isDone ? 'Done' : task.status === 'in_progress' ? 'Working' : 'Start'

  return (
    <div className={`rounded-xl px-2.5 py-2.5 ring-1 ${
      isDone
        ? 'bg-emerald-50/45 ring-emerald-200/70 dark:bg-white/[0.025] dark:ring-white/10'
        : 'bg-white/65 ring-zinc-200/90 dark:bg-black/30 dark:ring-zinc-800/90'
    }`}>
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${taskGlyphTone(task.status)}`}>
          {taskGlyph(task.status)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className={`truncate text-[13px] font-semibold leading-tight ${isDone ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-950 dark:text-zinc-50'}`}>
              {displayTaskTitle(task)}
            </p>
            {task.autoTriggered && (
              <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">Auto</span>
            )}
            {sourceSubtitle && (
              <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{sourceSubtitle}</span>
            )}
            {isNewTask(task) && (
              <span className="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>
            )}
          </div>
          {notes.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {notes.map((note, idx) => (
                <p key={`${note.at || idx}-${idx}`} className="truncate text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  — {note.text}{note.by ? ` · ${note.by}` : ''}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!isDone && !noteOpen && (
            <button
              onClick={openNote}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-500 ring-1 ring-zinc-200 transition hover:text-zinc-800 dark:ring-zinc-700 dark:hover:text-zinc-200"
            >Note</button>
          )}
          {!isDone && (
            <button
              onClick={() => onStatusChange(task.id, nextStatus)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition active:scale-[0.98] ${taskGlyphTone(task.status)}`}
            >{btnLabel}</button>
          )}
          {isDone && (
            <button
              onClick={() => onStatusChange(task.id, 'pending')}
              className="rounded-full px-2.5 py-1 text-[11px] text-zinc-400 ring-1 ring-zinc-200 transition hover:text-zinc-600 dark:ring-zinc-700 dark:hover:text-zinc-300"
            >Reopen</button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setEditOpen(prev => !prev)}
              className={`flex h-7 w-7 items-center justify-center rounded-full ring-1 transition ${
                editOpen
                  ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-100'
                  : 'text-zinc-500 ring-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:text-zinc-100'
              }`}
              aria-label="Edit task actions"
              title="Edit task actions"
            >
              <IconEdit />
            </button>
          )}
          {canDelete && editOpen && (
            <button onClick={() => onDelete(task)} className="rounded-full px-2 py-1 text-[11px] text-red-500 ring-1 ring-red-200 hover:text-red-600 dark:ring-red-900 dark:text-red-400">Delete</button>
          )}
        </div>
      </div>

      {noteOpen && (
        <div className="mt-2 flex gap-2 pl-8">
          <input
            ref={inputRef}
            type="text"
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleNoteSubmit() }}
            placeholder="Add note..."
            className="flex-1 min-w-0 text-xs border border-gray-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={handleNoteSubmit} className="text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium shrink-0">Save</button>
          <button onClick={() => { setNoteOpen(false); setNoteText('') }} className="text-xs px-2 py-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200">×</button>
        </div>
      )}

      {task.status === 'in_progress' && !noteOpen && (
        <div className="mx-8 mt-2 h-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40">
          <div className="h-0.5 w-1/2 rounded-full bg-blue-500 animate-pulse" />
        </div>
      )}
    </div>
  )
}

function DailyTaskGroupCard({
  group, isManager, dragId, overId, setDragId, setOverId,
  onDrop, onStatusChange, onNote, draggable = true,
  pendingPromotion, onConfirmPromotion, onDismissPromotion, onDeleteTask, canDeleteTasks = false,
  onOpenDrawer,
}) {
  const canDrag = isManager && draggable
  const isDragging = dragId === group.id
  const isOver = overId === group.id
  const promotion = pendingPromotion?.[group.roId]
  const hasNewTask = group.tasks.some(isNewTask)
  const doneCount = group.tasks.filter(t => t.status === 'completed').length

  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? () => setDragId(group.id) : undefined}
      onDragEnd={canDrag ? () => { setDragId(null); setOverId(null) } : undefined}
      onDragOver={canDrag ? e => { e.preventDefault(); setOverId(group.id) } : undefined}
      onDrop={canDrag ? onDrop : undefined}
      className={`rounded-[1.35rem] border bg-white/82 p-3.5 shadow-lg shadow-zinc-200/70 backdrop-blur-xl transition dark:bg-zinc-950/80 dark:shadow-black/20
        ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}
        ${isDragging ? 'opacity-50 scale-[0.99]' : ''}
        ${isOver ? 'border-blue-400 dark:border-blue-500' : 'border-zinc-200 dark:border-zinc-800'}
      `}
    >
      {/* Card header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {canDrag && (
              <span className="shrink-0 select-none text-xs font-bold text-gray-300 dark:text-zinc-600" title="Drag to reorder">::</span>
            )}
            {group.roId ? (
              <button
                type="button"
                onClick={() => onOpenDrawer?.(group.roId)}
                className="font-mono text-[15px] font-semibold tracking-tight text-blue-500 transition hover:text-blue-400 dark:text-blue-400 dark:hover:text-blue-300"
              >
                #{group.roNumber}
              </button>
            ) : (
              <span className="text-xs font-bold text-zinc-400 dark:text-zinc-500">Standalone</span>
            )}
            {hasNewTask && (
              <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>
            )}
          </div>
          {group.vehicleInfo && (
            <p className="mt-0.5 truncate text-[13px] font-semibold text-zinc-950 dark:text-zinc-100">{group.vehicleInfo}</p>
          )}
        </div>
        <span className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          {doneCount}/{group.tasks.length} done
        </span>
      </div>

      {/* Tasks sub-card */}
      <div className="rounded-2xl bg-zinc-50/90 p-2 ring-1 ring-zinc-200 dark:bg-zinc-950/45 dark:ring-white/10">
        <div className="space-y-1.5">
          {group.tasks.map(task => (
            <DailyTaskRow
              key={task.id}
              task={task}
              onStatusChange={onStatusChange}
              onNote={onNote}
              onDelete={onDeleteTask}
              canDelete={canDeleteTasks}
            />
          ))}
        </div>
      </div>

      {promotion && (
        <StatusPromotionCard
          promotion={promotion}
          onConfirm={onConfirmPromotion}
          onDismiss={onDismissPromotion}
        />
      )}
    </div>
  )
}

function WorkerROCard({
  ro, tasks, isManager, canDeleteTasks, dragId, overId, setDragId, setOverId,
  onDrop, onStatusChange, onNote, onDeleteTask,
  pendingPromotion, onConfirmPromotion, onDismissPromotion,
  onOpenDrawer, draggable = true,
}) {
  const canDrag = isManager && draggable
  const isDragging = dragId === ro.id
  const isOver = overId === ro.id
  const promotion = pendingPromotion?.[ro.id]
  const hasNewTask = tasks.some(isNewTask)
  const doneCount = tasks.filter(t => t.status === 'completed').length
  const eta = etaOf(ro)
  const status = STATUS_MAP[ro.status]

  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? () => setDragId(ro.id) : undefined}
      onDragEnd={canDrag ? () => { setDragId(null); setOverId(null) } : undefined}
      onDragOver={canDrag ? e => { e.preventDefault(); setOverId(ro.id) } : undefined}
      onDrop={canDrag ? onDrop : undefined}
      className={`rounded-[1.35rem] border bg-white/82 p-3.5 shadow-lg shadow-zinc-200/70 backdrop-blur-xl transition dark:bg-zinc-950/80 dark:shadow-black/20
        ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}
        ${isDragging ? 'opacity-50 scale-[0.99]' : ''}
        ${isOver ? 'border-blue-400 dark:border-blue-500' : 'border-zinc-200 dark:border-zinc-800'}
      `}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {canDrag && (
              <span className="shrink-0 select-none text-xs font-bold text-gray-300 dark:text-zinc-600" title="Drag to reorder">::</span>
            )}
            <button
              type="button"
              onClick={() => onOpenDrawer?.(ro.id)}
              className="font-mono text-[15px] font-semibold tracking-tight text-blue-500 transition hover:text-blue-400 dark:text-blue-400 dark:hover:text-blue-300"
            >
              #{ro.roNumber}
            </button>
            {hasNewTask && (
              <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">NEW</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] font-semibold text-zinc-950 dark:text-zinc-100">
            {ro.vehicle || ro.vehicleInfo || ''}
          </p>
          {ro.vehicleColor && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{ro.vehicleColor}</p>
          )}
          <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {shortInsurance(ro.insuranceCompany) || ro.customerName || ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {status && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${status.color}`}>
              {status.label}
            </span>
          )}
          {eta && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${etaChipClass(eta)}`}>
              Due {fmtDate(eta)}
            </span>
          )}
          <span className="rounded-lg px-2 py-1 text-[11px] font-semibold bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            {doneCount}/{tasks.length} done
          </span>
        </div>
      </div>

      {ro.partsStatus && ro.partsStatus !== 'not_ordered' && (
        <div className="mb-3 flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${partsClass(ro.partsStatus)}`}>
            {partsProgress(ro)}
          </span>
        </div>
      )}

      <div className="rounded-2xl bg-zinc-50/90 p-2 ring-1 ring-zinc-200 dark:bg-zinc-950/45 dark:ring-white/10">
        {tasks.length === 0 ? (
          <p className="px-2.5 py-3 text-[12px] text-zinc-500">No tasks assigned</p>
        ) : (
          <div className="space-y-1.5">
            {tasks.map(task => (
              <DailyTaskRow
                key={task.id}
                task={task}
                onStatusChange={onStatusChange}
                onNote={onNote}
                onDelete={onDeleteTask}
                canDelete={canDeleteTasks}
              />
            ))}
          </div>
        )}
      </div>

      {promotion && (
        <StatusPromotionCard
          promotion={promotion}
          onConfirm={onConfirmPromotion}
          onDismiss={onDismissPromotion}
        />
      )}
    </div>
  )
}

function MobilePreviewStat({ number, label }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white/80 px-3 py-2.5 shadow-sm shadow-black/5 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-black/20">
      <div className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{number}</div>
      <div className="mt-0.5 text-[10px] font-medium uppercase text-zinc-500">{label}</div>
    </div>
  )
}

function mobileTaskGlyph(status) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '•'
  return ''
}

function mobileTaskTone(status) {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-200'
  if (status === 'in_progress') return 'bg-blue-500 text-white ring-1 ring-blue-400/40'
  return 'bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800'
}

function mobileTaskButtonLabel(status) {
  if (status === 'completed') return 'Complete'
  if (status === 'in_progress') return 'Finish'
  return 'Start'
}

function ManagerMobileTaskRow({ task, onStatusChange, onNote, onDelete, canDelete = false, canEdit = true }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const inputRef = useRef(null)
  const nextStatus = task.status === 'pending' ? 'in_progress' : task.status === 'in_progress' ? 'completed' : 'completed'
  const notes = Array.isArray(task.taskNotes) ? task.taskNotes : []
  const latestNote = notes[notes.length - 1]?.text || task.description || ''
  const submitNote = async () => {
    const value = noteText.trim()
    if (!value) return
    await onNote?.(task, value)
    setNoteText('')
    setNoteOpen(false)
  }
  const openNote = () => {
    setNoteOpen(true)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  return (
    <div className={`flex items-center gap-2 rounded-xl px-2.5 py-2.5 ring-1 ${
      task.status === 'completed'
        ? 'bg-emerald-50/45 ring-emerald-200/70 dark:bg-white/[0.025] dark:ring-white/10'
        : 'bg-white/65 ring-zinc-200/90 dark:bg-black/30 dark:ring-zinc-800/90'
    } flex-wrap`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${mobileTaskTone(task.status)}`}>
          {mobileTaskGlyph(task.status)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight text-zinc-950 dark:text-zinc-50">{displayTaskTitle(task)}</p>
          {latestNote && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{latestNote}</p>}
        </div>
      </div>
      {canEdit && !noteOpen && (
        <button
          type="button"
          onClick={openNote}
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-500 ring-1 ring-zinc-200 transition hover:text-zinc-800 dark:ring-zinc-700 dark:hover:text-zinc-200"
        >
          Note
        </button>
      )}
      {canEdit && !noteOpen && (
        <button
          type="button"
          onClick={() => onStatusChange(task.id, nextStatus)}
          disabled={task.status === 'completed'}
          className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition active:scale-[0.98] ${mobileTaskTone(task.status)} disabled:opacity-80`}
        >
          {mobileTaskButtonLabel(task.status)}
        </button>
      )}
      {canDelete && !noteOpen && (
        <button
          type="button"
          onClick={() => setEditOpen(prev => !prev)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 transition ${
            editOpen
              ? 'bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-100'
              : 'text-zinc-500 ring-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:text-zinc-100'
          }`}
          aria-label="Edit task actions"
          title="Edit task actions"
        >
          <IconEdit />
        </button>
      )}
      {canDelete && editOpen && !noteOpen && (
        <button
          type="button"
          onClick={() => onDelete?.(task)}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] text-red-500 ring-1 ring-red-200 hover:text-red-600 dark:ring-red-900 dark:text-red-400"
        >
          Delete
        </button>
      )}
      {noteOpen && (
        <div className="flex w-full gap-2 pl-8">
          <input
            ref={inputRef}
            type="text"
            value={noteText}
            onChange={event => setNoteText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submitNote() }}
            placeholder="Add note for worker..."
            className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-gray-200 dark:placeholder-zinc-600"
          />
          <button type="button" onClick={submitNote} className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Save</button>
          <button type="button" onClick={() => { setNoteOpen(false); setNoteText('') }} className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200">×</button>
        </div>
      )}
    </div>
  )
}

function ManagerMobileROCard({
  group, dragId, overId, setDragId, setOverId, onDrop,
  onStatusChange, onNote, onDeleteTask, canDeleteTasks = false, onOpenDrawer, draggable = true, showCompleted = false,
}) {
  const { ro, tasks } = group
  const [showDoneTasks, setShowDoneTasks] = useState(false)
  const canDrag = draggable
  const sortedTasks = dedupeTasks([...tasks].sort((a, b) => taskSortKey(a) - taskSortKey(b)))
  const activeTasks = sortedTasks.filter(t => t.status !== 'completed')
  const completedTasks = sortedTasks.filter(t => t.status === 'completed')
  const visibleTasks = showCompleted ? completedTasks : activeTasks
  const doneCount = completedTasks.length
  const eta = etaOf(ro)
  const status = STATUS_MAP[ro.status]
  const isDragging = dragId === group.id
  const isOver = overId === group.id

  return (
    <article
      draggable={canDrag}
      onDragStart={canDrag ? () => setDragId(group.id) : undefined}
      onDragEnd={canDrag ? () => { setDragId(null); setOverId(null) } : undefined}
      onDragOver={canDrag ? e => { e.preventDefault(); setOverId(group.id) } : undefined}
      onDrop={canDrag ? onDrop : undefined}
      className={`rounded-[1.35rem] border bg-white/82 p-3.5 shadow-lg shadow-zinc-200/70 backdrop-blur-xl transition dark:bg-zinc-950/80 dark:shadow-black/20
        ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}
        ${isDragging ? 'opacity-50 scale-[0.99]' : ''}
        ${isOver ? 'border-blue-500/80 ring-1 ring-blue-400/25 dark:border-blue-400/55 dark:ring-blue-400/10' : 'border-zinc-200 dark:border-zinc-800'}
      `}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {canDrag && (
              <span className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-zinc-100 text-[15px] font-bold leading-none text-zinc-400 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-800" title="Drag up/down to reorder">
                ⋮⋮
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpenDrawer?.(ro.id)}
              className="font-mono text-[16px] font-semibold tracking-tight text-blue-400 transition hover:text-blue-300 active:scale-[0.98]"
            >
              #{ro.roNumber}
            </button>
          </div>
          <h3 className="mt-1 max-w-[16rem] text-[16px] font-semibold leading-[1.08] tracking-tight text-zinc-950 dark:text-zinc-50">
            {ro.vehicle || ro.vehicleInfo || ''}
          </h3>
          {(ro.vehicleColor || ro.insuranceCompany || ro.customerName) && (
            <p className="mt-1 truncate text-[12px] text-zinc-500 dark:text-zinc-500">
              {[ro.vehicleColor, shortInsurance(ro.insuranceCompany) || ro.customerName].filter(Boolean).join(' · ')}
            </p>
          )}
          {ro.vin && <p className="mt-0.5 truncate font-mono text-[12px] tracking-[0.02em] text-zinc-500 dark:text-zinc-400">{ro.vin}</p>}
          <p className="mt-2 inline-flex rounded-full bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-800 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-800">
            <span className="mr-1 text-zinc-500">Parts</span>{partsProgress(ro)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {status && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${status.color}`}>
              {status.label}
            </span>
          )}
          {eta && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${etaChipClass(eta)}`}>
              Due {fmtDate(eta)}
            </span>
          )}
        </div>
      </div>

      {sortedTasks.length > 0 && (
        <div className="mt-4 rounded-2xl bg-zinc-50/90 p-2 ring-1 ring-zinc-200 dark:bg-zinc-950/45 dark:ring-white/10">
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              {showCompleted ? 'Completed' : sortedTasks.length > 1 ? `${sortedTasks.length} tasks` : 'Task'}
            </p>
            <p className="text-[11px] font-medium text-zinc-500">{doneCount}/{sortedTasks.length} done</p>
          </div>
          <div className="space-y-1.5">
            {visibleTasks.map(task => (
              <ManagerMobileTaskRow key={task.id} task={task} onStatusChange={onStatusChange} onNote={onNote} onDelete={onDeleteTask} canDelete={canDeleteTasks} canEdit={!showCompleted} />
            ))}
            {!showCompleted && completedTasks.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDoneTasks(prev => !prev)}
                className="flex w-full items-center justify-between rounded-xl bg-emerald-50/45 px-2.5 py-2 text-left text-[12px] font-semibold text-emerald-700 ring-1 ring-emerald-200/60 transition active:scale-[0.99] dark:bg-white/[0.025] dark:text-emerald-200 dark:ring-white/10"
              >
                <span>Completed {doneCount}/{sortedTasks.length}</span>
                <span className="text-[11px] text-emerald-500 dark:text-emerald-300">{showDoneTasks ? 'Hide' : 'Show'}</span>
              </button>
            )}
            {!showCompleted && showDoneTasks && completedTasks.map(task => (
              <ManagerMobileTaskRow key={task.id} task={task} onStatusChange={onStatusChange} onNote={onNote} onDelete={onDeleteTask} canDelete={canDeleteTasks} canEdit={false} />
            ))}
            {visibleTasks.length === 0 && (!showDoneTasks || completedTasks.length === 0) && (
              <div className="rounded-xl px-2.5 py-3 text-[12px] text-zinc-500">
                {showCompleted ? 'No completed task yet' : 'No active task assigned'}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  )
}

function ManagerWorkerMobileBoard({
  workerName, workerRole, activeGroups, doneGroups, showDone, setShowDone,
  dragId, overId, setDragId, setOverId, onDrop, onStatusChange, onNote, onDeleteTask, canDeleteTasks, onOpenDrawer,
}) {
  const activeTasks = activeGroups.reduce((sum, group) => sum + group.tasks.length, 0)
  const doneTasks = doneGroups.reduce((sum, group) => sum + group.tasks.length, 0)
  const dueSoon = activeGroups.filter(group => {
    const eta = etaOf(group.ro)
    if (!eta) return false
    try {
      return differenceInCalendarDays(parseISO(eta), new Date()) <= 2
    } catch {
      return false
    }
  }).length
  const initials = (workerName || 'W').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="rounded-[2rem] border border-zinc-200 bg-[#f6f7f9] px-4 pb-6 pt-5 text-zinc-950 shadow-inner shadow-zinc-200/70 dark:border-zinc-800 dark:bg-[#050608] dark:text-zinc-100 dark:shadow-black/30">
      <div className="mx-auto max-w-md">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-zinc-950 dark:text-white">My Work</h1>
            <p className="mt-1 text-[13px] text-zinc-500">
              {workerName || 'Worker'}{workerRole ? ` · ${workerRole}` : ''} · {format(new Date(), 'EEEE, MMM d')}
            </p>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-500/20 text-sm font-semibold text-blue-100 ring-1 ring-blue-400/30">
            {initials}
          </div>
        </header>

        <section className="mt-5 grid grid-cols-3 gap-2">
          <MobilePreviewStat number={activeGroups.length} label="cars" />
          <MobilePreviewStat number={activeTasks} label="tasks" />
          <MobilePreviewStat number={dueSoon} label="due soon" />
        </section>

        <section className="mt-4 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" className="shrink-0 rounded-full bg-blue-500 px-4 py-2 text-sm font-semibold text-white">
            Active
          </button>
          <button
            type="button"
            onClick={() => setShowDone(prev => !prev)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
              showDone
                ? 'bg-blue-500 text-white'
                : 'bg-white/80 text-zinc-600 shadow-sm shadow-zinc-200/60 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-black/20 dark:ring-zinc-800'
            }`}
          >
            Done {doneTasks}
          </button>
        </section>

        <section className="mt-5">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-zinc-950 dark:text-white">My ROs</h2>
            <p className="text-[12px] text-zinc-500">drag cards up/down to reorder</p>
          </div>

          {activeGroups.length === 0 ? (
            <div className="rounded-3xl border border-zinc-200 bg-white/70 px-4 py-8 text-center text-sm text-zinc-500 shadow-sm shadow-zinc-200/60 dark:border-zinc-800 dark:bg-zinc-950/70 dark:shadow-black/20">
              No active ROs in this view.
            </div>
          ) : (
            <div className="space-y-3">
              {activeGroups.map(group => (
                <ManagerMobileROCard
                  key={group.id}
                  group={group}
                  dragId={dragId}
                  overId={overId}
                  setDragId={setDragId}
                  setOverId={setOverId}
                  onDrop={onDrop}
                  onStatusChange={onStatusChange}
                  onNote={onNote}
                  onDeleteTask={onDeleteTask}
                  canDeleteTasks={canDeleteTasks}
                  onOpenDrawer={onOpenDrawer}
                />
              ))}
            </div>
          )}

          {showDone && (
            <div className="mt-4 space-y-3">
              {doneGroups.length === 0 ? (
                <div className="rounded-3xl border border-zinc-200 bg-white/70 px-4 py-6 text-center text-sm text-zinc-500 shadow-sm shadow-zinc-200/60 dark:border-zinc-800 dark:bg-zinc-950/70 dark:shadow-black/20">
                  No completed ROs in this view.
                </div>
              ) : (
                doneGroups.map(group => (
                  <ManagerMobileROCard
                    key={group.id}
                    group={group}
                    dragId={null}
                    overId={null}
                    setDragId={() => {}}
                    setOverId={() => {}}
                    onDrop={() => {}}
                    onStatusChange={onStatusChange}
                    onNote={onNote}
                    onDeleteTask={onDeleteTask}
                    canDeleteTasks={canDeleteTasks}
                    onOpenDrawer={onOpenDrawer}
                    draggable={false}
                    showCompleted
                  />
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default function TaskBoard() {
  const { user, role } = useAuth()
  const toast = useToast()
  const isManager = MANAGER_ROLES.includes(role)
  const isShopManager = role === 'shop_manager'
  const hideMyROs = role === 'production_manager' || role === 'parts_manager'

  const [ros, setRos] = useState([])
  const [tasks, setTasks] = useState([])
  const [employees, setEmployees] = useState({})
  const [employeeRows, setEmployeeRows] = useState([])
  const [viewUid, setViewUid] = useState(user.uid)
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const [pendingPromotion, setPendingPromotion] = useState({})
  const [drawerRoId, setDrawerRoId] = useState(null)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      const rows = []
      snap.forEach(d => {
        const data = d.data()
        map[d.id] = data.name
        rows.push({ uid: d.id, name: data.name || data.email || 'Unnamed', role: data.role || '' })
      })
      setEmployees(map)
      setEmployeeRows(rows.sort((a, b) => a.name.localeCompare(b.name)))
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!isManager) setViewUid(user.uid)
  }, [isManager, user.uid])

  useEffect(() => {
    setDragId(null)
    setOverId(null)
    setShowDone(false)
  }, [viewUid])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'ros'), snap => {
      setRos(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'tasks'), snap => {
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return unsub
  }, [])

  const viewRole = useMemo(() => employeeRows.find(e => e.uid === viewUid)?.role || '', [employeeRows, viewUid])
  const viewingWorker = isManager && WORKER_ROLES.includes(viewRole)

  const assignedROs = useMemo(() => {
    const uid = viewUid
    return ros
      .filter(ro =>
        ro.status !== 'delivered' &&
        (ro.assignedBodyMan === uid ||
         ro.assignedPainter === uid ||
         ro.assignedEstimator === uid ||
         ro.assignedPartsManager === uid)
      )
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 }
        const pa = order[roEtaPriority(a)] ?? 2
        const pb = order[roEtaPriority(b)] ?? 2
        if (pa !== pb) return pa - pb
        const ea = etaOf(a) ?? '9999'
        const eb = etaOf(b) ?? '9999'
        return ea < eb ? -1 : ea > eb ? 1 : 0
      })
  }, [ros, viewUid])

  const activeRoIds = useMemo(() => new Set(ros.filter(r => r.status !== 'delivered').map(r => r.id)), [ros])

  const visibleTasks = useMemo(
    () => tasks.filter(t => t.assignedTo === viewUid && (!t.roId || activeRoIds.has(t.roId))),
    [tasks, viewUid, activeRoIds],
  )

  const activeTasks = useMemo(() => {
    return visibleTasks
      .filter(t => t.status !== 'completed')
      .sort((a, b) => taskSortKey(a) - taskSortKey(b))
  }, [visibleTasks])

  const doneTasks = useMemo(() => {
    return visibleTasks
      .filter(t => t.status === 'completed')
      .sort((a, b) => taskSortKey(b) - taskSortKey(a))
  }, [visibleTasks])

  const activeTaskGroups = useMemo(() => groupTasksByRO(activeTasks), [activeTasks])
  const doneTaskGroups = useMemo(() => groupTasksByRO(doneTasks), [doneTasks])

  const authorName = useMemo(
    () => employees[user.uid] ?? user.email ?? 'Unknown',
    [employees, user]
  )
  const drawerRo = useMemo(() => ros.find(r => r.id === drawerRoId) ?? null, [ros, drawerRoId])
  const viewingName = employees[viewUid] ?? (viewUid === user.uid ? 'Me' : 'Selected employee')
  const workerDisplayName = employees[viewUid] ?? ''

  const workerSource = useMemo(() => {
    if (!viewingWorker) return null
    return buildWorkerView(tasks, ros, viewUid, viewRole, workerDisplayName)
  }, [viewingWorker, tasks, ros, viewUid, viewRole, workerDisplayName])

  const activeWorkerGroups = useMemo(() => {
    if (!workerSource) return []
    const groups = []
    workerSource.workerRos.forEach((ro, idx) => {
      const allTasks = workerSource.visibleTasksByRo.get(ro.id) || []
      const active = allTasks.filter(t => t.status !== 'completed')
      if (!active.length && allTasks.length > 0) return
      const hasSortOrder = active.some(t => t.sortOrder != null)
      const sortKey = hasSortOrder
        ? active.reduce((min, t) => Math.min(min, taskSortKey(t)), Infinity)
        : idx * 10000
      groups.push({ id: ro.id, ro, tasks: active, sortKey })
    })
    return groups.sort((a, b) => a.sortKey - b.sortKey)
  }, [workerSource])

  const doneWorkerGroups = useMemo(() => {
    if (!workerSource) return []
    return workerSource.workerRos.flatMap(ro => {
      const done = (workerSource.visibleTasksByRo.get(ro.id) || []).filter(t => t.status === 'completed')
      return done.length ? [{ id: ro.id, ro, tasks: done }] : []
    })
  }, [workerSource])

  const handleStatusChange = async (taskId, newStatus) => {
    try {
      await updateDoc(doc(db, 'tasks', taskId), {
        status: newStatus,
        completedAt: newStatus === 'completed' ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      })

      if (newStatus === 'completed') {
        const task = tasks.find(t => t.id === taskId)
        if (!task?.roId || !task.phase) return
        const roData = ros.find(r => r.id === task.roId)
        if (!roData) return
        const requiredPhase = STATUS_PHASE_TRIGGER[roData.status]
        if (!requiredPhase || requiredPhase !== task.phase) return
        const phaseTasks = tasks.filter(t => t.roId === task.roId && t.phase === requiredPhase)
        const allDone = phaseTasks.length > 0 && phaseTasks.every(t => t.id === taskId || t.status === 'completed')
        if (allDone) {
          const suggestion = getSuggestedNextStatus(requiredPhase, roData)
          if (suggestion) {
            setPendingPromotion(prev => ({ ...prev, [task.roId]: { ...suggestion, roId: task.roId } }))
          }
        }
      }
    } catch (err) {
      toast.error('Update failed: ' + err.message)
    }
  }

  const handlePromotion = async (roId, nextStatus, noteText, extraNote = '') => {
    const roData = ros.find(r => r.id === roId)
    if (!roData) return
    const stamp = format(new Date(), 'MM/dd HH:mm')
    const extra = extraNote.trim()
    const note = extra
      ? `[${stamp} - ${authorName}] ${noteText} ${extra}`
      : `[${stamp} - ${authorName}] ${noteText}`
    const prevNotes = typeof roData.notes === 'string' ? roData.notes : ''
    try {
      await updateDoc(doc(db, 'ros', roId), {
        status: nextStatus,
        notes: prevNotes ? `${note}\n${prevNotes}` : note,
        updatedAt: serverTimestamp(),
      })
      const templates = getDownstreamTasks(nextStatus, roData)
      const roUpdates = {}
      for (const tmpl of templates) {
        const dup = tasks.find(t =>
          t.roId === roId
          && t.phase === tmpl.phase
          && (tmpl.category === 'paint' && tmpl.taskKind === 'primary'
            ? t.taskKind !== 'secondary' && (tmpl.statusBackfill || t.status !== 'completed')
            : t.title === tmpl.title && t.status !== 'completed')
        )
        if (dup) continue
        let assignTo = tmpl.assignedToUid
        if (!assignTo && tmpl.assignedToRole) {
          const emp = employeeRows.find(e => e.role === tmpl.assignedToRole)
          assignTo = emp?.uid ?? null
        }
        if (tmpl.setRoField && assignTo) roUpdates[tmpl.setRoField] = assignTo
        await addDoc(collection(db, 'tasks'), {
          roId,
          roNumber: roData.roNumber,
          vehicleInfo: roData.vehicle || roData.vehicleInfo || '',
          assignedTo: assignTo,
          assignedBy: user.uid,
          assignedByName: authorName,
          assignedAt: serverTimestamp(),
          title: tmpl.title,
          phase: tmpl.phase,
          category: tmpl.category,
          taskKind: tmpl.taskKind,
          autoTriggered: true,
          source: 'auto',
          status: 'pending',
          createdAt: serverTimestamp(),
          ...(tmpl.noAssigneeNote ? { taskNotes: [{ text: tmpl.noAssigneeNote, by: 'System', at: new Date().toISOString() }] } : {}),
        })
      }
      if (Object.keys(roUpdates).length) {
        await updateDoc(doc(db, 'ros', roId), { ...roUpdates, updatedAt: serverTimestamp() })
      }
      setPendingPromotion(prev => { const n = { ...prev }; delete n[roId]; return n })
      toast.success(`RO#${roData.roNumber} → ${STATUS_MAP[nextStatus]?.label ?? nextStatus}`)
    } catch (err) {
      toast.error('Promotion failed: ' + err.message)
    }
  }

  const handleDismissPromotion = (roId) => {
    setPendingPromotion(prev => { const n = { ...prev }; delete n[roId]; return n })
  }

  const handleTaskNote = async (task, noteText) => {
    const stamp = format(new Date(), 'MM/dd HH:mm')
    const noteObj = { text: noteText, by: authorName, at: new Date().toISOString() }
    const roNote = `[${stamp} - ${authorName}] Task update (${task.title || 'task'}): ${noteText}`

    try {
      await updateDoc(doc(db, 'tasks', task.id), {
        taskNotes: arrayUnion(noteObj),
        updatedAt: serverTimestamp(),
      })
      if (task.roId) {
        const roDoc = ros.find(r => r.id === task.roId)
        if (roDoc) {
          const prevNotes = typeof roDoc.notes === 'string' ? roDoc.notes : ''
          await updateDoc(doc(db, 'ros', task.roId), {
            notes: prevNotes ? `${roNote}\n${prevNotes}` : roNote,
            updatedAt: serverTimestamp(),
          })
        }
      }
      toast.success('Note saved')
    } catch (err) {
      toast.error('Note failed: ' + err.message)
    }
  }

  const handleDeleteTask = async (task) => {
    if (!isShopManager) return
    const ok = window.confirm(`Delete task "${task.title || 'Untitled task'}"? This cannot be undone.`)
    if (!ok) return
    try {
      await deleteDoc(doc(db, 'tasks', task.id))
      toast.success('Task deleted')
    } catch (err) {
      toast.error('Delete failed: ' + err.message)
    }
  }

  const handleDrop = async () => {
    if (!dragId || !overId || dragId === overId) {
      setDragId(null)
      setOverId(null)
      return
    }
    const sortedGroups = [...(viewingWorker ? activeWorkerGroups : activeTaskGroups)]
    const fromIdx = sortedGroups.findIndex(group => group.id === dragId)
    const toIdx = sortedGroups.findIndex(group => group.id === overId)
    if (fromIdx === -1 || toIdx === -1) {
      setDragId(null)
      setOverId(null)
      return
    }
    const reorderedGroups = [...sortedGroups]
    const [moved] = reorderedGroups.splice(fromIdx, 1)
    reorderedGroups.splice(toIdx, 0, moved)
    const reorderedTasks = reorderedGroups.flatMap(group => group.tasks)
    const batch = writeBatch(db)
    reorderedTasks.forEach((t, i) => batch.update(doc(db, 'tasks', t.id), { sortOrder: i * 1000 }))
    setDragId(null)
    setOverId(null)
    try {
      await batch.commit()
    } catch (err) {
      toast.error('Reorder failed: ' + err.message)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400 dark:text-zinc-600">Loading...</div>
  }

  return (
    <div className="space-y-8 pb-8">
      {drawerRo && (
        <RODrawer
          ro={drawerRo}
          employees={employees}
          onClose={() => setDrawerRoId(null)}
        />
      )}
      {isManager && (
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/90">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Manager View</p>
            <p className="mt-0.5 text-sm font-medium text-gray-800 dark:text-gray-100">
              Viewing {viewingName}'s task board
            </p>
          </div>
          <label className="flex min-w-56 flex-col gap-1 text-xs font-medium text-gray-500 dark:text-zinc-400">
            Employee
            <select
              value={viewUid}
              onChange={e => setViewUid(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-gray-100"
            >
              {employeeRows.map(emp => (
                <option key={emp.uid} value={emp.uid}>
                  {emp.name}{emp.role ? ` - ${emp.role}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {isManager && (
        <div className="hidden md:block">
          <AIInputBox
            ros={ros}
            employees={employeeRows}
            sourceRole={role}
          />
        </div>
      )}

      {!hideMyROs && !viewingWorker && (
        <section>
          <div className="flex items-baseline gap-2 mb-3">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              {isManager && viewUid !== user.uid ? `${viewingName}'s ROs` : 'My ROs'}
            </h2>
            <span className="text-sm text-gray-400 dark:text-zinc-500">
              {assignedROs.length} assigned · sorted by priority
            </span>
          </div>

          {assignedROs.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-zinc-600 py-6 text-center">No ROs assigned to you yet.</p>
          ) : (
            <>
              <div className="hidden sm:flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                {assignedROs.map(ro => (
                  <div key={ro.id} className="w-52 shrink-0">
                    <AssignedROCard ro={ro} onOpenDrawer={setDrawerRoId} />
                  </div>
                ))}
              </div>
              <div className="sm:hidden space-y-2">
                {assignedROs.map(ro => <MobileAssignedROCard key={ro.id} ro={ro} onOpenDrawer={setDrawerRoId} />)}
              </div>
            </>
          )}
        </section>
      )}

      <section>
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {isManager && viewUid !== user.uid ? `${viewingName}'s Tasks` : 'Daily Tasks'}
          </h2>
          <span className="text-sm text-gray-400 dark:text-zinc-500">
            {viewingWorker
              ? `${activeWorkerGroups.reduce((s, g) => s + g.tasks.length, 0)} active · ${workerSource?.workerRos.length || 0} ROs`
              : `${activeTasks.length} active`
            }{isManager && ' · drag to reorder'}
          </span>
        </div>

        {viewingWorker ? (
          <ManagerWorkerMobileBoard
            workerName={viewingName}
            workerRole={viewRole}
            activeGroups={activeWorkerGroups}
            doneGroups={doneWorkerGroups}
            showDone={showDone}
            setShowDone={setShowDone}
            dragId={dragId}
            overId={overId}
            setDragId={setDragId}
            setOverId={setOverId}
            onDrop={handleDrop}
            onStatusChange={handleStatusChange}
            onNote={handleTaskNote}
            onDeleteTask={handleDeleteTask}
            canDeleteTasks={isShopManager}
            onOpenDrawer={setDrawerRoId}
          />
        ) : viewingWorker ? (
          <>
            {activeWorkerGroups.length === 0 && doneWorkerGroups.length === 0 && (
              <p className="text-sm text-gray-400 dark:text-zinc-600 py-6 text-center">No tasks for this worker.</p>
            )}

            <div className="space-y-2">
              {activeWorkerGroups.map(group => (
                <WorkerROCard
                  key={group.id}
                  ro={group.ro}
                  tasks={group.tasks}
                  isManager={isManager}
                  canDeleteTasks={isShopManager}
                  dragId={dragId}
                  overId={overId}
                  setDragId={setDragId}
                  setOverId={setOverId}
                  onDrop={handleDrop}
                  onStatusChange={handleStatusChange}
                  onNote={handleTaskNote}
                  onDeleteTask={handleDeleteTask}
                  pendingPromotion={pendingPromotion}
                  onConfirmPromotion={handlePromotion}
                  onDismissPromotion={handleDismissPromotion}
                  onOpenDrawer={setDrawerRoId}
                />
              ))}
            </div>

            {doneWorkerGroups.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowDone(v => !v)}
                  className="flex items-center gap-2 text-sm text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 font-medium mb-2"
                >
                  <span className={`transition-transform ${showDone ? 'rotate-90' : ''}`}>›</span>
                  Completed ({doneWorkerGroups.reduce((s, g) => s + g.tasks.length, 0)})
                </button>
                {showDone && (
                  <div className="space-y-2">
                    {doneWorkerGroups.map(group => (
                      <WorkerROCard
                        key={group.id}
                        ro={group.ro}
                        tasks={group.tasks}
                        isManager={isManager}
                        canDeleteTasks={isShopManager}
                        dragId={null}
                        overId={null}
                        setDragId={() => {}}
                        setOverId={() => {}}
                        onDrop={() => {}}
                        onStatusChange={handleStatusChange}
                        onNote={handleTaskNote}
                        onDeleteTask={handleDeleteTask}
                        pendingPromotion={pendingPromotion}
                        onConfirmPromotion={handlePromotion}
                        onDismissPromotion={handleDismissPromotion}
                        draggable={false}
                        onOpenDrawer={setDrawerRoId}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {activeTasks.length === 0 && doneTasks.length === 0 && (
              <p className="text-sm text-gray-400 dark:text-zinc-600 py-6 text-center">No tasks assigned to you yet.</p>
            )}

            <div className="space-y-2">
              {activeTaskGroups.map(group => (
                <DailyTaskGroupCard
                  key={group.id}
                  group={group}
                  isManager={isManager}
                  dragId={dragId}
                  overId={overId}
                  setDragId={setDragId}
                  setOverId={setOverId}
                  onDrop={handleDrop}
                  onStatusChange={handleStatusChange}
                  onNote={handleTaskNote}
                  onDeleteTask={handleDeleteTask}
                  canDeleteTasks={isShopManager}
                  pendingPromotion={pendingPromotion}
                  onConfirmPromotion={handlePromotion}
                  onDismissPromotion={handleDismissPromotion}
                  onOpenDrawer={setDrawerRoId}
                />
              ))}
            </div>

            {doneTasks.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowDone(v => !v)}
                  className="flex items-center gap-2 text-sm text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 font-medium mb-2"
                >
                  <span className={`transition-transform ${showDone ? 'rotate-90' : ''}`}>›</span>
                  Completed ({doneTasks.length})
                </button>
                {showDone && (
                  <div className="space-y-2">
                    {doneTaskGroups.map(group => (
                      <DailyTaskGroupCard
                        key={group.id}
                        group={group}
                        isManager={isManager}
                        dragId={null}
                        overId={null}
                        setDragId={() => {}}
                        setOverId={() => {}}
                        onDrop={() => {}}
                        onStatusChange={handleStatusChange}
                        onNote={handleTaskNote}
                        onDeleteTask={handleDeleteTask}
                        canDeleteTasks={isShopManager}
                        draggable={false}
                        onOpenDrawer={setDrawerRoId}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
