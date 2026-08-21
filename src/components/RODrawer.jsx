// ─── RODrawer ─────────────────────────────────────────────────────────────────
// Right-side slide-in panel showing Notes + Tasks for a selected RO.
// Triggered by clicking a kanban card or list row.

import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  doc, collection, onSnapshot,
  query, where, orderBy, getDocs, deleteField, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { updateRoDoc } from '../utils/roMutations'
import { createTaskDoc, deleteTaskDoc, normalizeTaskRevision, updateTaskDoc } from '../utils/taskMutations'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'
import { StatusBadge, PartsStatusBadge } from './StatusBadge'
import AttachmentGallery from './AttachmentGallery'
import { EDIT_RO_ROLES, MANAGER_ROLES, PARTS_STATUSES } from '../constants/roles'
import DailyNotesLog, { parseNoteLines } from './DailyNotesLog'
import { buildUndoNoteUpdate } from '../utils/noteUndo'
import { summarizeDayNotes, getApiKey } from '../hooks/useAI'
import { format } from 'date-fns'

// ── Icons ─────────────────────────────────────────────────────────────────────
function IconX()    { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg> }
function IconPlus() { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" d="M12 4v16m8-8H4"/></svg> }
function IconArrow(){ return <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M5 12h14M12 5l7 7-7 7"/></svg> }

// ── Priority dot ──────────────────────────────────────────────────────────────
const PRIORITY_DOT = { low: 'bg-gray-400', medium: 'bg-amber-400', high: 'bg-red-500' }
const TASK_STATUS  = {
  pending:     'bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400',
  in_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  completed:   'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
}

function AttachedPhotosPanel({ attachments = [], roNumber }) {
  const photos = attachments.filter(att => att?.url)

  if (!photos.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-gray-500 dark:text-zinc-400">No attached photos yet.</p>
      </div>
    )
  }

  return <AttachmentGallery attachments={photos} roNumber={roNumber} columns="grid-cols-2" />
}


// ── Main ─────────────────────────────────────────────────────────────────────
export default function RODrawer({ ro, employees, onClose }) {
  const { role, user } = useAuth()
  const toast = useToast()
  const isManager = MANAGER_ROLES.includes(role)
  const isShopManager = role === 'shop_manager'
  const canUndoNotes = EDIT_RO_ROLES.includes(role) || role === 'parts_manager'

  const [tab,          setTab]          = useState('notes')
  const [tasks,        setTasks]        = useState([])
  const [note,         setNote]         = useState('')
  const [savingNote,   setSavingNote]   = useState(false)
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [taskTo,       setTaskTo]       = useState('')
  const [taskTitle,    setTaskTitle]    = useState('')
  const [taskPriority, setTaskPriority] = useState('medium')
  const [savingTask,   setSavingTask]   = useState(false)
  const [maintenanceBusy, setMaintenanceBusy] = useState('')
  const [showMaintenance, setShowMaintenance] = useState(false)
  const [refreshingNotes, setRefreshingNotes] = useState(false)
  const autoSummaryRuns = useRef(new Set())

  // Load tasks for this RO
  useEffect(() => {
    if (!ro?.id) return
    const q = query(
      collection(db, 'tasks'),
      where('roId', '==', ro.id),
      orderBy('createdAt', 'desc'),
    )
    return onSnapshot(q, snap =>
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
  }, [ro?.id])

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const addNote = async (e) => {
    e.preventDefault()
    if (!note.trim()) return
    setSavingNote(true)
    const prev   = ro.notes ?? ''
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees[user.uid] ?? user.email
    await updateRoDoc(doc(db, 'ros', ro.id), {
      notes:     `[${stamp} - ${author}] ${note.trim()}\n${prev}`,
      updatedAt: serverTimestamp(),
    })
    setNote('')
    setSavingNote(false)
  }

  const addTask = async (e) => {
    e.preventDefault()
    if (!taskTo || !taskTitle.trim()) return
    setSavingTask(true)
    try {
      await createTaskDoc(collection(db, 'tasks'), {
        roId:        ro.id,
        roNumber:    ro.roNumber,
        vehicleInfo: ro.vehicle,
        assignedTo:  taskTo,
        assignedToName: employees[taskTo] ?? '',
        assignedBy:  user.uid,
        title:       taskTitle.trim(),
        priority:    taskPriority,
        status:      'pending',
        createdAt:   serverTimestamp(),
      })
      setTaskTitle(''); setTaskTo(''); setTaskPriority('medium')
      setShowTaskForm(false)
    } finally {
      setSavingTask(false)
    }
  }

  const updateTaskStatus = async (taskId, current) => {
    const next = current === 'pending' ? 'in_progress' : 'completed'
    await updateTaskDoc(doc(db, 'tasks', taskId), {
      status:      next,
      completedAt: next === 'completed' ? serverTimestamp() : null,
      updatedAt:   serverTimestamp(),
    })
  }

  const deleteTask = async (task) => {
    if (!isShopManager) return
    const ok = window.confirm(`Delete task "${task.title || 'Untitled task'}"? This cannot be undone.`)
    if (!ok) return
    await deleteTaskDoc(doc(db, 'tasks', task.id), user.uid, normalizeTaskRevision(task.taskRevision))
  }

  const clearNotes = async () => {
    if (!isShopManager) return
    const ok = window.confirm(`Clear all notes for RO #${ro.roNumber}? Status and tasks will stay unchanged.`)
    if (!ok) return
    setMaintenanceBusy('notes')
    try {
      await updateRoDoc(doc(db, 'ros', ro.id), {
        notes: '',
        noteSummaries: [],
        updatedAt: serverTimestamp(),
      })
    } finally {
      setMaintenanceBusy('')
    }
  }

  const resetWorkflow = async () => {
    if (!isShopManager) return
    const ok = window.confirm(
      `Reset RO #${ro.roNumber} workflow?\n\nThis keeps vehicle/customer/CCC info, but clears notes, workflow status, assignments, parts tracking, and deletes all tasks for this RO. This cannot be undone.`
    )
    if (!ok) return
    setMaintenanceBusy('reset')
    try {
      const taskSnap = await getDocs(query(collection(db, 'tasks'), where('roId', '==', ro.id)))
      await Promise.all(taskSnap.docs.map(taskDoc => deleteTaskDoc(
        doc(db, 'tasks', taskDoc.id),
        user.uid,
        normalizeTaskRevision(taskDoc.data().taskRevision),
      )))
      await updateRoDoc(doc(db, 'ros', ro.id), {
        status: deleteField(),
        carStatus: deleteField(),
        partsStatus: deleteField(),
        dropOffDate: deleteField(),
        eta: deleteField(),
        cccDateOut: deleteField(),
        promisedDate: deleteField(),
        dateOut: deleteField(),
        assignedBodyMan: deleteField(),
        assignedPainter: deleteField(),
        assignedPartsManager: deleteField(),
        notes: '',
        noteSummaries: [],
        changeLog: [],
        partsOrders: [],
        partsReturns: [],
        customerAuthorized: deleteField(),
        partsSubtasks: deleteField(),
        workerFlags: deleteField(),
        partsDelay: deleteField(),
        updatedAt: serverTimestamp(),
        maintenanceResetBy: user.uid,
        maintenanceResetAt: serverTimestamp(),
      })
    } finally {
      setMaintenanceBusy('')
    }
  }

  const undoNoteLine = async (line) => {
    if (!canUndoNotes) return
    const ok = window.confirm(`Undo this RO note?\n\nThe note will be removed. If a matching status change can be safely identified, it will be rolled back too.`)
    if (!ok) return
    setMaintenanceBusy('undo')
    try {
      const { updates } = buildUndoNoteUpdate(ro, line)
      await updateRoDoc(doc(db, 'ros', ro.id), updates)
    } finally {
      setMaintenanceBusy('')
    }
  }

  const refreshNoteSummaries = async ({ overwriteExisting = true, showAlert = true } = {}) => {
    if (!ro?.id || refreshingNotes) return
    const todayMmdd = format(new Date(), 'MM/dd')
    const todayYear = new Date().getFullYear()
    const existing = Array.isArray(ro.noteSummaries) ? ro.noteSummaries : []
    const existingDates = new Set(existing.map(s => s.date))
    const groups = new Map()

    for (const line of parseNoteLines(ro.notes ?? '')) {
      const m = line.match(/^\[(\d{2}\/\d{2})/)
      if (!m || m[1] === todayMmdd) continue
      const [mm, dd] = m[1].split('/')
      const candidate = new Date(todayYear, parseInt(mm, 10) - 1, parseInt(dd, 10))
      const year = candidate > new Date(Date.now() + 86400000) ? todayYear - 1 : todayYear
      const isoDate = `${year}-${mm}-${dd}`
      if (!overwriteExisting && existingDates.has(isoDate)) continue
      if (!groups.has(m[1])) groups.set(m[1], { isoDate, lines: [] })
      groups.get(m[1]).lines.push(line)
    }

    if (!groups.size) return

    try {
      setRefreshingNotes(true)
      const apiKey = await getApiKey().catch(() => null)
      if (!apiKey) {
        if (showAlert) window.alert('AI summary refresh is not configured on this device.')
        return
      }

      const nextSummaries = overwriteExisting ? [] : [...existing]
      for (const [mmdd, { isoDate, lines }] of groups.entries()) {
        const result = await summarizeDayNotes({
          vehicle: ro.vehicle ?? `RO${ro.roNumber}`,
          dateLabel: mmdd,
          noteLines: lines,
        })
        nextSummaries.push({
          date: isoDate,
          bullets: result.bullets,
          generatedAt: new Date().toISOString(),
        })
      }

      await updateRoDoc(doc(db, 'ros', ro.id), {
        noteSummaries: nextSummaries,
        updatedAt: serverTimestamp(),
      })
      toast.success('Note summaries updated')
    } catch (err) {
      if (err.message === 'NO_API_KEY') {
        toast.error('AI key not configured — go to Settings to add your Anthropic key')
      } else {
        toast.error('Summary failed: ' + err.message)
      }
    } finally {
      setRefreshingNotes(false)
    }
  }

  useEffect(() => {
    if (!ro?.id || tab !== 'notes') return
    const todayMmdd = format(new Date(), 'MM/dd')
    const runKey = `${ro.id}:${todayMmdd}`
    if (autoSummaryRuns.current.has(runKey)) return
    autoSummaryRuns.current.add(runKey)
    refreshNoteSummaries({ overwriteExisting: false, showAlert: false })
  }, [ro?.id, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ro) return null

  const noteCount = (ro.notes ?? '').split('\n').filter(l => /^\[[^\]]+\]/.test(l)).length
  const openTasks = tasks.filter(t => t.status !== 'completed').length
  const empOptions   = Object.entries(employees)
  const attachedPhotos = Array.isArray(ro.attachments) ? ro.attachments.filter(att => att?.url) : []

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 dark:bg-black/50"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div className="fixed right-0 top-14 h-[calc(100vh-56px)] w-full sm:w-[420px] z-50 bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-zinc-800 shadow-2xl flex flex-col animate-slide-in">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-zinc-800">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="text-lg font-black font-mono text-blue-700 dark:text-blue-400">
                #{ro.roNumber}
              </span>
              <StatusBadge status={ro.status} />
              {ro.hasRental === true && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 font-medium">
                  Rental
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{ro.vehicle}</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 truncate">{ro.customerName}</p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Link
              to={`/ro/${ro.id}`}
              onClick={onClose}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-gray-600 dark:text-zinc-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors font-medium"
            >
              Details <IconArrow />
            </Link>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <IconX />
            </button>
          </div>
        </div>

        {/* ── Parts status quick-strip ──────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-zinc-800/40 border-b border-gray-100 dark:border-zinc-800">
          <span className="text-xs text-gray-400 dark:text-zinc-500">Parts</span>
          <PartsStatusBadge status={ro.partsStatus} />
          {ro.insuranceCompany && (
            <span className="text-xs text-gray-400 dark:text-zinc-500 ml-auto truncate">{ro.insuranceCompany}</span>
          )}
        </div>

        {/* ── Tab bar ───────────────────────────────────────────────────── */}
        <div className="flex border-b border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          {[
            { key: 'notes', label: 'Notes',  badge: noteCount },
            { key: 'photos', label: 'Attached Photos',  badge: attachedPhotos.length },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors
                ${tab === t.key
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {t.label}
              {t.badge > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 font-medium leading-none">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {/* Notes tab */}
          {tab === 'notes' && (
            <>
              <form onSubmit={addNote} className="flex gap-2">
                <input
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Add a note…"
                  className="flex-1 border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={savingNote || !note.trim()}
                  className="px-3 py-2 bg-gray-900 dark:bg-gray-100 hover:bg-gray-700 dark:hover:bg-gray-300 disabled:opacity-40 text-white dark:text-gray-900 text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
                >
                  Add
                </button>
                {isShopManager && (
                  <button
                    type="button"
                    onClick={() => setShowMaintenance(v => !v)}
                    title={showMaintenance ? 'Hide manager tools' : 'Show manager tools'}
                    aria-label={showMaintenance ? 'Hide manager tools' : 'Show manager tools'}
                    className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                      showMaintenance
                        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
                        : 'border-gray-300 bg-white text-gray-400 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500 dark:hover:border-amber-800 dark:hover:text-amber-300'
                    }`}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.3 4.3l.6-1.3h2.2l.6 1.3 1.5.6 1.3-.5 1.6 1.6-.5 1.3.6 1.5 1.3.6v2.2l-1.3.6-.6 1.5.5 1.3-1.6 1.6-1.3-.5-1.5.6-.6 1.3h-2.2l-.6-1.3-1.5-.6-1.3.5-1.6-1.6.5-1.3-.6-1.5-1.3-.6V9.4l1.3-.6.6-1.5-.5-1.3 1.6-1.6 1.3.5 1.5-.6z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9a3 3 0 100 6 3 3 0 000-6z" />
                    </svg>
                  </button>
                )}
              </form>

              <DailyNotesLog
                noteString={ro.notes ?? ''}
                noteSummaries={ro.noteSummaries}
                summarizingDates={null}
                canUndo={canUndoNotes && !maintenanceBusy}
                onUndoLine={undoNoteLine}
                canRefresh={!maintenanceBusy}
                onRefresh={() => refreshNoteSummaries({ overwriteExisting: true, showAlert: true })}
                refreshBusy={refreshingNotes}
              />

              {isShopManager && showMaintenance && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Manager maintenance
                  </p>
                  <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/70">
                    Cleanup tools for test data. Reset keeps core RO details and removes workflow data.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={clearNotes}
                      disabled={Boolean(maintenanceBusy)}
                      className="rounded-lg border border-amber-300 px-2.5 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/50"
                    >
                      {maintenanceBusy === 'notes' ? 'Clearing...' : 'Clear notes'}
                    </button>
                    <button
                      type="button"
                      onClick={resetWorkflow}
                      disabled={Boolean(maintenanceBusy)}
                      className="rounded-lg border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/70 dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      {maintenanceBusy === 'reset' ? 'Resetting...' : 'Reset RO workflow'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Attached photos tab */}
          {tab === 'photos' && (
            <AttachedPhotosPanel attachments={attachedPhotos} roNumber={ro.roNumber} />
          )}

          {/* Tasks tab */}
          {tab === 'tasks' && (
            <>
              {/* Existing tasks */}
              {tasks.map(task => (
                <div
                  key={task.id}
                  className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50"
                >
                  <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${PRIORITY_DOT[task.priority] ?? 'bg-gray-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TASK_STATUS[task.status] ?? ''}`}>
                        {task.status?.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{task.title}</p>
                    <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">
                      → {employees[task.assignedTo] ?? task.assignedTo ?? '?'}
                    </p>
                  </div>
                  {task.status !== 'completed' && (task.assignedTo === user.uid || isManager) && (
                    <button
                      onClick={() => updateTaskStatus(task.id, task.status)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0 mt-1 whitespace-nowrap"
                    >
                      {task.status === 'pending' ? 'Start' : 'Done ✓'}
                    </button>
                  )}
                  {isShopManager && (
                    <button
                      onClick={() => deleteTask(task)}
                      className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:underline shrink-0 mt-1 whitespace-nowrap"
                    >
                      Delete
                    </button>
                  )}
                </div>
              ))}

              {tasks.length === 0 && !showTaskForm && (
                <p className="text-xs text-gray-400 dark:text-zinc-600 italic text-center py-8">No tasks yet</p>
              )}

              {/* Add task form (managers only) */}
              {isManager && (
                showTaskForm ? (
                  <form
                    onSubmit={addTask}
                    className="border border-blue-200 dark:border-blue-900 rounded-xl p-3 bg-blue-50 dark:bg-blue-950/30 space-y-2.5 mt-1"
                  >
                    <select
                      required
                      value={taskTo}
                      onChange={e => setTaskTo(e.target.value)}
                      className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Assign to…</option>
                      {empOptions.map(([uid, name]) => (
                        <option key={uid} value={uid}>{name}</option>
                      ))}
                    </select>

                    <input
                      required
                      value={taskTitle}
                      onChange={e => setTaskTitle(e.target.value)}
                      placeholder="Task description"
                      className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />

                    <div className="flex items-center gap-2">
                      <select
                        value={taskPriority}
                        onChange={e => setTaskPriority(e.target.value)}
                        className="border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200"
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                      <button
                        type="submit"
                        disabled={savingTask}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm py-1.5 rounded-lg transition-colors"
                      >
                        {savingTask ? 'Saving…' : 'Add Task'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowTaskForm(false); setTaskTitle(''); setTaskTo('') }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      >
                        <IconX />
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowTaskForm(true)}
                    className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium mt-1"
                  >
                    <IconPlus /> Assign Task
                  </button>
                )
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
