import { useState, useEffect } from 'react'
import {
  collection, onSnapshot, doc, serverTimestamp, getDoc,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { updateRoDoc } from '../utils/roMutations'
import { createTaskDoc } from '../utils/taskMutations'
import { useAuth } from '../contexts/AuthContext'
import { parseMeetingNotes, getApiKey } from '../hooks/useAI'
import { STATUS_MAP, RO_STATUSES, PARTS_STATUSES, CAR_STATUSES, CAR_STATUS_MAP } from '../constants/roles'
import { format } from 'date-fns'

const FIELD = 'border border-gray-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500'
const CARD = 'bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm'

function normalizeName(value = '') {
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function findEmployeeByName(employees, rawName = '') {
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  return employees.find(emp => {
    const name = normalizeName(emp.name)
    if (!name) return false
    if (name === target || name.includes(target) || target.includes(name)) return true
    return targetParts.some(part => part.length > 1 && name.split(' ').includes(part))
  }) ?? null
}

// ── Editable ChangeRow ────────────────────────────────────────────────────────
function ChangeRow({ change, checked, onToggle, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(change)

  const { roNumber, vehicleHint, changes, tasks, confidence } = draft
  const hasChanges = changes && Object.keys(changes).length > 0
  const hasTasks   = tasks && tasks.length > 0

  const setChanges = (patch) => setDraft(prev => ({ ...prev, changes: { ...prev.changes, ...patch } }))

  const handleTaskChange = (ti, patch) => {
    setDraft(prev => ({
      ...prev,
      tasks: prev.tasks.map((t, idx) => idx === ti ? { ...t, ...patch } : t),
    }))
  }

  const handleDeleteTask = (ti) => {
    setDraft(prev => ({ ...prev, tasks: prev.tasks.filter((_, idx) => idx !== ti) }))
  }

  const handleAddTask = () => {
    setDraft(prev => ({
      ...prev,
      tasks: [...(prev.tasks ?? []), { assigneeName: '', title: '', description: '', priority: 'medium' }],
    }))
  }

  const handleSave = () => {
    onChange(draft)
    setEditing(false)
  }

  const handleCancel = () => {
    setDraft(change)
    setEditing(false)
  }

  // ── EDIT MODE ──────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="border-2 border-blue-400 rounded-xl p-4 bg-white dark:bg-zinc-900 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-bold text-blue-700 dark:text-blue-300">RO#{roNumber} — Edit</span>
          {vehicleHint && <span className="text-xs text-gray-400 dark:text-zinc-400">{vehicleHint}</span>}
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Repair Status</label>
          <select
            className={`px-2 py-1.5 text-sm w-full ${FIELD}`}
            value={draft.changes?.status ?? ''}
            onChange={e => setChanges({ status: e.target.value || undefined })}
          >
            <option value="">(no change)</option>
            {RO_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        {/* Parts status */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Parts Status</label>
          <select
            className={`px-2 py-1.5 text-sm w-full ${FIELD}`}
            value={draft.changes?.partsStatus ?? ''}
            onChange={e => setChanges({ partsStatus: e.target.value || undefined })}
          >
            <option value="">(no change)</option>
            {PARTS_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        {/* Car status */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Car Status</label>
          <select
            className={`px-2 py-1.5 text-sm w-full ${FIELD}`}
            value={draft.changes?.carStatus ?? ''}
            onChange={e => setChanges({ carStatus: e.target.value || undefined })}
          >
            <option value="">(no change)</option>
            {CAR_STATUSES.map(s => <option key={s.key} value={s.key}>{s.icon} {s.label}</option>)}
          </select>
        </div>

        {/* Due date */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Target Completion Date</label>
          <input
            type="date"
            className={`px-2 py-1.5 text-sm ${FIELD}`}
            value={draft.changes?.dueDate ?? ''}
            onChange={e => setChanges({ dueDate: e.target.value || undefined })}
          />
        </div>

        {/* Note */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Note to append</label>
          <textarea
            className={`w-full px-2 py-1.5 text-sm resize-y ${FIELD}`}
            rows={3}
            value={draft.changes?.notes ?? ''}
            onChange={e => setChanges({ notes: e.target.value })}
          />
        </div>

        {/* Tasks */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-500">Tasks</label>
            <button
              onClick={handleAddTask}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >+ Add task</button>
          </div>
          <div className="space-y-2">
            {(draft.tasks ?? []).map((task, ti) => (
              <div key={ti} className="bg-green-50 dark:bg-emerald-950/25 rounded-lg p-2 space-y-1.5 border border-green-200 dark:border-emerald-900/60">
                <div className="flex gap-1.5">
                  <input
                    className={`flex-1 px-2 py-1 text-xs ${FIELD}`}
                    placeholder="Assignee"
                    value={task.assigneeName ?? ''}
                    onChange={e => handleTaskChange(ti, { assigneeName: e.target.value })}
                  />
                  <select
                    className={`px-1 py-1 text-xs ${FIELD}`}
                    value={task.priority ?? 'medium'}
                    onChange={e => handleTaskChange(ti, { priority: e.target.value })}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Med</option>
                    <option value="high">High</option>
                  </select>
                  <button
                    onClick={() => handleDeleteTask(ti)}
                    className="text-red-400 hover:text-red-600 text-xs px-1"
                    title="Remove task"
                  >×</button>
                </div>
                <input
                  className={`w-full px-2 py-1 text-xs ${FIELD}`}
                  placeholder="Task title"
                  value={task.title ?? ''}
                  onChange={e => handleTaskChange(ti, { title: e.target.value })}
                />
                <input
                  className={`w-full px-2 py-1 text-xs ${FIELD}`}
                  placeholder="Description (optional)"
                  value={task.description ?? ''}
                  onChange={e => handleTaskChange(ti, { description: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSave}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg"
          >Done</button>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-xs rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
          >Cancel</button>
        </div>
      </div>
    )
  }

  // ── PREVIEW MODE ───────────────────────────────────────────────────────────
  return (
    <div className={`border rounded-xl p-4 transition-colors ${checked ? 'border-blue-300 bg-blue-50/40' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 cursor-pointer w-4 h-4 accent-blue-600"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="font-bold text-blue-700">RO#{roNumber}</span>
            {vehicleHint && <span className="text-xs text-gray-500">{vehicleHint}</span>}
            {confidence === 'low' && (
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">⚠ Low confidence</span>
            )}
            {confidence === 'medium' && (
              <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Medium confidence</span>
            )}
          </div>

          {hasChanges && (
            <div className="space-y-1 mb-2">
              {changes.status && (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-gray-400 text-xs w-24 shrink-0">Status →</span>
                  <span className="font-medium text-purple-700">{STATUS_MAP[changes.status]?.label ?? changes.status}</span>
                </div>
              )}
              {changes.dueDate && (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-gray-400 text-xs w-24 shrink-0">Due Date →</span>
                  <span className="font-medium text-rose-700">🎯 {changes.dueDate}</span>
                </div>
              )}
              {changes.notes && (
                <div className="text-sm flex items-start gap-2">
                  <span className="text-gray-400 text-xs w-24 shrink-0 mt-0.5">Note →</span>
                  <span className="text-gray-700 italic">"{changes.notes}"</span>
                </div>
              )}
              {changes.partsStatus && (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-gray-400 text-xs w-24 shrink-0">Parts →</span>
                  <span className="font-medium text-yellow-700">{PARTS_STATUSES.find(p => p.key === changes.partsStatus)?.label ?? changes.partsStatus}</span>
                </div>
              )}
              {changes.carStatus && (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-gray-400 text-xs w-24 shrink-0">Car →</span>
                  <span className="font-medium">{CAR_STATUS_MAP[changes.carStatus]?.icon} {CAR_STATUS_MAP[changes.carStatus]?.label ?? changes.carStatus}</span>
                </div>
              )}
            </div>
          )}

          {hasTasks && (
            <div className="space-y-1">
              {tasks.map((task, i) => (
                <div key={i} className="text-sm flex items-start gap-2 bg-green-50 rounded-lg px-2.5 py-1.5">
                  <span className="text-green-600">✅</span>
                  <span>
                    <strong>{task.assigneeName}</strong>: {task.title}
                    {task.description && <span className="text-gray-500"> — {task.description}</span>}
                    <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded font-medium
                      ${task.priority === 'high' ? 'bg-red-100 text-red-700'
                        : task.priority === 'low' ? 'bg-gray-100 text-gray-600'
                        : 'bg-yellow-100 text-yellow-700'}`}>
                      {task.priority}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Edit button */}
        <button
          onClick={() => setEditing(true)}
          className="shrink-0 text-gray-400 hover:text-blue-600 text-sm px-2 py-0.5 rounded hover:bg-gray-100 transition-colors"
          title="Edit this card"
        >✏️</button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function MeetingImport() {
  const { user } = useAuth()
  const [ros,       setRos]       = useState([])
  const [employees, setEmployees] = useState([])
  const [nameMap,   setNameMap]   = useState('')
  const [vendorMap, setVendorMap] = useState('')
  const [text,      setText]      = useState('')
  const [images,    setImages]    = useState([])
  const [loading,   setLoading]   = useState(false)
  const [result,    setResult]    = useState(null)
  const [roActions, setRoActions] = useState([])   // editable copy
  const [checked,   setChecked]   = useState({})
  const [applying,  setApplying]  = useState(false)
  const [applied,   setApplied]   = useState(false)
  const [error,     setError]     = useState('')
  const [noKey,     setNoKey]     = useState(false)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'ros'),   s => setRos(s.docs.map(d => ({ id: d.id, ...d.data() }))))
    const u2 = onSnapshot(collection(db, 'users'), s => setEmployees(s.docs.map(d => ({ uid: d.id, ...d.data() }))))
    getDoc(doc(db, 'settings', 'ai')).then(snap => {
      if (snap.exists()) {
        if (snap.data().nameMap)   setNameMap(snap.data().nameMap)
        if (snap.data().vendorMap) setVendorMap(snap.data().vendorMap)
      }
    })
    return () => { u1(); u2() }
  }, [])

  // Listen for data injected by the Chrome Extension (DingTalk import)
  useEffect(() => {
    if (window.__dingtalkData) {
      const { text: t, images: imgs } = window.__dingtalkData
      if (t)           setText(t)
      if (imgs?.length) setImages(imgs)
      window.__dingtalkData = null
    }
    const handler = (e) => {
      if (e.detail?.text)         setText(e.detail.text)
      if (e.detail?.images?.length) setImages(e.detail.images)
    }
    window.addEventListener('dingtalkDataReady', handler)
    return () => window.removeEventListener('dingtalkDataReady', handler)
  }, [])

  // Sync editable roActions whenever result changes
  useEffect(() => {
    if (result?.roActions) {
      setRoActions(result.roActions)
      const init = {}
      result.roActions.forEach((a, i) => { init[i] = a.confidence !== 'low' })
      setChecked(init)
    }
  }, [result])

  const handleParse = async () => {
    if (!text.trim()) return
    setLoading(true); setError(''); setResult(null); setApplied(false)
    try {
      const key = await getApiKey()
      if (!key) { setNoKey(true); setLoading(false); return }
      const parsed = await parseMeetingNotes({ text, ros, employees, images, nameMap, vendorMap })
      setResult(parsed)
    } catch (err) {
      if (err.message === 'NO_API_KEY')  { setNoKey(true); return }
      if (err.message === 'INVALID_KEY') { setError('API key invalid. Update it in Settings.'); return }
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleApply = async () => {
    if (!roActions) return
    setApplying(true)
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees.find(e => e.uid === user.uid)?.name ?? 'Manager'

    for (let i = 0; i < roActions.length; i++) {
      if (!checked[i]) continue
      const action = roActions[i]
      const roDoc  = ros.find(r => r.roNumber === action.roNumber)
      if (!roDoc) continue

      try {
        const updates = { updatedAt: serverTimestamp() }

        if (action.changes?.status)      updates.status      = action.changes.status
        if (action.changes?.partsStatus) updates.partsStatus = action.changes.partsStatus
        if (action.changes?.carStatus)   updates.carStatus   = action.changes.carStatus
        if (action.changes?.dueDate)     updates.promisedDate = action.changes.dueDate
        if (action.changes?.notes) {
          const prev = roDoc.notes ?? ''
          updates.notes = `[${stamp} - Meeting] ${action.changes.notes}\n${prev}`
        }

        if (Object.keys(updates).length > 1) {
          await updateRoDoc(doc(db, 'ros', roDoc.id), updates)
        }

        for (const task of (action.tasks ?? [])) {
          const assignee = findEmployeeByName(employees, task.assigneeName)
          if (!assignee) throw new Error(`Could not match task assignee "${task.assigneeName}".`)
          await createTaskDoc(collection(db, 'tasks'), {
            roId:        roDoc.id,
            roNumber:    roDoc.roNumber,
            vehicleInfo: roDoc.vehicle,
            assignedTo:  assignee.uid,
            assignedToName: assignee.name ?? '',
            assignedBy:  user.uid,
            title:       task.title,
            description: task.description ?? '',
            priority:    task.priority ?? 'medium',
            status:      'pending',
            source:      'meeting_import',
            createdAt:   serverTimestamp(),
          })
        }
      } catch (err) {
        console.error('[MeetingImport] Failed:', action, err)
      }
    }

    setApplied(true)
    setApplying(false)
  }

  const selectedCount = Object.values(checked).filter(Boolean).length

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-zinc-100">Morning Meeting Import</h1>
        <p className="text-sm text-gray-500 mt-0.5">Paste your DingTalk AI meeting summary — AI will extract updates for review</p>
      </div>

      {noKey && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-sm text-orange-800">
          ⚙ AI not configured. <a href="/settings" className="underline font-medium">Add your Anthropic API key in Settings</a> to enable this feature.
        </div>
      )}

      {/* Input area */}
      <div className={`${CARD} p-5`}>
        <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-zinc-500 mb-2">
          Paste DingTalk AI Summary or Meeting Notes
        </label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={10}
          placeholder={"Paste the DingTalk AI meeting summary here…\n\nThe AI will find:\n• RO numbers mentioned\n• Status updates\n• Task assignments\n• Parts updates"}
          className={`w-full px-3 py-2 text-sm font-mono resize-y ${FIELD}`}
        />

        {/* Image preview strip */}
        {images.length > 0 && (
          <div className="mt-3 p-2 bg-indigo-50 border border-indigo-200 rounded-lg">
            <p className="text-xs font-semibold text-indigo-700 mb-2">
              📷 {images.length} image{images.length > 1 ? 's' : ''} from DingTalk 图文纪要 — Claude will read these too
            </p>
            <div className="flex gap-2 flex-wrap">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt={`Meeting image ${i + 1}`}
                  className="h-16 w-auto rounded border border-indigo-300 object-cover cursor-pointer hover:opacity-80"
                  onClick={() => window.open(`data:${img.mimeType};base64,${img.base64}`, '_blank')}
                  title="Click to view full size"
                />
              ))}
            </div>
            <button
              onClick={() => setImages([])}
              className="text-xs text-indigo-500 hover:text-indigo-700 mt-1"
            >× Remove images</button>
          </div>
        )}

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-400 dark:text-zinc-500">
            {text.length} characters{images.length > 0 ? ` · ${images.length} image(s)` : ''}
          </span>
          <button
            onClick={handleParse}
            disabled={!text.trim() || loading}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
            )}
            {loading ? 'Parsing with AI…' : 'Parse Meeting Notes'}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      {/* Results */}
      {result && !applied && (
        <div className="space-y-4">
          {result.summary && (
            <div className="bg-blue-50 dark:bg-blue-950/25 border border-blue-200 dark:border-blue-900/60 rounded-xl p-4">
              <p className="text-xs font-semibold text-blue-500 dark:text-blue-300 uppercase tracking-wide mb-1">AI Summary</p>
              <p className="text-sm text-blue-900 dark:text-blue-100">{result.summary}</p>
            </div>
          )}

          {roActions.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-zinc-200">
                  {roActions.length} RO{roActions.length > 1 ? 's' : ''} with updates — edit if needed, then select to apply:
                </h3>
                <div className="flex gap-3 text-xs text-blue-600 dark:text-blue-400">
                  <button onClick={() => {
                    const all = {}; roActions.forEach((_, i) => all[i] = true); setChecked(all)
                  }}>Select all</button>
                  <button onClick={() => setChecked({})}>Deselect all</button>
                </div>
              </div>
              <div className="space-y-3">
                {roActions.map((action, i) => (
                  <ChangeRow
                    key={i}
                    change={action}
                    checked={!!checked[i]}
                    onToggle={() => setChecked(prev => ({ ...prev, [i]: !prev[i] }))}
                    onChange={(updated) => setRoActions(prev => prev.map((a, idx) => idx === i ? updated : a))}
                  />
                ))}
              </div>
            </div>
          )}

          {result.generalNotes && (
            <div className="bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wide mb-1">General Notes</p>
              <p className="text-sm text-gray-700 dark:text-zinc-200">{result.generalNotes}</p>
            </div>
          )}

          {result.unrecognized?.length > 0 && (
            <div className="bg-yellow-50 dark:bg-yellow-950/25 border border-yellow-200 dark:border-yellow-900/60 rounded-xl p-4">
              <p className="text-xs font-semibold text-yellow-700 uppercase tracking-wide mb-1">⚠ Couldn't Match These</p>
              <ul className="text-sm text-yellow-800 dark:text-yellow-100 space-y-0.5 list-disc ml-4">
                {result.unrecognized.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={handleApply}
              disabled={selectedCount === 0 || applying}
              className="px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg transition-colors"
            >
              {applying ? 'Applying…' : `✓ Apply ${selectedCount} Selected Update${selectedCount !== 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => { setResult(null); setText('') }}
              className="px-4 py-2.5 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
            >
              Start Over
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div className="bg-green-50 dark:bg-emerald-950/25 border border-green-300 dark:border-emerald-900/60 rounded-xl p-5 text-center">
          <p className="text-2xl mb-2">✅</p>
          <p className="font-semibold text-green-800 dark:text-emerald-200">Updates applied successfully!</p>
          <p className="text-sm text-green-600 dark:text-emerald-300 mt-1">All selected changes have been saved to the board.</p>
          <button
            onClick={() => { setResult(null); setText(''); setApplied(false) }}
            className="mt-3 text-sm text-green-700 dark:text-emerald-300 underline"
          >
            Import another meeting
          </button>
        </div>
      )}
    </div>
  )
}
