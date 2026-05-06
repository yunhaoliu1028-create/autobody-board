import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  doc, onSnapshot, collection, addDoc, updateDoc, serverTimestamp,
  query, where, orderBy, arrayUnion,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { StatusBadge, PartsStatusBadge, CCCFieldLabel } from '../components/StatusBadge'
import HighlightedNote from '../components/HighlightedNote'
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

// ── Notes list with dedup collapse ────────────────────────────────────────────
function NotesList({ deduped, dupCount }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? deduped : deduped.filter(n => !n.dup)
  return (
    <div className="space-y-1.5">
      {visible.map(({ line }, i) => (
        <div key={i} className="px-3 py-2.5 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50">
          <p className="text-xs text-gray-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
            <HighlightedNote text={line} />
          </p>
        </div>
      ))}
      {dupCount > 0 && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="w-full text-xs text-gray-400 dark:text-zinc-600 hover:text-blue-600 dark:hover:text-blue-400 py-1.5 text-center transition-colors"
        >
          {showAll
            ? `↑ Hide ${dupCount} duplicate${dupCount !== 1 ? 's' : ''}`
            : `↓ Show ${dupCount} duplicate note${dupCount !== 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  )
}

// ── Attachments gallery ───────────────────────────────────────────────────────
function AttachmentsSection({ roId, attachments = [] }) {
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState('')
  const fileInputRef = useRef(null)

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true); setError('')
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        const filename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        const sRef     = storageRef(storage, `ros/${roId}/attachments/${filename}`)
        await uploadBytes(sRef, file, { contentType: file.type })
        const url = await getDownloadURL(sRef)
        await updateDoc(doc(db, 'ros', roId), {
          attachments: arrayUnion({ url, name: file.name, uploadedAt: new Date().toISOString() }),
          updatedAt:   serverTimestamp(),
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

  return (
    <div>
      {/* Upload button */}
      <div className="flex items-center gap-3 mb-3">
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFiles}
        />
        {attachments.length > 0 && (
          <span className="text-xs text-gray-400 dark:text-zinc-600">{attachments.length} photo{attachments.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      {/* Gallery grid */}
      {attachments.length > 0 ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {attachments.map((att, i) => (
            <a
              key={i}
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              title={att.name}
              className="block aspect-square rounded-xl overflow-hidden border border-gray-200 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-500 transition-colors group"
            >
              <img
                src={att.url}
                alt={att.name}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
              />
            </a>
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

  const [ro,             setRo]             = useState(null)
  const [employees,      setEmployees]      = useState({})
  const [loading,        setLoading]        = useState(true)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [note,           setNote]           = useState('')
  const [savingNote,     setSavingNote]     = useState(false)

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
              {(isManager || role === 'parts_manager') && (
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
              {ro.partsNotes && (
                <span className="text-xs text-gray-500 dark:text-zinc-400">{ro.partsNotes}</span>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* ── Tasks ─────────────────────────────────────────────────────────── */}
      <Section title="Tasks">
        <TaskList roId={id} employees={employees} />
      </Section>

      {/* ── Attachments ───────────────────────────────────────────────────── */}
      <Section title="Photos & Attachments">
        <AttachmentsSection roId={id} attachments={ro.attachments ?? []} />
      </Section>

      {/* ── Change Log ────────────────────────────────────────────────────── */}
      {(ro.changeLog?.length ?? 0) > 0 && (
        <Section title="Change History">
          <div className="space-y-1.5">
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
        {ro.notes && typeof ro.notes === 'string' ? (() => {
          const lines = []
          let current = ''
          ro.notes.split('\n').forEach(line => {
            if (/^\[[^\]]+\]/.test(line)) {
              if (current.trim()) lines.push(current.trim())
              current = line
              return
            }
            if (!line.trim()) return
            current = current ? `${current}\n${line}` : line
          })
          if (current.trim()) lines.push(current.trim())
          const deduped = dedupeNoteLines(lines)
          const dupCnt  = deduped.filter(n => n.dup).length
          return (
            <NotesList deduped={deduped} dupCount={dupCnt} />
          )
        })() : (
          <p className="text-xs text-gray-400 dark:text-zinc-600 italic">No notes yet.</p>
        )}
      </Section>

    </div>
  )
}
