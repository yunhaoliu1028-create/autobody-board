import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  arrayUnion, collection, doc, onSnapshot, serverTimestamp, updateDoc, writeBatch,
} from 'firebase/firestore'
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { MANAGER_ROLES, PARTS_STATUSES, STATUS_MAP } from '../constants/roles'

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
    .map(group => ({ ...group, tasks: [...group.tasks].sort((a, b) => taskSortKey(a) - taskSortKey(b)) }))
    .sort((a, b) => a.sortKey - b.sortKey)
}

function AssignedROCard({ ro }) {
  const eta = etaOf(ro)
  const priority = roEtaPriority(ro)
  const status = STATUS_MAP[ro.status]
  const ps = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.low

  return (
    <Link
      to={`/ro/${ro.id}`}
      className={`block bg-white dark:bg-zinc-800/90 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-zinc-600 transition-all p-3.5 ${ps.bar}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-mono text-sm font-extrabold text-gray-900 dark:text-gray-100">
          #{ro.roNumber}
        </span>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${ps.tag}`}>
            {priority.toUpperCase()}
          </span>
          {ro.partsStatus && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${partsClass(ro.partsStatus)}`}>
              {PARTS_LABEL[ro.partsStatus] ?? ro.partsStatus}
            </span>
          )}
          {status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${status.color}`}>
              {status.label}
            </span>
          )}
        </div>
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
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${eta ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-gray-100 text-gray-400 dark:bg-zinc-700 dark:text-zinc-500'}`}>
          {eta ? `Paint due ${fmtDate(eta)}` : 'No paint due'}
        </span>
      </div>
    </Link>
  )
}

function MobileAssignedROCard({ ro }) {
  const eta = etaOf(ro)
  const status = STATUS_MAP[ro.status]
  const priority = roEtaPriority(ro)

  return (
    <Link to={`/ro/${ro.id}`}>
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
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${eta ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-gray-100 text-gray-400 dark:bg-zinc-700 dark:text-zinc-500'}`}>
            {eta ? `Paint due ${fmtDate(eta)}` : 'No paint due'}
          </span>
        </div>
      </article>
    </Link>
  )
}

function DailyTaskRow({
  task, isManager, isDragging, isOver,
  onDragStart, onDragEnd, onDragOver, onDrop,
  onStatusChange, onNote,
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const inputRef = useRef(null)
  const isDone = task.status === 'completed'

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

  return (
    <div
      draggable={isManager && !isDone}
      onDragStart={isManager ? onDragStart : undefined}
      onDragEnd={isManager ? onDragEnd : undefined}
      onDragOver={isManager ? onDragOver : undefined}
      onDrop={isManager ? onDrop : undefined}
      className={`rounded-lg border bg-white dark:bg-zinc-800/90 transition-all
        ${isDone ? 'opacity-50' : ''}
        ${isDragging ? 'opacity-40 scale-[0.98]' : ''}
        ${isOver ? 'border-blue-400 dark:border-blue-500 shadow-sm' : 'border-gray-100 dark:border-zinc-700'}
      `}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {isManager && !isDone && (
          <span className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-gray-300 dark:text-zinc-600 select-none">::</span>
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug">
            {task.title || 'Task'}
          </p>
          {task.description && (
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5 line-clamp-2">{task.description}</p>
          )}
          {task.taskNotes?.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-1 italic leading-snug">
              "{task.taskNotes[task.taskNotes.length - 1].text}"
            </p>
          )}
          {noteOpen && (
            <div className="mt-2 flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleNoteSubmit() }}
                placeholder="Reason not completed, update..."
                className="flex-1 min-w-0 text-xs border border-gray-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button onClick={handleNoteSubmit} className="text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium shrink-0">Save</button>
              <button onClick={() => { setNoteOpen(false); setNoteText('') }} className="text-xs px-2 py-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200">x</button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!isDone && !noteOpen && (
            <button
              onClick={openNote}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
              title="Add note"
            >Note</button>
          )}
          {task.status === 'pending' && (
            <button onClick={() => onStatusChange(task.id, 'in_progress')} className="text-xs px-2.5 py-1 rounded-lg bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/50 dark:hover:bg-blue-800/60 text-blue-700 dark:text-blue-300 font-medium transition-colors">Start</button>
          )}
          {task.status === 'in_progress' && (
            <button onClick={() => onStatusChange(task.id, 'completed')} className="text-xs px-2.5 py-1 rounded-lg bg-green-100 hover:bg-green-200 dark:bg-green-900/50 dark:hover:bg-green-800/60 text-green-700 dark:text-green-300 font-medium transition-colors">Done</button>
          )}
          {task.status === 'completed' && (
            <button onClick={() => onStatusChange(task.id, 'pending')} className="text-xs px-2 py-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors">Reopen</button>
          )}
        </div>
      </div>
      {task.status === 'in_progress' && (
        <div className="mx-3 mb-2.5 h-1 rounded-full bg-blue-100 dark:bg-blue-900/40">
          <div className="h-1 w-1/2 rounded-full bg-blue-500 animate-pulse" />
        </div>
      )}
    </div>
  )
}

function DailyTaskGroupCard({
  group, isManager, dragId, overId, setDragId, setOverId,
  onDrop, onStatusChange, onNote,
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/90">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/ro/${group.roId}`} className="font-mono text-xs font-bold text-blue-600 hover:underline dark:text-blue-400">
            RO#{group.roNumber}
          </Link>
          {group.vehicleInfo && (
            <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-zinc-500">{group.vehicleInfo}</p>
          )}
        </div>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500 dark:bg-zinc-700 dark:text-zinc-300">
          {group.tasks.length} task{group.tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-1.5">
        {group.tasks.map(task => (
          <DailyTaskRow
            key={task.id}
            task={task}
            isManager={isManager}
            isDragging={dragId === task.id}
            isOver={overId === task.id}
            onDragStart={() => setDragId(task.id)}
            onDragEnd={() => { setDragId(null); setOverId(null) }}
            onDragOver={e => { e.preventDefault(); setOverId(task.id) }}
            onDrop={onDrop}
            onStatusChange={onStatusChange}
            onNote={onNote}
          />
        ))}
      </div>
    </div>
  )
}

export default function TaskBoard() {
  const { user, role } = useAuth()
  const toast = useToast()
  const isManager = MANAGER_ROLES.includes(role)

  const [ros, setRos] = useState([])
  const [tasks, setTasks] = useState([])
  const [employees, setEmployees] = useState({})
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const [showDone, setShowDone] = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().name })
      setEmployees(map)
    })
    return unsub
  }, [])

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

  const assignedROs = useMemo(() => {
    const uid = user.uid
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
  }, [ros, user.uid])

  const myTasks = useMemo(() => tasks.filter(t => t.assignedTo === user.uid), [tasks, user.uid])

  const activeTasks = useMemo(() => {
    return myTasks
      .filter(t => t.status !== 'completed')
      .sort((a, b) => taskSortKey(a) - taskSortKey(b))
  }, [myTasks])

  const doneTasks = useMemo(() => {
    return myTasks
      .filter(t => t.status === 'completed')
      .sort((a, b) => taskSortKey(b) - taskSortKey(a))
  }, [myTasks])

  const activeTaskGroups = useMemo(() => groupTasksByRO(activeTasks), [activeTasks])
  const doneTaskGroups = useMemo(() => groupTasksByRO(doneTasks), [doneTasks])

  const authorName = useMemo(
    () => employees[user.uid] ?? user.email ?? 'Unknown',
    [employees, user]
  )

  const handleStatusChange = async (taskId, newStatus) => {
    try {
      await updateDoc(doc(db, 'tasks', taskId), {
        status: newStatus,
        completedAt: newStatus === 'completed' ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      toast.error('Update failed: ' + err.message)
    }
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

  const handleDrop = async () => {
    if (!dragId || !overId || dragId === overId) {
      setDragId(null)
      setOverId(null)
      return
    }
    const sorted = [...activeTasks]
    const fromIdx = sorted.findIndex(t => t.id === dragId)
    const toIdx = sorted.findIndex(t => t.id === overId)
    if (fromIdx === -1 || toIdx === -1) {
      setDragId(null)
      setOverId(null)
      return
    }
    const reordered = [...sorted]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(fromIdx < toIdx ? toIdx : toIdx, 0, moved)
    const batch = writeBatch(db)
    reordered.forEach((t, i) => batch.update(doc(db, 'tasks', t.id), { sortOrder: i * 1000 }))
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
      <section>
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">My ROs</h2>
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
                  <AssignedROCard ro={ro} />
                </div>
              ))}
            </div>
            <div className="sm:hidden space-y-2">
              {assignedROs.map(ro => <MobileAssignedROCard key={ro.id} ro={ro} />)}
            </div>
          </>
        )}
      </section>

      <section>
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Daily Tasks</h2>
          <span className="text-sm text-gray-400 dark:text-zinc-500">
            {activeTasks.length} active{isManager && ' · drag to reorder'}
          </span>
        </div>

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
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
