// ─── RODrawer ─────────────────────────────────────────────────────────────────
// Right-side slide-in panel showing Notes + Tasks for a selected RO.
// Triggered by clicking a kanban card or list row.

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  doc, updateDoc, addDoc, collection, onSnapshot,
  query, where, orderBy, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { StatusBadge, PartsStatusBadge } from './StatusBadge'
import { MANAGER_ROLES, PARTS_STATUSES } from '../constants/roles'
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

// ── Note deduplication ────────────────────────────────────────────────────────
// Strip timestamp prefix [MM/dd HH:mm - Name] and normalize body for comparison.
function noteBody(line = '') {
  return line
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function toNoteLines(notes) {
  if (Array.isArray(notes)) {
    return notes
      .map(item => {
        if (typeof item === 'string') return item
        const stamp = item.at ? format(new Date(item.at), 'MM/dd HH:mm') : ''
        const author = item.by ? ` - ${item.by}` : ''
        const prefix = stamp ? `[${stamp}${author}] ` : ''
        return `${prefix}${item.text ?? ''}`.trim()
      })
      .filter(Boolean)
      .reverse()
  }
  return (notes ?? '').split('\n').filter(Boolean)
}

function collapseDuplicateNoteLines(lines) {
  const groups = []
  const indexByBody = new Map()
  lines.forEach(line => {
    const body = noteBody(line)
    if (!body) return
    if (indexByBody.has(body)) {
      groups[indexByBody.get(body)].lines.push(line)
      return
    }
    indexByBody.set(body, groups.length)
    groups.push({ line, lines: [line] })
  })
  return groups
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function RODrawer({ ro, employees, onClose }) {
  const { role, user } = useAuth()
  const isManager = MANAGER_ROLES.includes(role)

  const [tab,          setTab]          = useState('notes')
  const [tasks,        setTasks]        = useState([])
  const [note,         setNote]         = useState('')
  const [savingNote,   setSavingNote]   = useState(false)
  const [showAllNotes, setShowAllNotes] = useState(false)
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [taskTo,       setTaskTo]       = useState('')
  const [taskTitle,    setTaskTitle]    = useState('')
  const [taskPriority, setTaskPriority] = useState('medium')
  const [savingTask,   setSavingTask]   = useState(false)

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
    await updateDoc(doc(db, 'ros', ro.id), {
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
      await addDoc(collection(db, 'tasks'), {
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
    await updateDoc(doc(db, 'tasks', taskId), {
      status:      next,
      completedAt: next === 'completed' ? serverTimestamp() : null,
      updatedAt:   serverTimestamp(),
    })
  }

  if (!ro) return null

  const noteLines    = toNoteLines(ro.notes)
  const noteGroups   = collapseDuplicateNoteLines(noteLines)
  const hiddenDupes  = noteGroups.reduce((sum, item) => sum + Math.max(0, item.lines.length - 1), 0)
  const openTasks    = tasks.filter(t => t.status !== 'completed').length
  const empOptions   = Object.entries(employees)

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
            { key: 'notes', label: 'Notes',  badge: noteGroups.length },
            { key: 'tasks', label: 'Tasks',  badge: openTasks },
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
              </form>

              {noteGroups.length > 0 ? (() => {
                const visible  = showAllNotes
                  ? noteGroups.flatMap(item => item.lines.map(line => ({ line, count: 1 })))
                  : noteGroups
                return (
                  <div className="space-y-2">
                    {visible.map(({ line, lines }, i) => (
                      <div
                        key={i}
                        className="px-3 py-2.5 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50"
                      >
                        <p className="text-xs text-gray-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
                          {line}
                        </p>
                        {!showAllNotes && lines?.length > 1 && (
                          <p className="text-[11px] text-gray-400 dark:text-zinc-500 mt-1">
                            {lines.length - 1} similar note{lines.length > 2 ? 's' : ''} hidden
                          </p>
                        )}
                      </div>
                    ))}
                    {hiddenDupes > 0 && (
                      <button
                        onClick={() => setShowAllNotes(v => !v)}
                        className="w-full text-xs text-gray-400 dark:text-zinc-600 hover:text-blue-600 dark:hover:text-blue-400 py-1.5 text-center transition-colors"
                      >
                        {showAllNotes
                          ? `↑ Collapse ${hiddenDupes} duplicate note${hiddenDupes !== 1 ? 's' : ''}`
                          : `↓ Show ${hiddenDupes} duplicate note${hiddenDupes !== 1 ? 's' : ''}`}
                      </button>
                    )}
                  </div>
                )
              })() : (
                <p className="text-xs text-gray-400 dark:text-zinc-600 italic text-center py-8">
                  No notes yet
                </p>
              )}
            </>
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
