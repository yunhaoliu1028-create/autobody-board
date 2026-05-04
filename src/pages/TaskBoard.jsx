import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection, onSnapshot, query, updateDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import { differenceInCalendarDays, parseISO, isValid } from 'date-fns'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { MANAGER_ROLES } from '../constants/roles'

function liveTaskPriority(task) {
  if (!task.dueDate) return task.priority ?? 'low'
  try {
    const due = parseISO(task.dueDate)
    if (!isValid(due)) return task.priority ?? 'low'
    const days = differenceInCalendarDays(due, new Date())
    if (days <= 2) return 'high'
    if (days <= 7) return 'medium'
    return 'low'
  } catch {
    return task.priority ?? 'low'
  }
}

function taskCreatedMillis(task) {
  const value = task.createdAt
  if (value?.toMillis) return value.toMillis()
  if (value?.seconds) return value.seconds * 1000
  return 0
}

const STATUS_COLS = [
  { key: 'pending',     label: 'Pending',     color: 'bg-gray-100 dark:bg-zinc-800',    text: 'text-gray-700 dark:text-zinc-300',  count: 'text-gray-500 dark:text-zinc-400' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-blue-50 dark:bg-blue-900/30',  text: 'text-blue-800 dark:text-blue-300',  count: 'text-blue-500 dark:text-blue-400' },
  { key: 'completed',   label: 'Completed',   color: 'bg-green-50 dark:bg-green-900/30',text: 'text-green-800 dark:text-green-300',count: 'text-green-600 dark:text-green-400' },
]

const PRIORITY_DOT = {
  high: 'bg-red-500',
  medium: 'bg-yellow-500',
  low: 'bg-gray-300',
}

function TaskCard({ task, isManager, employees, onStatusChange, onAssigneeChange }) {
  const priority     = liveTaskPriority(task)
  const assigneeName = task.assignedToName || employees[task.assignedTo] || 'Unassigned'

  return (
    <div className="bg-white dark:bg-zinc-800/90 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm p-3.5 space-y-2.5">

      {/* Row 1: RO# (left) + priority dot (right) */}
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`/ro/${task.roId}`}
          className="font-mono text-sm font-extrabold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          onClick={e => e.stopPropagation()}
        >
          RO #{task.roNumber || '—'}
        </Link>
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${PRIORITY_DOT[priority] ?? 'bg-gray-300'}`}
          title={`Priority: ${priority}`}
        />
      </div>

      {/* Row 2: Vehicle info */}
      {task.vehicleInfo && (
        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate leading-snug">
          {task.vehicleInfo}
        </p>
      )}

      {/* Row 3: Task title / operation */}
      <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug">
        {task.title}
      </p>

      {/* Description (optional) */}
      {task.description && (
        <p className="text-xs text-gray-500 dark:text-zinc-400 line-clamp-2">{task.description}</p>
      )}

      {/* Bottom row: assignee (manager) + action buttons */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        {isManager ? (
          <select
            value={task.assignedTo || ''}
            onChange={e => onAssigneeChange(task.id, e.target.value)}
            className="max-w-[11rem] rounded-lg border border-gray-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none"
          >
            <option value="">Unassigned</option>
            {Object.entries(employees).map(([uid, name]) => (
              <option key={uid} value={uid}>{name}</option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-gray-500 dark:text-zinc-400 font-medium">{assigneeName}</span>
        )}

        <div className="flex gap-1.5 shrink-0">
          {task.status === 'pending' && (
            <button
              onClick={() => onStatusChange(task.id, 'in_progress')}
              className="text-xs bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/50 dark:hover:bg-blue-800/60 text-blue-700 dark:text-blue-300 px-2.5 py-1 rounded-lg font-medium transition-colors"
            >Start</button>
          )}
          {task.status === 'in_progress' && (
            <button
              onClick={() => onStatusChange(task.id, 'completed')}
              className="text-xs bg-green-100 hover:bg-green-200 dark:bg-green-900/50 dark:hover:bg-green-800/60 text-green-700 dark:text-green-300 px-2.5 py-1 rounded-lg font-medium transition-colors"
            >Done ✓</button>
          )}
          {task.status === 'completed' && (
            <button
              onClick={() => onStatusChange(task.id, 'pending')}
              className="text-xs text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
            >Reopen</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TaskBoard() {
  const { user, role } = useAuth()
  const isManager = MANAGER_ROLES.includes(role)

  const [tasks, setTasks] = useState([])
  const [employees, setEmployees] = useState({})
  const [loading, setLoading] = useState(true)
  const [viewAll, setViewAll] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().name })
      setEmployees(map)
    })
    return unsub
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'tasks'))
    const unsub = onSnapshot(q, snap => {
      const allTasks = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(task => ['pending', 'in_progress', 'completed'].includes(task.status || 'pending'))
        .sort((a, b) => taskCreatedMillis(b) - taskCreatedMillis(a))

      setTasks(isManager && viewAll
        ? allTasks
        : allTasks.filter(task => task.assignedTo === user.uid)
      )
      setError('')
      setLoading(false)
    }, err => {
      console.error(err)
      setError(err.message)
      setLoading(false)
    })
    return unsub
  }, [user.uid, isManager, viewAll])

  const handleStatusChange = async (taskId, newStatus) => {
    await updateDoc(doc(db, 'tasks', taskId), {
      status: newStatus,
      completedAt: newStatus === 'completed' ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    })
  }

  const handleAssigneeChange = async (taskId, assigneeUid) => {
    await updateDoc(doc(db, 'tasks', taskId), {
      assignedTo: assigneeUid,
      assignedToName: employees[assigneeUid] ?? '',
      updatedAt: serverTimestamp(),
    })
  }

  const grouped = STATUS_COLS.reduce((acc, col) => {
    acc[col.key] = tasks.filter(t => (t.status || 'pending') === col.key)
    return acc
  }, {})

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {isManager && viewAll ? 'All Tasks' : 'My Tasks'}
          </h1>
          <p className="text-sm text-gray-500 dark:text-zinc-400">{tasks.length} total</p>
        </div>

        {isManager && (
          <button
            onClick={() => setViewAll(v => !v)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors
              ${viewAll
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'
              }`}
          >
            {viewAll ? 'My Tasks' : 'All Team Tasks'}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Task list failed to load: {error}
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="font-medium">No tasks assigned to you right now</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {STATUS_COLS.map(col => (
            <div key={col.key}>
              <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-xl ${col.color}`}>
                <span className={`text-sm font-bold ${col.text}`}>{col.label}</span>
                <span className={`ml-auto text-xs font-bold ${col.count}`}>
                  {grouped[col.key]?.length ?? 0}
                </span>
              </div>
              <div className="space-y-2.5">
                {(grouped[col.key] ?? []).map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    isManager={isManager}
                    employees={employees}
                    onStatusChange={handleStatusChange}
                    onAssigneeChange={handleAssigneeChange}
                  />
                ))}
                {grouped[col.key]?.length === 0 && (
                  <p className="text-xs text-gray-400 dark:text-zinc-600 text-center py-5">—</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
