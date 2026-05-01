import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection, onSnapshot, query, where, orderBy, updateDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { MANAGER_ROLES } from '../constants/roles'

const STATUS_COLS = [
  { key: 'pending',     label: 'Pending',     color: 'bg-gray-100',   text: 'text-gray-700'  },
  { key: 'in_progress', label: 'In Progress', color: 'bg-blue-50',    text: 'text-blue-800'  },
  { key: 'completed',   label: 'Completed',   color: 'bg-green-50',   text: 'text-green-800' },
]
const PRIORITY_DOT = {
  high:   'bg-red-500',
  medium: 'bg-yellow-500',
  low:    'bg-gray-300',
}

function TaskCard({ task, isManager, employees, onStatusChange }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] ?? 'bg-gray-300'}`}
          title={task.priority}
        />
        <span className="text-xs font-bold text-gray-800 flex-1 truncate">{task.title}</span>
      </div>
      {task.description && (
        <p className="text-xs text-gray-500 line-clamp-2">{task.description}</p>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-gray-400">
          <Link to={`/ro/${task.roId}`} className="hover:text-blue-600 hover:underline">
            RO #{task.roId?.slice(-6) || '—'}
          </Link>
          {isManager && task.assignedTo && (
            <span className="ml-1">· {employees[task.assignedTo] ?? '?'}</span>
          )}
        </div>
        <div className="flex gap-1.5">
          {task.status === 'pending' && (
            <button
              onClick={() => onStatusChange(task.id, 'in_progress')}
              className="text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 px-2 py-0.5 rounded transition-colors"
            >
              Start
            </button>
          )}
          {task.status === 'in_progress' && (
            <button
              onClick={() => onStatusChange(task.id, 'completed')}
              className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-2 py-0.5 rounded transition-colors"
            >
              Done ✓
            </button>
          )}
          {task.status === 'completed' && (
            <button
              onClick={() => onStatusChange(task.id, 'pending')}
              className="text-xs text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded transition-colors"
            >
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TaskBoard() {
  const { user, role } = useAuth()
  const isManager = MANAGER_ROLES.includes(role)

  const [tasks,     setTasks]     = useState([])
  const [employees, setEmployees] = useState({})
  const [loading,   setLoading]   = useState(true)
  const [viewAll,   setViewAll]   = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map = {}
      snap.forEach(d => { map[d.id] = d.data().name })
      setEmployees(map)
    })
    return unsub
  }, [])

  useEffect(() => {
    let q
    if (isManager && viewAll) {
      q = query(
        collection(db, 'tasks'),
        where('status', 'in', ['pending', 'in_progress', 'completed']),
        orderBy('createdAt', 'desc'),
      )
    } else {
      q = query(
        collection(db, 'tasks'),
        where('assignedTo', '==', user.uid),
        orderBy('createdAt', 'desc'),
      )
    }
    const unsub = onSnapshot(q, snap => {
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    }, err => { console.error(err); setLoading(false) })
    return unsub
  }, [user.uid, isManager, viewAll])

  const handleStatusChange = async (taskId, newStatus) => {
    await updateDoc(doc(db, 'tasks', taskId), {
      status:      newStatus,
      completedAt: newStatus === 'completed' ? serverTimestamp() : null,
      updatedAt:   serverTimestamp(),
    })
  }

  const grouped = STATUS_COLS.reduce((acc, col) => {
    acc[col.key] = tasks.filter(t => t.status === col.key)
    return acc
  }, {})

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-400">Loading…</div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {isManager && viewAll ? 'All Tasks' : 'My Tasks'}
          </h1>
          <p className="text-sm text-gray-500">{tasks.length} total</p>
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
            {viewAll ? '👤 My Tasks' : '👥 All Team Tasks'}
          </button>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">✅</p>
          <p className="font-medium">No tasks assigned to you right now</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {STATUS_COLS.map(col => (
            <div key={col.key}>
              <div className={`flex items-center gap-2 mb-3 px-3 py-1.5 rounded-lg ${col.color}`}>
                <span className={`text-xs font-semibold ${col.text}`}>{col.label}</span>
                <span className={`ml-auto text-xs font-bold ${col.text}`}>
                  {grouped[col.key]?.length ?? 0}
                </span>
              </div>
              <div className="space-y-2">
                {(grouped[col.key] ?? []).map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    isManager={isManager}
                    employees={employees}
                    onStatusChange={handleStatusChange}
                  />
                ))}
                {grouped[col.key]?.length === 0 && (
                  <p className="text-xs text-gray-300 text-center py-4">Empty</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
