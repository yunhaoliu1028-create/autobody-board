import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  doc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, getDocs, deleteField, serverTimestamp,
  query, where, orderBy, arrayUnion,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { summarizeDayNotes, getApiKey } from '../hooks/useAI'
import { StatusBadge, PartsStatusBadge, CCCFieldLabel } from '../components/StatusBadge'
import HighlightedNote from '../components/HighlightedNote'
import DailyNotesLog, { parseNoteLines } from '../components/DailyNotesLog'
import { buildUndoNoteUpdate } from '../utils/noteUndo'
import { compressImageFile } from '../utils/imageCompression'
import {
  RO_STATUSES, PARTS_STATUSES, MANAGER_ROLES, EDIT_RO_ROLES,
} from '../constants/roles'
import { format, parseISO, isValid, differenceInDays } from 'date-fns'

// ── Note dedup helper (same as RODrawer) ──────────────────────────────────────
function noteBody(line) {
  return line.replace(/^\[[\d/: -]+\]\s*/, '').trim().toLowerCase()
}
function dedupeNoteLines(lines) {
  const seen = new Map()
  return lines.map((line, i) => {
    const body = noteBody(line)
    if (seen.has(body)) return { line, dup: true }
    seen.set(body, i)
    return { line, dup: false }
  })
}

// ── Change log action label ────────────────────────────────────────────────────
const CHANGE_LABELS = {
  update_status:       'Status',
  update_parts_status: 'Parts',
  update_car_status:   'Car Status',
  update_dropoff_date: 'Drop-Off',
  update_due_date:     'Due Date',
  update_rental:       'Rental',
}

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return '—'
  try { const d = parseISO(s); return isValid(d) ? format(d, 'M/d/yyyy') : s }
  catch { return s }
}

function dueDateClass(dateStr) {
  if (!dateStr) return ''
  try {
    const days = differenceInDays(parseISO(dateStr), new Date())
    if (days < 0)  return 'text-red-500 dark:text-red-400 font-semibold'
    if (days <= 2) return 'text-amber-500 dark:text-amber-400 font-medium'
    return 'text-gray-700 dark:text-gray-300'
  } catch { return '' }
}

// ── Tiny field display ────────────────────────────────────────────────────────
function Field({ label, value, mono = false, className = '' }) {
  return (
    <div className={className}>
      <p className="text-xs text-gray-400 dark:text-zinc-500 mb-0.5">{label}</p>
      <p className={`text-sm font-medium text-gray-800 dark:text-gray-200 ${mono ? 'font-mono' : ''}`}>
        {value || '—'}
      </p>
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ title, children, className = '' }) {
  return (
    <div className={`bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5 ${className}`}>
      {title && (
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-zinc-500 mb-4">
          {title}
        </h3>
      )}
      {children}
    </div>
  )
}

// ── Task list ─────────────────────────────────────────────────────────────────
function TaskList({ roId, employees }) {
  const { role, user } = useAuth()
  const isManager = MANAGER_ROLES.includes(role)
  const isShopManager = role === 'shop_manager'
  const [tasks,    setTasks]    = useState([])
  const [showForm, setShowForm] = useState(false)
  const [assignTo, setAssignTo] = useState('')
  const [title,    setTitle]    = useState('')
  const [desc,     setDesc]     = useState('')
  const [priority, setPriority] = useState('medium')
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    const q = query(
      collection(db, 'tasks'),
      where('roId', '==', roId),
      orderBy('createdAt', 'desc'),
    )
    return onSnapshot(q, snap => {
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [roId])

  const handleAddTask = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await addDoc(collection(db, 'tasks'), {
        roId,
        assignedTo:  assignTo,
        assignedToName: employees[assignTo] ?? '',
        assignedBy:  user.uid,
        title,
        description: desc,
        priority,
        status:      'pending',
        createdAt:   serverTimestamp(),
      })
      setTitle(''); setDesc(''); setAssignTo(''); setPriority('medium')
      setShowForm(false)
    } finally {
      setSaving(false)
    }
  }

  const updateTaskStatus = async (taskId, newStatus) => {
    await updateDoc(doc(db, 'tasks', taskId), {
      status:      newStatus,
      completedAt: newStatus === 'completed' ? serverTimestamp() : null,
      updatedAt:   serverTimestamp(),
    })
  }

  const deleteTask = async (task) => {
    if (!isShopManager) return
    const ok = window.confirm(`Delete task "${task.title || 'Untitled task'}"? This cannot be undone.`)
    if (!ok) return
    await deleteDoc(doc(db, 'tasks', task.id))
  }

  const priorityDot = { low: 'bg-gray-400', medium: 'bg-amber-400', high: 'bg-red-500' }
  const statusStyle = {
    pending:     'bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400',
    in_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    completed:   'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    cancelled:   'bg-red-50 text-red-400 dark:bg-red-950/30 dark:text-red-500 line-through',
  }
  const employeeOptions = Object.entries(employees)

  return (
    <div className="space-y-2.5">
      {tasks.length === 0 && !showForm && (
        <p className="text-sm text-gray-400 dark:text-zinc-600 italic">No tasks for this RO.</p>
      )}
      {tasks.map(task => (
        <div key={task.id}
          className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700/50"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`w-2 h-2 rounded-full shrink-0 ${priorityDot[task.priority] ?? 'bg-gray-400'}`} />
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyle[task.status] ?? ''}`}>
                {task.status?.replace('_', ' ')}
              </span>
              <span className="text-xs text-gray-400 dark:text-zinc-500 capitalize">{task.priority}</span>
            </div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 mt-1">{task.title}</p>
            {task.description && (
              <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5">{task.description}</p>
            )}
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-1">
              → {(employees[task.assignedTo] ?? task.assignedTo) || 'Unassigned'}
            </p>
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            {isShopManager && (
              <button
                onClick={() => deleteTask(task)}
                className="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:underline whitespace-nowrap"
              >
                Delete
              </button>
            )}
            {task.status !== 'completed' && (task.assignedTo === user.uid || isManager) && (
              <>
                {task.status === 'pending' && (
                  <button
                    onClick={() => updateTaskStatus(task.id, 'in_progress')}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                  >Start</button>
                )}
                {task.status === 'in_progress' && (
                  <button
                    onClick={() => updateTaskStatus(task.id, 'completed')}
                    className="text-xs text-green-600 dark:text-green-400 hover:underline whitespace-nowrap"
                  >Done ✓</button>
                )}
              </>
            )}
          </div>
        </div>
      ))}

      {isManager && (
        showForm ? (
          <form onSubmit={handleAddTask}
            className="border border-blue-200 dark:border-blue-900 rounded-xl p-4 bg-blue-50 dark:bg-blue-950/30 space-y-3 mt-2"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Assign To *</label>
                <select
                  required value={assignTo} onChange={e => setAssignTo(e.target.value)}
                  className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200"
                >
                  <option value="">Select employee…</option>
                  {employeeOptions.map(([uid, name]) => (
                    <option key={uid} value={uid}>{name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Priority</label>
                <select
                  value={priority} onChange={e => setPriority(e.target.value)}
                  className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Task Title *</label>
              <input
                required value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Repair rear quarter panel"
                className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Notes (optional)</label>
              <textarea
                value={desc} onChange={e => setDesc(e.target.value)} rows={2}
                className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit" disabled={saving}
                className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Add Task'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-gray-200"
              >Cancel</button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium mt-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M12 4v16m8-8H4" />
            </svg>
            Assign Task
          </button>
        )
      )}
    </div>
  )
}

// parseNoteLines and DailyNotesLog imported from src/components/DailyNotesLog.jsx

// ── Attachments gallery ───────────────────────────────────────────────────────
function ManagerMaintenance({ ro }) {
  const { role, user } = useAuth()
  const [busy, setBusy] = useState('')
  if (role !== 'shop_manager') return null

  const clearNotes = async () => {
    const ok = window.confirm(`Clear all notes for RO #${ro.roNumber}? Status and tasks will stay unchanged.`)
    if (!ok) return
    setBusy('notes')
    try {
      await updateDoc(doc(db, 'ros', ro.id), {
        notes: '',
        noteSummaries: [],
        updatedAt: serverTimestamp(),
      })
    } finally {
      setBusy('')
    }
  }

  const resetWorkflow = async () => {
    const ok = window.confirm(
      `Reset RO #${ro.roNumber} workflow?\n\nThis keeps vehicle/customer/CCC info, but clears notes, workflow status, assignments, parts tracking, and deletes all tasks for this RO. This cannot be undone.`
    )
    if (!ok) return
    setBusy('reset')
    try {
      const taskSnap = await getDocs(query(collection(db, 'tasks'), where('roId', '==', ro.id)))
      await Promise.all(taskSnap.docs.map(taskDoc => deleteDoc(doc(db, 'tasks', taskDoc.id))))
      await updateDoc(doc(db, 'ros', ro.id), {
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
      setBusy('')
    }
  }

  return (
    <Section title="Manager Maintenance">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Cleanup tools</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-zinc-500">
            Shop manager only. Use these for test data cleanup or resetting a workflow.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={clearNotes}
            disabled={Boolean(busy)}
            className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-amber-900/70 dark:text-amber-300 dark:hover:bg-amber-950/30"
          >
            {busy === 'notes' ? 'Clearing...' : 'Clear notes'}
          </button>
          <button
            onClick={resetWorkflow}
            disabled={Boolean(busy)}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/70 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            {busy === 'reset' ? 'Resetting...' : 'Reset RO workflow'}
          </button>
        </div>
      </div>
    </Section>
  )
}

function AttachmentsSection({ roId, roNumber, attachments = [] }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState('')
  const [previewIndex, setPreviewIndex] = useState(null)
  const fileInputRef = useRef(null)

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true); setError('')
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        const blob = await compressImageFile(file)
        const filename = `${Date.now()}_${file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}.jpg`
        const sRef = storageRef(storage, `ros/${roId}/attachments/${filename}`)
        await uploadBytes(sRef, blob || file, { contentType: 'image/jpeg' })
        const url = await getDownloadURL(sRef)
        await updateDoc(doc(db, 'ros', roId), {
          attachments: arrayUnion({ url, name: filename, label: file.name.replace(/\.[^.]+$/, ''), uploadedAt: new Date().toISOString() }),
          updatedAt: serverTimestamp(),
        })
      }
    } catch (err) {
      console.error('[Attachments] Upload failed:', err)
      setError('Upload failed. Check storage permissions.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const allSelected = attachments.length > 0 && selected.size === attachments.length
  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(attachments.map((_, i) => i)))
  }
  const toggleOne = (i) => setSelected(prev => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })

  const handleDownload = async () => {
    const targets = attachments.filter((_, i) => selected.has(i))
    if (!targets.length) return
    setDownloading(true)
    for (let i = 0; i < targets.length; i++) {
      const att = targets[i]
      setDownloadProgress(`Downloading ${i + 1}/${targets.length}…`)
      try {
        const resp = await fetch(att.url)
        const blob = await resp.blob()
        const label = att.label || att.name || `photo_${i + 1}`
        const slug = label.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_')
        const filename = `RO${roNumber}_${slug}.jpg`
        const objUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
        if (i < targets.length - 1) await new Promise(r => setTimeout(r, 400))
      } catch {
        const a = document.createElement('a')
        a.href = att.url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }
    }
    setDownloading(false)
    setDownloadProgress('')
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4M8 8l4-4 4 4"/>
          </svg>
          {uploading ? 'Uploading…' : 'Upload Photo'}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} />
        {attachments.length > 0 && (
          <>
            <span className="text-xs text-gray-400 dark:text-zinc-600">{attachments.length} photo{attachments.length !== 1 ? 's' : ''}</span>
            <button
              onClick={toggleSelectAll}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
            {selected.size > 0 && (
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 disabled:opacity-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12M8 12l4 4 4-4"/>
                </svg>
                {downloading ? downloadProgress : `Download ${selected.size} selected`}
              </button>
            )}
          </>
        )}
      </div>

      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      {/* Gallery grid */}
      {attachments.length > 0 ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {attachments.map((att, i) => (
            <div
              key={i}
              className={`relative aspect-square rounded-xl overflow-hidden border transition-colors group cursor-pointer ${
                selected.has(i)
                  ? 'border-blue-500 ring-2 ring-blue-400/40'
                  : 'border-gray-200 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-500'
              }`}
              onClick={() => setPreviewIndex(i)}
            >
              <img
                src={att.url}
                alt={att.label || att.name}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
              />
              {/* Checkbox overlay */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleOne(i)
                }}
                className={`absolute top-1.5 left-1.5 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all ${
                selected.has(i)
                  ? 'bg-blue-500 border-blue-500'
                  : 'bg-black/30 border-white/70 opacity-0 group-hover:opacity-100'
              }`}
                aria-label={selected.has(i) ? 'Deselect photo' : 'Select photo'}
              >
                {selected.has(i) && (
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                )}
              </button>
              {/* Label tooltip */}
              {att.label && (
                <div className="absolute bottom-0 inset-x-0 bg-black/50 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-[10px] text-white truncate">{att.label}</p>
                </div>
              )}
              {/* Open in new tab */}
              <a
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="absolute top-1.5 right-1.5 h-5 w-5 flex items-center justify-center rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Open full size"
              >
                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                </svg>
              </a>
            </div>
          ))}
        </div>
      ) : (
        !uploading && (
          <p className="text-xs text-gray-400 dark:text-zinc-600 italic">
            No photos yet — upload damage photos, supplements, or finished work.
          </p>
        )
      )}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function RODetail() {
  const { id }         = useParams()
  const navigate       = useNavigate()
  const { role, user } = useAuth()
  const isManager      = MANAGER_ROLES.includes(role)
  const canEdit        = EDIT_RO_ROLES.includes(role)

  const [ro,               setRo]               = useState(null)
  const [employees,        setEmployees]        = useState({})
  const [loading,          setLoading]          = useState(true)
  const [updatingStatus,   setUpdatingStatus]   = useState(false)
  const [note,             setNote]             = useState('')
  const [savingNote,       setSavingNote]       = useState(false)
  const [noteSummaries,    setNoteSummaries]    = useState([])
  const [summarizingDates, setSummarizingDates] = useState(new Set())
  const [changeHistOpen,   setChangeHistOpen]   = useState(false)
  const didSummarize = useRef(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().name })
      setEmployees(map)
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'ros', id), snap => {
      if (snap.exists()) setRo({ id: snap.id, ...snap.data() })
      else navigate('/board')
      setLoading(false)
    })
    return unsub
  }, [id, navigate])

  // Seed local noteSummaries from Firestore once when RO first loads
  useEffect(() => {
    if (ro?.noteSummaries) setNoteSummaries(ro.noteSummaries)
  }, [ro?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy daily summarizer — runs once per RO load; finds past days without a summary
  useEffect(() => {
    if (!ro || didSummarize.current) return
    didSummarize.current = true

    const run = async () => {
      const apiKey = await getApiKey().catch(() => null)
      if (!apiKey) return

      const todayMmdd = format(new Date(), 'MM/dd')
      const todayYear = new Date().getFullYear()
      const existing  = ro.noteSummaries ?? []
      const existingDates = new Set(existing.map(s => s.date))

      const lines = parseNoteLines(ro.notes ?? '')
      const map   = new Map()
      for (const line of lines) {
        const m = line.match(/^\[(\d{2}\/\d{2})/)
        const key = m ? m[1] : null
        if (!key) continue
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(line)
      }

      // Collect past days that haven't been summarized yet (newest first, max 5)
      const toProcess = [...map.entries()]
        .filter(([mmdd]) => {
          if (mmdd === todayMmdd) return false
          const [mm, dd] = mmdd.split('/')
          const candidate = new Date(todayYear, parseInt(mm) - 1, parseInt(dd))
          const year = candidate > new Date(Date.now() + 86400000) ? todayYear - 1 : todayYear
          return !existingDates.has(`${year}-${mm}-${dd}`)
        })
        .slice(0, 5)

      if (!toProcess.length) return

      const accumulated = [...existing]
      for (const [mmdd, dayLines] of toProcess) {
        const [mm, dd] = mmdd.split('/')
        const candidate = new Date(todayYear, parseInt(mm) - 1, parseInt(dd))
        const year = candidate > new Date(Date.now() + 86400000) ? todayYear - 1 : todayYear
        const isoDate = `${year}-${mm}-${dd}`

        setSummarizingDates(prev => new Set([...prev, isoDate]))
        try {
          const result = await summarizeDayNotes({
            vehicle:   ro.vehicle ?? `RO${ro.roNumber}`,
            dateLabel: mmdd,
            noteLines: dayLines,
          })
          const entry = { date: isoDate, bullets: result.bullets, generatedAt: new Date().toISOString() }
          accumulated.push(entry)
          setNoteSummaries([...accumulated])
          await updateDoc(doc(db, 'ros', id), { noteSummaries: accumulated })
        } catch { /* silent — raw notes still shown */ } finally {
          setSummarizingDates(prev => { const s = new Set(prev); s.delete(isoDate); return s })
        }
      }
    }

    run()
  }, [ro?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = async (newStatus) => {
    setUpdatingStatus(true)
    await updateDoc(doc(db, 'ros', id), { status: newStatus, updatedAt: serverTimestamp() })
    setUpdatingStatus(false)
  }

  const handlePartsChange = async (v) => {
    await updateDoc(doc(db, 'ros', id), { partsStatus: v, updatedAt: serverTimestamp() })
  }

  const addNote = async (e) => {
    e.preventDefault()
    if (!note.trim()) return
    setSavingNote(true)
    const prev   = ro.notes ?? ''
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees[user.uid] ?? user.email
    await updateDoc(doc(db, 'ros', id), {
      notes:     `[${stamp} - ${author}] ${note.trim()}\n${prev}`,
      updatedAt: serverTimestamp(),
    })
    setNote('')
    setSavingNote(false)
  }

  const undoNoteLine = async (line) => {
    if (!canEdit && role !== 'parts_manager') return
    const ok = window.confirm(`Undo this RO note?\n\nThe note will be removed. If a matching status change can be safely identified, it will be rolled back too.`)
    if (!ok) return
    const { updates } = buildUndoNoteUpdate(ro, line)
    await updateDoc(doc(db, 'ros', id), updates)
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-400 dark:text-zinc-600">Loading…</div>
  )
  if (!ro) return null

  const currentIdx = RO_STATUSES.findIndex(s => s.key === ro.status)
  const dueDate    = ro.eta || ro.cccDateOut || ro.promisedDate

  return (
    <div className="max-w-5xl mx-auto space-y-4">

      {/* ── Breadcrumb + actions ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-zinc-400">
          <Link to="/board" className="hover:text-blue-600 dark:hover:text-blue-400">Board</Link>
          <span>›</span>
          <span className="font-semibold text-gray-900 dark:text-gray-100">RO #{ro.roNumber}</span>
        </div>
        {canEdit && (
          <Link
            to={`/ro/${id}/edit`}
            className="text-sm border border-gray-300 dark:border-zinc-700 hover:border-blue-400 text-gray-600 dark:text-zinc-300 hover:text-blue-600 px-3 py-1.5 rounded-lg transition-colors"
          >
            ✏ Edit RO
          </Link>
        )}
      </div>

      {/* ── Header card ───────────────────────────────────────────────────── */}
      <Section>
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* Left */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <span className="text-3xl font-black font-mono text-blue-700 dark:text-blue-400">#{ro.roNumber}</span>
              <StatusBadge status={ro.status} />
              {ro.hasRental === true && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 font-medium">
                  Rental
                </span>
              )}
            </div>
            <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {ro.vehicle}{ro.vehicleColor ? ` · ${ro.vehicleColor}` : ''}
            </p>
            {ro.vin && (
              <p className="text-xs font-mono text-gray-400 dark:text-zinc-500 mt-0.5 tracking-wider">VIN: {ro.vin}</p>
            )}
            <p className="text-sm text-gray-600 dark:text-zinc-400 mt-2">
              {ro.customerName}
              {ro.customerPhone && <span className="text-gray-400 dark:text-zinc-500"> · {ro.customerPhone}</span>}
            </p>
            {(ro.insuranceCompany || ro.claimNumber) && (
              <p className="text-sm text-gray-400 dark:text-zinc-500 mt-0.5">
                {ro.insuranceCompany}
                {ro.claimNumber && ` · Claim: ${ro.claimNumber}`}
              </p>
            )}
          </div>

          {/* Right — key dates + financials */}
          <div className="text-right space-y-3 shrink-0 min-w-[100px]">
            {dueDate && (
              <div>
                <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mb-0.5">ETA</p>
                <p className={`text-sm font-bold ${dueDateClass(dueDate)}`}>{fmtDate(dueDate)}</p>
              </div>
            )}
            {ro.dropOffDate && (
              <div>
                <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mb-0.5">Drop-Off</p>
                <p className="text-sm font-medium text-gray-700 dark:text-zinc-300">{fmtDate(ro.dropOffDate)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mb-1">Parts</p>
              <PartsStatusBadge status={ro.partsStatus} />
            </div>
            {ro.totalAmount && (
              <div>
                <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mb-0.5">Estimate</p>
                <p className="text-sm font-semibold text-gray-700 dark:text-zinc-300">${Number(ro.totalAmount).toLocaleString()}</p>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* ── Repair Pipeline ───────────────────────────────────────────────── */}
      <Section title="Repair Pipeline">
        <div className="flex flex-wrap gap-1.5">
          {RO_STATUSES.map((s, idx) => {
            const isCurrent = s.key === ro.status
            const isPast    = idx < currentIdx
            const clickable = isManager || canEdit
            return (
              <button
                key={s.key}
                onClick={() => clickable && !updatingStatus && handleStatusChange(s.key)}
                disabled={updatingStatus || !clickable}
                title={s.label}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border
                  ${isCurrent
                    ? 'border-blue-500 bg-blue-600 text-white shadow-sm'
                    : isPast
                    ? 'border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-800/50 text-gray-400 dark:text-zinc-600'
                    : `border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-gray-600 dark:text-zinc-300 ${clickable ? 'hover:border-blue-400 hover:text-blue-600 dark:hover:border-blue-600 dark:hover:text-blue-400' : ''}`}
                  ${!clickable ? 'cursor-default' : 'cursor-pointer'}`}
              >
                {s.label}
              </button>
            )
          })}
        </div>
      </Section>

      {/* ── All Details (consolidated) ────────────────────────────────────── */}
      <Section title="Details">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">

          {/* Customer */}
          <Field label="Customer" value={ro.customerName} />
          <Field label="Phone"    value={ro.customerPhone} />
          {ro.deductible && <Field label="Deductible" value={`$${ro.deductible}`} />}

          {/* Insurance */}
          <Field label="Insurance Company" value={ro.insuranceCompany} className="col-span-1" />
          <Field label="Claim #"           value={ro.claimNumber} />

          <div className="col-span-full border-t border-gray-100 dark:border-zinc-800 my-1" />

          {/* Dates — all four fields */}
          {ro.cccDateIn ? (
            <div>
              <CCCFieldLabel label="CCC Date-In" />
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mt-0.5">{fmtDate(ro.cccDateIn)}</p>
            </div>
          ) : (
            <Field label="Date In" value={fmtDate(ro.dateIn)} />
          )}

          {ro.cccDateOut && (
            <div>
              <CCCFieldLabel label="CCC Date-Out" />
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mt-0.5">{fmtDate(ro.cccDateOut)}</p>
            </div>
          )}

          <Field label="Drop-Off Date" value={fmtDate(ro.dropOffDate)} />

          <div>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mb-0.5">ETA <span className="text-gray-300 dark:text-zinc-600 font-normal">(shop)</span></p>
            <p className={`text-sm font-medium mt-0.5 ${dueDate ? dueDateClass(dueDate) : 'text-gray-400 dark:text-zinc-500'}`}>
              {fmtDate(ro.eta) !== '—' ? fmtDate(ro.eta) : ro.cccDateOut ? fmtDate(ro.cccDateOut) : '—'}
            </p>
          </div>

          <div className="col-span-full border-t border-gray-100 dark:border-zinc-800 my-1" />

          {/* Financials */}
          {ro.laborAmount && <Field label="Labor"  value={`$${ro.laborAmount}`} />}
          {ro.partsAmount && <Field label="Parts"  value={`$${ro.partsAmount}`} />}
          {ro.totalAmount && <Field label="Total"  value={`$${ro.totalAmount}`} />}
          {ro.laborHrs    && <Field label="Labor Hrs"  value={ro.laborHrs} />}
          {ro.paintHrs    && <Field label="Paint Hrs"  value={ro.paintHrs} />}
          {ro.paintCode   && <Field label="Paint Code" value={ro.paintCode} mono />}
          <Field label="Needs Paint" value={ro.needsPaint === false ? 'No' : 'Yes'} />

          <div className="col-span-full border-t border-gray-100 dark:border-zinc-800 my-1" />

          {/* Assignments */}
          <Field label="Estimator" value={ro.estimatorName || employees[ro.assignedEstimator]} />
          <Field label="Body Tech" value={employees[ro.assignedBodyMan]} />
          <Field label="Painter"   value={employees[ro.assignedPainter]} />
          {employees[ro.assignedPartsManager] && (
            <Field label="Parts Mgr" value={employees[ro.assignedPartsManager]} />
          )}

          <div className="col-span-full border-t border-gray-100 dark:border-zinc-800 my-1" />

          {/* Parts status with quick-change */}
          <div className="col-span-full">
            <p className="text-xs text-gray-400 dark:text-zinc-500 mb-1.5">Parts Status</p>
            <div className="flex items-center gap-3 flex-wrap">
              <PartsStatusBadge status={ro.partsStatus} />
              {(isManager || role === 'parts_manager' || role === 'estimator') && (
                <select
                  value={ro.partsStatus ?? 'not_ordered'}
                  onChange={e => handlePartsChange(e.target.value)}
                  className="text-sm border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1 bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {PARTS_STATUSES.map(p => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* ── Tasks ─────────────────────────────────────────────────────────── */}
      <ManagerMaintenance ro={ro} />

      <Section title="Tasks">
        <TaskList roId={id} employees={employees} />
      </Section>

      {/* ── Attachments ───────────────────────────────────────────────────── */}
      <Section title="Photos & Attachments">
        <AttachmentsSection roId={id} roNumber={ro.roNumber} attachments={ro.attachments ?? []} />
      </Section>

      {/* ── Change Log ────────────────────────────────────────────────────── */}
      {(ro.changeLog?.length ?? 0) > 0 && (
        <Section>
          <button
            onClick={() => setChangeHistOpen(v => !v)}
            className="w-full flex items-center justify-between gap-2"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-zinc-500">
              Change History
            </h3>
            <span className="text-xs text-gray-400 dark:text-zinc-600 shrink-0">
              {changeHistOpen ? '▲ collapse' : `▼ ${ro.changeLog.length} entries`}
            </span>
          </button>
          {changeHistOpen && (
            <div className="space-y-1.5 mt-4">
              {[...(ro.changeLog ?? [])].reverse().map((entry, i) => (
                <div key={i} className="flex items-center gap-3 text-xs text-gray-600 dark:text-zinc-400">
                  <span className="text-gray-300 dark:text-zinc-700 shrink-0">
                    {entry.at ? format(parseISO(entry.at), 'M/d HH:mm') : '—'}
                  </span>
                  <span className="font-medium text-gray-500 dark:text-zinc-500 shrink-0">
                    {CHANGE_LABELS[entry.type] ?? entry.type}
                  </span>
                  <span className="flex-1 truncate">{entry.value}</span>
                  <span className="text-gray-300 dark:text-zinc-700 shrink-0">{entry.by}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── Notes Log ─────────────────────────────────────────────────────── */}
      <Section title="Notes Log">
        <form onSubmit={addNote} className="flex gap-2 mb-4">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a note…"
            className="flex-1 border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit" disabled={savingNote || !note.trim()}
            className="bg-gray-900 dark:bg-gray-100 hover:bg-gray-700 dark:hover:bg-gray-300 disabled:opacity-40 text-white dark:text-gray-900 text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Add
          </button>
        </form>
        <DailyNotesLog
          noteString={ro.notes ?? ''}
          noteSummaries={noteSummaries}
          summarizingDates={summarizingDates}
          canUndo={canEdit || role === 'parts_manager'}
          onUndoLine={undoNoteLine}
        />
      </Section>

    </div>
  )
}
