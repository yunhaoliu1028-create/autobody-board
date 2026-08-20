import { useEffect, useMemo, useRef, useState } from 'react'
import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore'
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from 'firebase/storage'
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { MANAGER_ROLES, PARTS_STATUSES, ROLES, STATUS_MAP } from '../constants/roles'
import { transcribeWithWhisper } from '../hooks/useAI'
import MobileROSheet from '../components/MobileROSheet'
import { partsLabel, statusLabel, t } from '../utils/mobileI18n'
import { compressImageFile, compressVideoFrame } from '../utils/imageCompression'
import { playShutterSound } from '../utils/cameraFeedback'
import { updateRoDoc } from '../utils/roMutations'
import { createTaskDoc, setNewTaskDoc, updateTaskDoc } from '../utils/taskMutations'

function IconMic() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 0 1-14 0M12 18v3M9 21h6" />
    </svg>
  )
}

function IconCamera() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.2-1.8h5L15.7 6h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </svg>
  )
}

function IconChevron() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  )
}

function PhotoSheet({ onCamera, onLibrary, onClose }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-zinc-950/20 p-3 backdrop-blur-sm dark:bg-black/45" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-[1.6rem] border border-zinc-200/80 bg-white/90 shadow-2xl shadow-zinc-400/30 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/95 dark:shadow-black/70"
        onClick={event => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onCamera}
          className="flex w-full items-center gap-4 px-5 py-4 text-left transition active:bg-zinc-100/70 dark:active:bg-white/5"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10">
            <IconCamera />
          </span>
          <span>
            <span className="block text-[15px] font-semibold text-zinc-950 dark:text-zinc-100">Take Photo</span>
            <span className="mt-0.5 block text-xs text-zinc-500">Continuous camera</span>
          </span>
        </button>
        <button
          type="button"
          onClick={onLibrary}
          className="flex w-full items-center gap-4 border-t border-zinc-200/70 px-5 py-4 text-left transition active:bg-zinc-100/70 dark:border-white/10 dark:active:bg-white/5"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path strokeLinecap="round" d="m21 15-5-5L5 21" />
            </svg>
          </span>
          <span>
            <span className="block text-[15px] font-semibold text-zinc-950 dark:text-zinc-100">Photo Library</span>
            <span className="mt-0.5 block text-xs text-zinc-500">Choose multiple photos</span>
          </span>
        </button>
      </div>
    </div>
  )
}

function CameraModal({ onDone, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [shots, setShots] = useState([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [height, setHeight] = useState(() => window.visualViewport?.height || window.innerHeight)

  useEffect(() => {
    const handleResize = () => setHeight(window.visualViewport?.height || window.innerHeight)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => window.visualViewport?.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
      audio: false,
    }
    navigator.mediaDevices?.getUserMedia(constraints)
      .catch(() => navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }))
      .then(stream => {
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setReady(true)
      })
      .catch(() => setError('Camera access is blocked. Please allow camera permission.'))
    return () => streamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  const stopCamera = () => streamRef.current?.getTracks().forEach(track => track.stop())

  const snap = async () => {
    const video = videoRef.current
    if (!video || !ready) return
    const blob = await compressVideoFrame(video)
    if (!blob) return
    playShutterSound()
    setShots(prev => [...prev, { blob, preview: URL.createObjectURL(blob), name: `camera_${Date.now()}.jpg` }])
  }

  const removeShot = (index) => setShots(prev => {
    URL.revokeObjectURL(prev[index]?.preview)
    return prev.filter((_, i) => i !== index)
  })

  const cancel = () => {
    stopCamera()
    shots.forEach(shot => URL.revokeObjectURL(shot.preview))
    onClose()
  }

  const done = () => {
    stopCamera()
    onDone(shots)
  }

  const stripHeight = shots.length ? 82 : 0
  const controlHeight = 126
  const videoHeight = Math.max(160, height - stripHeight - controlHeight)

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white" style={{ height }}>
      {shots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto bg-zinc-950 px-3 py-2" style={{ height: stripHeight }}>
          {shots.map((shot, index) => (
            <div key={`${shot.name}-${index}`} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl ring-2 ring-white/25">
              <img src={shot.preview} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeShot(index)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 text-xs text-white"
                aria-label="Remove shot"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="flex items-center justify-center px-6 text-center text-sm text-zinc-300" style={{ height: videoHeight }}>
          {error}
        </div>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted className="block w-full object-cover" style={{ height: videoHeight }} />
      )}

      <div className="flex items-center justify-between bg-black px-8" style={{ height: controlHeight }}>
        <button type="button" onClick={cancel} className="min-w-16 text-left text-[16px] font-medium text-zinc-100">
          Cancel
        </button>
        <button
          type="button"
          onClick={snap}
          disabled={!ready}
          className="flex h-[74px] w-[74px] items-center justify-center rounded-full border-4 border-white disabled:opacity-40"
          aria-label="Take photo"
        >
          <span className="h-[56px] w-[56px] rounded-full bg-white/15" />
        </button>
        <button
          type="button"
          onClick={done}
          disabled={shots.length === 0}
          className="min-w-16 text-right text-[16px] font-semibold text-blue-300 disabled:text-white/30"
        >
          {shots.length ? `Done (${shots.length})` : 'Done'}
        </button>
      </div>
    </div>
  )
}

const PARTS_LABEL = Object.fromEntries(PARTS_STATUSES.map(s => [s.key, s.label]))
const TASK_STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 }

function etaOf(ro) {
  return ro?.eta || ro?.cccDateOut || ro?.promisedDate || null
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

function dueTone(s) {
  if (!s) return 'bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800'
  try {
    const days = differenceInCalendarDays(parseISO(s), new Date())
    if (days <= 0) return 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-400/20'
    if (days <= 2) return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20'
    return 'bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800'
  } catch {
    return 'bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800'
  }
}

function partStatusTone(status) {
  if (status === 'all_received') return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20'
  if (status === 'partially_received') return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20'
  if (status === 'ordered') return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-200 dark:ring-blue-400/20'
  return 'bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700'
}

function phaseTone(status) {
  if (['body_work', 'body_complete'].includes(status)) return 'bg-blue-50 text-blue-700 ring-1 ring-blue-100 dark:bg-blue-500/10 dark:text-blue-200 dark:ring-blue-400/20'
  if (['paint_prep', 'in_paint', 'paint_complete'].includes(status)) return 'bg-violet-50 text-violet-700 ring-1 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-200 dark:ring-violet-400/20'
  if (['reassembly', 'detail', 'sublet'].includes(status)) return 'bg-sky-50 text-sky-700 ring-1 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-400/20'
  if (status === 'ready') return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20'
  return 'bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800'
}

function taskSortKey(task) {
  const status = TASK_STATUS_ORDER[task.status] ?? 1
  const v = task.sortOrder ?? task.createdAt?.toMillis?.() ?? task.createdAt?.seconds ?? 0
  return status * 1_000_000_000 + v
}

function assignedToWorker(ro, uid, role) {
  if (!ro || !uid) return false
  if (role === ROLES.BODY_MAN) return ro.assignedBodyMan === uid
  if (role === ROLES.PAINTER || role === ROLES.PAINT_HELPER) return ro.assignedPainter === uid
  return ro.assignedBodyMan === uid || ro.assignedPainter === uid
}

const BODY_MAIN_PHASES = ['teardown', 'body', 'reassembly']
const BODY_TASK_BY_STATUS = {
  teardown:   { title: 'Teardown',   phase: 'teardown' },
  body_work:  { title: 'Repair',     phase: 'body' },
  reassembly: { title: 'Reassembly', phase: 'reassembly' },
}

function bodyMainTasksComplete(tasks) {
  const completed = new Set()
  for (const task of tasks) {
    if (task.status !== 'completed') continue
    const phase = inferredTaskPhase(task)
    if (BODY_MAIN_PHASES.includes(phase)) completed.add(phase)
  }
  return BODY_MAIN_PHASES.every(phase => completed.has(phase))
}

function isBodyWorkerRo(ro, uid, role) {
  return role === ROLES.BODY_MAN && ro?.assignedBodyMan === uid
}

function bodyTaskForStatus(status) {
  return BODY_TASK_BY_STATUS[status] || null
}

function hasBodyMainTaskForStatus(ro, tasks) {
  const tmpl = bodyTaskForStatus(ro?.status)
  if (!ro || !tmpl) return true
  return tasks.some(task => {
    const sameRo = task.roId === ro.id || String(task.roNumber || '') === String(ro.roNumber || '')
    if (!sameRo || task.assignedTo !== ro.assignedBodyMan || task.taskKind === 'secondary') return false
    return inferredTaskPhase(task) === tmpl.phase
  })
}

function vehicleLine(ro) {
  return ro.vehicle || ro.vehicleInfo || 'Vehicle missing'
}

function shortInsurance(name) {
  if (!name) return ''
  return name
    .replace(/\s+INSURANCE\b.*/i, '')
    .replace(/\s+COMPANIES\b.*/i, '')
    .trim() || name
}

function vehicleMetaLine(ro) {
  return [ro.vehicleColor, shortInsurance(ro.insuranceCompany)].filter(Boolean).join(' · ') || ro.customerName || ''
}

function partsProgress(ro, language) {
  const orders = Array.isArray(ro.partsOrders) ? ro.partsOrders : []
  let total = 0
  let received = 0
  for (const order of orders) {
    const qty = Number(order.qty ?? order.quantity ?? 0)
    const rcvd = Number(order.qtyReceived ?? order.receivedQty ?? 0)
    if (Number.isFinite(qty)) total += qty
    if (Number.isFinite(rcvd)) received += rcvd
  }
  if (total > 0) return `${received}/${total} received`
  if (ro.partsStatus) return partsLabel(language, ro.partsStatus, PARTS_LABEL[ro.partsStatus] ?? ro.partsStatus)
  return t(language, 'partsNotOrdered', 'not ordered')
}

function taskText(task) {
  return `${task.title || ''} ${task.description || ''}`.toLowerCase()
}

function inferredTaskPhase(task) {
  if (task.phase === 'teardown') return 'teardown'
  if (task.phase === 'body' || task.phase === 'body_work') return 'body'
  if (task.phase === 'reassembly') return 'reassembly'
  const text = taskText(task)
  if (text.includes('teardown') || text.includes('tear down')) return 'teardown'
  if (text.includes('reassembly') || text.includes('reassemble')) return 'reassembly'
  if (/\brepair|body work|process repair\b/i.test(text)) return 'body'
  return ''
}

function isPrimaryBodyTask(task) {
  if (task.taskKind === 'secondary') return false
  return task.taskKind === 'primary' || ['teardown', 'body', 'reassembly'].includes(inferredTaskPhase(task))
}

function compactTaskTitle(task) {
  if (task.displayTitle) return task.displayTitle
  if (task.taskKind !== 'secondary') {
    const phase = inferredTaskPhase(task)
    if (phase === 'teardown') return 'Teardown'
    if (phase === 'body') return 'Repair'
    if (phase === 'reassembly') return 'Reassembly'
  }
  const text = taskText(task)
  if (text.includes('tire') || text.includes('tyre') || text.includes('pressure') || text.includes('tpms')) return 'Tire pressure check'
  if (text.includes('process repair')) return 'Process repair'
  if (text.includes('progress') && text.includes('photo')) return 'Progress photos'
  if (text.includes('photo')) return 'Photos'
  if (text.includes('fitment')) return 'Fitment check'
  if (text.includes('supplement')) return 'Supplement review'
  if (text.includes('paint prep')) return 'Paint prep'
  return task.title || 'Task'
}

function taskDedupeKey(task) {
  if (isPrimaryBodyTask(task)) return `primary:${inferredTaskPhase(task)}`
  const title = compactTaskTitle(task).toLowerCase()
  if (title === 'teardown') return 'teardown'
  return `${title}:${(task.description || '').toLowerCase()}`
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
    const key = taskDedupeKey(task)
    const current = map.get(key)
    if (
      !current ||
      statusRank(task.status) > statusRank(current.status) ||
      taskSortKey(task) > taskSortKey(current)
    ) {
      map.set(key, task)
    }
  }
  return [...map.values()].sort((a, b) => taskSortKey(a) - taskSortKey(b))
}

function compactTaskHint(task) {
  if (isPrimaryBodyTask(task)) return ''
  const coreTitle = compactTaskTitle(task)
  const subTasks = Array.isArray(task.subTasks) ? task.subTasks : []
  const taskNotes = Array.isArray(task.taskNotes) ? task.taskNotes : []
  const latestNote = taskNotes[taskNotes.length - 1]?.text || ''
  const subTitle = subTasks.find(sub => sub?.status !== 'completed')?.title || subTasks[0]?.title || ''
  const originalTitle = task.title && task.title !== coreTitle ? task.title : ''
  const parts = [latestNote, subTitle, originalTitle, task.description]
    .filter(Boolean)
    .filter((value, index, arr) => arr.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index)
  const text = parts.join(' - ')
  if (!text || text === task.title) return ''
  return text.length > 72 ? `${text.slice(0, 72)}...` : text
}

function nextTaskStatus(status) {
  if (status === 'pending') return 'in_progress'
  if (status === 'in_progress') return 'completed'
  return 'completed'
}

function taskButtonLabel(status, language) {
  if (status === 'in_progress') return t(language, 'working', 'Working')
  if (status === 'completed') return t(language, 'completeState', 'Complete')
  return t(language, 'start', 'Start')
}

function taskGlyph(status) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}

function taskButtonTone(status) {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20'
  if (status === 'in_progress') return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-100 dark:ring-blue-400/20'
  return 'bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700'
}

function taskMatchesWorkerCommand(task, command) {
  const haystack = `${compactTaskTitle(task)} ${task.title || ''} ${task.description || ''} ${task.phase || ''}`.toLowerCase()
  if (/\btear\s*down|teardown\b/i.test(command)) return /teardown|tear down/.test(haystack)
  if (/\breassembly|reassemble|assemble\b/i.test(command)) return /reassembly|reassemble|assemble/.test(haystack)
  if (/\brepair|body\b/i.test(command)) return /repair|body|process/.test(haystack)
  if (/\bphoto|picture|image\b/i.test(command)) return /photo|picture|image/.test(haystack)
  if (/\bpaint|prep\b/i.test(command)) return /paint|prep/.test(haystack)
  return false
}

function chooseTaskForCommand(tasks, command) {
  const activeTasks = tasks.filter(task => task.status !== 'completed')
  if (activeTasks.length === 1) return activeTasks[0]
  return activeTasks.find(task => taskMatchesWorkerCommand(task, command)) || null
}

function parseWorkerCommand(text) {
  const normalized = text.toLowerCase()
  return {
    wantsNeedsParts: /\bneed(s)?\s+parts?|missing\s+parts?|parts?\s+(needed|missing|issue)\b/i.test(normalized),
    wantsSuppDamage: /\bsupp(lement)?\s*(damage|needed)?|additional\s+damage|hidden\s+damage|more\s+damage\b/i.test(normalized),
    wantsComplete: /\b(done|complete|completed|finished|finish)\b/i.test(normalized),
    wantsStart: /\b(start|started|begin|working|work on)\b/i.test(normalized),
  }
}

function findEmployeeByRole(employees, role) {
  return employees.find(emp => emp.role === role)?.uid || null
}

function roleFallbackAssignee(employees, roles) {
  for (const role of roles) {
    const uid = findEmployeeByRole(employees, role)
    if (uid) return uid
  }
  return null
}

function makeNote(authorName, text) {
  return `[${format(new Date(), 'MM/dd HH:mm')} - ${authorName}] ${text}`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function taskAssignmentTitlesFromNotes(notes, workerName) {
  if (!notes || !workerName) return []
  const names = [workerName, workerName.split(/\s+/)[0]].filter(Boolean)
  const namePattern = names.map(escapeRegExp).join('|')
  if (!namePattern) return []
  const assignedRe = new RegExp(`\\]\\s*Task assigned to\\s+(?:${namePattern})\\s*[—-]\\s*(.+)$`, 'i')
  const taskForRe = new RegExp(`\\]\\s*Task for\\s+(?:${namePattern})\\s*:\\s*(.+)$`, 'i')
  return String(notes)
    .split('\n')
    .map(line => line.match(assignedRe)?.[1] || line.match(taskForRe)?.[1] || '')
    .map(text => text.trim().replace(/^["']|["']$/g, '').replace(/\.$/, ''))
    .filter(Boolean)
}

function isGenericBodyTask(task) {
  const title = compactTaskTitle(task).toLowerCase()
  return title === 'teardown' || title === 'process repair' || title === 'teardown & process repair'
}

function taskLooksLikeBodyAssignment(text) {
  return /\b(teardown|tear\s*down|begin repair|start repair|process repair|body\s*(man|tech|work))\b/i.test(text)
}

function visibleTasksForRo(ro, tasks, workerName) {
  const legacyCustomTitles = taskAssignmentTitlesFromNotes(ro.notes, workerName)
    .filter(title => !taskLooksLikeBodyAssignment(title))

  let titleIndex = 0
  const decorated = tasks.map(task => {
    if (!legacyCustomTitles.length || !isGenericBodyTask(task)) return task
    const title = legacyCustomTitles[titleIndex]
    titleIndex += 1
    if (!title) return task
    return { ...task, displayTitle: title }
  })

  return dedupeTasks(decorated)
}

function StatCard({ number, label }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white/80 px-3 py-2.5 shadow-sm shadow-black/5 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-black/20">
      <div className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{number}</div>
      <div className="mt-0.5 text-[10px] font-medium uppercase text-zinc-500">{label}</div>
    </div>
  )
}

function TaskRow({ task, onCycle, language }) {
  const hint = compactTaskHint(task)
  const completed = task.status === 'completed'
  return (
    <div className={`flex items-center gap-2 rounded-xl px-2.5 py-2.5 ring-1 ${
      completed
        ? 'bg-emerald-50/45 ring-emerald-200/70 dark:bg-white/[0.025] dark:ring-white/10'
        : 'bg-white/65 ring-zinc-200/90 dark:bg-black/30 dark:ring-zinc-800/90'
    }`}>
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${taskButtonTone(task.status)}`}>
        {taskGlyph(task.status)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-zinc-950 dark:text-zinc-50">{compactTaskTitle(task)}</p>
        {hint && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onCycle(task)
        }}
        className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition active:scale-[0.98] ${taskButtonTone(task.status)} ${
          completed ? 'dark:bg-transparent' : ''
        }`}
      >
        {taskButtonLabel(task.status, language)}
      </button>
    </div>
  )
}

function ExceptionChip({ active, children }) {
  if (!active) return null
  return (
    <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20">
      {children}
    </span>
  )
}

function ROCard({ ro, tasks, selected, onSelect, onCycleTask, recentUpdate, showCompleted = false, language = 'english' }) {
  const [showDoneTasks, setShowDoneTasks] = useState(false)
  const eta = etaOf(ro)
  const status = STATUS_MAP[ro.status]
  const sortedTasks = dedupeTasks(tasks)
  const activeTasks = sortedTasks.filter(t => t.status !== 'completed')
  const completedTasks = sortedTasks.filter(t => t.status === 'completed')
  const visibleTasks = showCompleted ? [] : activeTasks
  const doneCount = sortedTasks.filter(t => t.status === 'completed').length
  const flags = ro.workerFlags || {}
  const meta = vehicleMetaLine(ro)

  return (
    <article
      className={`rounded-[1.35rem] border bg-white/82 p-3.5 shadow-lg shadow-zinc-200/70 backdrop-blur-xl transition dark:bg-zinc-950/80 dark:shadow-black/20 ${
        selected
          ? 'border-blue-500/80 ring-1 ring-blue-400/25 dark:border-blue-400/55 dark:ring-blue-400/10'
          : flags.needsParts || flags.suppDamage
          ? 'border-amber-400/70'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onSelect(ro.id)}
            className="font-mono text-[16px] font-semibold tracking-tight text-blue-300 transition hover:text-blue-200 active:scale-[0.98]"
            aria-label={`Open RO ${ro.roNumber} summary`}
          >
            #{ro.roNumber}
          </button>
          <h3 className="mt-1 max-w-[16rem] text-[16px] font-semibold leading-[1.08] tracking-tight text-zinc-950 dark:text-zinc-50">
            {vehicleLine(ro)}
          </h3>
          {meta && <p className="mt-1 truncate text-[12px] text-zinc-500 dark:text-zinc-500">{meta}</p>}
          {ro.vin && <p className="mt-0.5 truncate font-mono text-[12px] tracking-[0.02em] text-zinc-500 dark:text-zinc-400">{ro.vin}</p>}
          <p className="mt-2 inline-flex rounded-full bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-800 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-800">
            <span className="mr-1 text-zinc-500">{t(language, 'parts', 'Parts')}</span>{partsProgress(ro, language)}
          </p>
          {recentUpdate && (
            <p className="mt-2 line-clamp-2 rounded-2xl bg-blue-50 px-2.5 py-2 text-[12px] leading-snug text-blue-900 ring-1 ring-blue-100 dark:bg-blue-500/10 dark:text-blue-100 dark:ring-blue-400/20">
              <span className="font-semibold text-blue-600 dark:text-blue-300">{recentUpdate.label}</span> {recentUpdate.text}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {status && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${phaseTone(ro.status)}`}>
              {statusLabel(language, ro.status, status.label)}
            </span>
          )}
          {eta && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${dueTone(eta)}`}>
              {t(language, 'due', 'Due')} {fmtDate(eta)}
            </span>
          )}
        </div>
      </div>

      {sortedTasks.length > 0 && (
      <div className="mt-4 rounded-2xl bg-zinc-50/90 p-2 ring-1 ring-zinc-200 dark:bg-zinc-950/45 dark:ring-white/10">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {showCompleted ? t(language, 'completed', 'Completed') : sortedTasks.length > 1 ? `${sortedTasks.length} ${t(language, 'tasks', 'tasks')}` : t(language, 'task', 'Task')}
          </p>
          {sortedTasks.length > 0 && (
            <p className="text-[11px] font-medium text-zinc-500">{doneCount}/{sortedTasks.length} {t(language, 'done', 'done')}</p>
          )}
        </div>
        <div className="space-y-1.5">
          {visibleTasks.length > 0 && (
            visibleTasks.map(task => (
              <TaskRow key={task.id} task={task} onCycle={onCycleTask} language={language} />
            ))
          )}
          {completedTasks.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDoneTasks(prev => !prev)}
              className="flex w-full items-center justify-between rounded-xl bg-emerald-50/45 px-2.5 py-2 text-left text-[12px] font-semibold text-emerald-700 ring-1 ring-emerald-200/60 transition active:scale-[0.99] dark:bg-white/[0.025] dark:text-emerald-200 dark:ring-white/10"
            >
              <span>{t(language, 'completed', 'Completed')} {doneCount}/{sortedTasks.length}</span>
              <span className="text-[11px] text-emerald-500 dark:text-emerald-300">{showDoneTasks ? 'Hide' : 'Show'}</span>
            </button>
          )}
          {completedTasks.length > 0 && showDoneTasks && (
            completedTasks.map(task => (
              <TaskRow key={task.id} task={task} onCycle={onCycleTask} language={language} />
            ))
          )}
          {activeTasks.length === 0 && completedTasks.length === 0 && (
            <div className="rounded-xl px-2.5 py-3 text-[12px] text-zinc-500">
              {showCompleted ? t(language, 'noCompletedTask', 'No completed task yet') : t(language, 'noActiveTask', 'No active task assigned')}
            </div>
          )}
        </div>
      </div>
      )}

      {(flags.needsParts || flags.suppDamage) && (
        <div className="mt-3 flex justify-end gap-1.5">
          <ExceptionChip active={flags.needsParts}>Parts notified</ExceptionChip>
          <ExceptionChip active={flags.suppDamage}>Estimator notified</ExceptionChip>
        </div>
      )}
    </article>
  )
}

function QuickDrawer({ ro, onClose, onToggleFlag }) {
  if (!ro) return null
  const flags = ro.workerFlags || {}
  return (
    <div className="fixed inset-x-3 bottom-[4.75rem] z-40 mx-auto max-w-md rounded-3xl border border-zinc-200/80 bg-white/90 p-3 shadow-2xl shadow-zinc-400/35 backdrop-blur-2xl dark:border-zinc-800 dark:bg-zinc-950/95 dark:shadow-black/60 md:left-auto md:right-6 md:w-[26rem]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium text-zinc-500">Quick action</p>
          <p className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">RO#{ro.roNumber}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 transition hover:text-zinc-900 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-100"
          aria-label="Minimize quick action"
        >
          <IconChevron />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onToggleFlag(ro, 'needsParts')}
          className={`rounded-2xl px-3 py-3 text-sm font-semibold transition active:scale-[0.98] ${
            flags.needsParts
              ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20'
              : 'bg-zinc-100/85 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-950/70 dark:text-zinc-300 dark:ring-white/10'
          }`}
        >
          Needs parts
        </button>
        <button
          type="button"
          onClick={() => onToggleFlag(ro, 'suppDamage')}
          className={`rounded-2xl px-3 py-3 text-sm font-semibold transition active:scale-[0.98] ${
            flags.suppDamage
              ? 'bg-rose-100 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-400/20'
              : 'bg-zinc-100/85 text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-950/70 dark:text-zinc-300 dark:ring-white/10'
          }`}
        >
          Supp Damage
        </button>
      </div>
    </div>
  )
}

function MiniGib({ text, selectedRo, onExpand, onPhoto, photos, transcribing, uploading, busy }) {
  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-3xl border border-zinc-200/80 bg-white/80 p-2 shadow-2xl shadow-black/15 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/90 dark:shadow-black/70 md:left-auto md:right-6 md:w-[26rem]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onExpand}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100/95 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900/95 dark:text-zinc-400 dark:ring-white/10"
          aria-label="Voice update"
        >
          {transcribing ? (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
          ) : <IconMic />}
        </button>
        <button
          type="button"
          onClick={onExpand}
          disabled={busy}
          className="min-w-0 flex-1 truncate bg-transparent px-1 text-left text-sm text-zinc-500 focus:outline-none dark:text-zinc-500"
        >
          {text || 'Type RO# update...'}
        </button>
        <button
          type="button"
          onClick={onPhoto}
          disabled={busy}
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100/95 text-zinc-500 ring-1 ring-zinc-200 transition hover:text-zinc-900 dark:bg-zinc-900/95 dark:text-zinc-400 dark:ring-white/10 dark:hover:text-zinc-100"
          aria-label="Upload photo"
        >
          <IconCamera />
          {photos.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
              {photos.length}
            </span>
          )}
        </button>
        {(text.trim() || photos.length > 0) && (
          <button
            type="button"
            onClick={onExpand}
            disabled={busy}
            className="h-10 shrink-0 rounded-2xl bg-blue-500 px-3 text-xs font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {uploading ? 'Uploading' : 'Review'}
          </button>
        )}
      </div>
    </div>
  )
}

function WorkerGibComposer({ open, text, setText, onSubmit, onClose, onListen, onPhoto, onClearPhoto, onCancelPending, pending, photos, listening, transcribing, uploading, busy }) {
  const inputRef = useRef(null)
  const [previewPhoto, setPreviewPhoto] = useState(null)
  const canSubmit = Boolean(text.trim() || photos.length)
  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [open])
  if (!open) return null
  const closePreview = () => setPreviewPhoto(null)
  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-zinc-950/20 px-3 pb-3 backdrop-blur-sm dark:bg-black/45">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
        className="w-full max-w-lg rounded-[2rem] border border-zinc-200/80 bg-white/90 p-4 shadow-2xl shadow-black/20 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/90 dark:shadow-black/70"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Worker update</p>
            <p className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">Type an RO# or describe the job</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10"
            aria-label="Close composer"
          >
            x
          </button>
        </div>

        {pending && (
          <div className="mb-2 rounded-[1.15rem] border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-zinc-900 dark:text-zinc-100">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-300">Review update</p>
              <p className="mt-0.5 text-sm font-semibold">RO#{pending.roNumber}</p>
            </div>
            <button
              type="button"
              onClick={onCancelPending}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/55 text-zinc-500 ring-1 ring-zinc-200 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10"
              aria-label="Cancel update"
            >
              ×
            </button>
          </div>
          <div className="space-y-1.5">
            {pending.actions.map((action, index) => (
              <div key={`${action}-${index}`} className="flex items-center gap-2 rounded-xl bg-white/45 px-2.5 py-2 text-[12px] dark:bg-black/20">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-300" />
                <span>{action}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {photos.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {photos.map((photo, index) => (
            <div key={`${photo.name}-${index}`} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl ring-1 ring-white/15">
              <button
                type="button"
                onClick={() => setPreviewPhoto(photo)}
                className="block h-full w-full"
                aria-label={`Preview ${photo.name || 'photo'}`}
              >
                <img src={photo.preview} alt={photo.name} className="h-full w-full object-cover" />
              </button>
              <button
                type="button"
                onClick={() => onClearPhoto(index)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[12px] text-white"
                aria-label="Remove photo"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onPhoto}
            disabled={busy}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-zinc-100/90 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900/90 dark:text-zinc-400 dark:ring-white/10"
            aria-label="Add another photo"
          >
            +
          </button>
        </div>
      )}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/85 p-3"
          onClick={closePreview}
        >
          <div className="relative max-h-full max-w-full" onClick={event => event.stopPropagation()}>
            <img
              src={previewPhoto.preview}
              alt={previewPhoto.name || 'Selected photo'}
              className="max-h-[86vh] max-w-full rounded-2xl object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={closePreview}
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-lg font-semibold text-white ring-1 ring-white/20"
              aria-label="Close photo preview"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={onListen}
          disabled={busy || transcribing}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ring-1 transition ${
            listening ? 'bg-red-500 text-white ring-red-400/30' : transcribing ? 'bg-purple-500/20 text-purple-600 ring-purple-400/25 dark:text-purple-200' : 'bg-zinc-100/95 text-zinc-500 ring-zinc-200 dark:bg-zinc-900/95 dark:text-zinc-400 dark:ring-white/10'
          }`}
          aria-label="Voice update"
        >
          {transcribing ? (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
          ) : <IconMic />}
        </button>
        <textarea
          ref={inputRef}
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={busy}
          placeholder="e.g. 9549 reassembly done, photos attached..."
          rows={3}
          className="max-h-40 min-h-20 min-w-0 flex-1 resize-none rounded-[1.35rem] bg-zinc-100/85 px-3.5 py-3 text-[15px] leading-snug text-zinc-950 placeholder:text-zinc-400 ring-1 ring-zinc-200 focus:outline-none focus:ring-blue-400/40 dark:bg-zinc-900/80 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:ring-white/10"
        />
        <button
          type="button"
          onClick={onPhoto}
          disabled={busy}
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100/95 text-zinc-500 ring-1 ring-zinc-200 transition hover:text-zinc-900 dark:bg-zinc-900/95 dark:text-zinc-400 dark:ring-white/10 dark:hover:text-zinc-100"
          aria-label="Upload photo"
        >
          <IconCamera />
          {photos.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
              {photos.length}
            </span>
          )}
        </button>
        {canSubmit && (
          <button
            type="submit"
            disabled={busy}
            className="h-10 shrink-0 rounded-2xl bg-blue-500 px-3 text-xs font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {uploading ? 'Uploading' : pending ? 'Apply' : 'Review'}
          </button>
        )}
      </div>
      </form>
    </div>
  )
}

export default function MobileWorkerTaskView() {
  const { user, role, displayName, userProfile } = useAuth()
  const language = userProfile?.language || 'english'
  const toast = useToast()
  const fileInputRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const photosRef = useRef([])
  const autoCreatedBodyTaskKeysRef = useRef(new Set())

  const [ros, setRos] = useState([])
  const [tasks, setTasks] = useState([])
  const [employees, setEmployees] = useState([])
  const [selectedRoId, setSelectedRoId] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sheetRoId, setSheetRoId] = useState(null)
  const [filter, setFilter] = useState('today')
  const [quickText, setQuickText] = useState('')
  const [photos, setPhotos] = useState([])
  const [pendingCommand, setPendingCommand] = useState(null)
  const [showPhotoSheet, setShowPhotoSheet] = useState(false)
  const [showCamera, setShowCamera] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [recentUpdates, setRecentUpdates] = useState({})

  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  useEffect(() => {
    setPendingCommand(null)
  }, [quickText, photos.length])

  useEffect(() => {
    return () => {
      photosRef.current.forEach(photo => URL.revokeObjectURL(photo.preview))
      const recorder = mediaRecorderRef.current
      if (recorder?.state === 'recording') {
        recorder.stop()
        recorder.stream.getTracks().forEach(track => track.stop())
      }
    }
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
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

  const authorName = useMemo(() => {
    const found = employees.find(emp => emp.uid === user.uid)
    return found?.name || displayName || user.email || 'Worker'
  }, [displayName, employees, user.email, user.uid])

  useEffect(() => {
    if (loading || role !== ROLES.BODY_MAN || !user.uid) return

    const createMissingBodyTasks = async () => {
      for (const ro of ros) {
        const tmpl = bodyTaskForStatus(ro.status)
        if (!tmpl || ro.status === 'delivered' || ro.assignedBodyMan !== user.uid) continue
        if (hasBodyMainTaskForStatus(ro, tasks)) continue

        const taskId = `auto_body_${ro.id}_${tmpl.phase}`
        if (autoCreatedBodyTaskKeysRef.current.has(taskId)) continue
        autoCreatedBodyTaskKeysRef.current.add(taskId)
        const taskRef = doc(db, 'tasks', taskId)
        const existing = await getDoc(taskRef)
        if (existing.exists()) continue

        await setNewTaskDoc(taskRef, {
          roId:          ro.id,
          roNumber:      ro.roNumber,
          vehicleInfo:   vehicleLine(ro),
          assignedTo:    user.uid,
          assignedToName: authorName,
          assignedBy:    user.uid,
          assignedByName: authorName,
          assignedAt:    serverTimestamp(),
          title:         tmpl.title,
          phase:         tmpl.phase,
          category:      'body',
          taskKind:      'primary',
          autoTriggered: true,
          source:        'status_backfill',
          status:        'pending',
          createdAt:     serverTimestamp(),
          updatedAt:     serverTimestamp(),
        }, { merge: true })
      }
    }

    createMissingBodyTasks().catch(err => {
      toast.warn('Could not sync body tasks: ' + err.message)
    })
  }, [authorName, loading, role, ros, tasks, toast, user.uid])

  const assignedTasks = useMemo(() => {
    return tasks.filter(task => task.assignedTo === user.uid)
  }, [tasks, user.uid])

  const taskRoIds = useMemo(() => new Set(assignedTasks.map(task => task.roId).filter(Boolean)), [assignedTasks])
  const taskRoNumbers = useMemo(() => new Set(assignedTasks.map(task => String(task.roNumber || '')).filter(Boolean)), [assignedTasks])

  const workerRos = useMemo(() => {
    return ros
      .filter(ro => ro.status !== 'delivered')
      .filter(ro => assignedToWorker(ro, user.uid, role) || taskRoIds.has(ro.id) || taskRoNumbers.has(String(ro.roNumber || '')))
      .sort((a, b) => {
        const ea = etaOf(a) || '9999-12-31'
        const eb = etaOf(b) || '9999-12-31'
        if (ea !== eb) return ea.localeCompare(eb)
        return String(a.roNumber || '').localeCompare(String(b.roNumber || ''))
      })
  }, [role, ros, taskRoIds, taskRoNumbers, user.uid])

  const tasksByRo = useMemo(() => {
    const map = new Map()
    const roByNumber = new Map(ros.map(ro => [String(ro.roNumber || ''), ro.id]))
    for (const task of assignedTasks) {
      const roId = task.roId || roByNumber.get(String(task.roNumber || ''))
      if (!roId) continue
      const list = map.get(roId) || []
      list.push(task)
      map.set(roId, list)
    }
    return map
  }, [assignedTasks, ros])

  const visibleTasksByRo = useMemo(() => {
    const map = new Map()
    for (const ro of workerRos) {
      map.set(ro.id, visibleTasksForRo(ro, tasksByRo.get(ro.id) || [], authorName))
    }
    return map
  }, [authorName, tasksByRo, workerRos])

  const filteredRos = useMemo(() => {
    if (filter === 'done') {
      return workerRos.filter(ro => {
        const roTasks = visibleTasksByRo.get(ro.id) || []
        if (isBodyWorkerRo(ro, user.uid, role)) return bodyMainTasksComplete(roTasks)
        return roTasks.length > 0 && roTasks.every(task => task.status === 'completed')
      })
    }
    if (filter === 'waiting') {
      return workerRos.filter(ro => ro.workerFlags?.needsParts || ro.workerFlags?.suppDamage || ro.partsStatus === 'ordered' || ro.partsStatus === 'partially_received')
    }
    if (filter === 'soon') {
      return workerRos.filter(ro => {
        const eta = etaOf(ro)
        if (!eta) return false
        try {
          return differenceInCalendarDays(parseISO(eta), new Date()) <= 2
        } catch {
          return false
        }
      })
    }
    return workerRos.filter(ro => {
      const roTasks = visibleTasksByRo.get(ro.id) || []
      if (isBodyWorkerRo(ro, user.uid, role)) return !bodyMainTasksComplete(roTasks)
      return roTasks.length === 0
        || roTasks.some(task => task.status !== 'completed')
    })
  }, [filter, role, user.uid, visibleTasksByRo, workerRos])

  const selectedRo = useMemo(() => workerRos.find(ro => ro.id === selectedRoId) || workerRos[0] || null, [selectedRoId, workerRos])
  const sheetRo = useMemo(() => workerRos.find(ro => ro.id === sheetRoId) || null, [sheetRoId, workerRos])

  useEffect(() => {
    if (!selectedRoId && workerRos[0]?.id) setSelectedRoId(workerRos[0].id)
  }, [selectedRoId, workerRos])

  const stats = useMemo(() => {
    const dueSoon = workerRos.filter(ro => {
      const eta = etaOf(ro)
      if (!eta) return false
      try {
        return differenceInCalendarDays(parseISO(eta), new Date()) <= 2
      } catch {
        return false
      }
    }).length
    const blocked = workerRos.filter(ro => ro.workerFlags?.needsParts || ro.workerFlags?.suppDamage).length
    const activeDedupedTasks = [...visibleTasksByRo.values()]
      .flat()
      .filter(task => task.status !== 'completed')
      .length
    return { cars: workerRos.length, tasks: activeDedupedTasks, blocked, dueSoon }
  }, [visibleTasksByRo, workerRos])

  const updateRoNote = async (ro, line) => {
    const prevNotes = typeof ro.notes === 'string' ? ro.notes : ''
    await updateRoDoc(doc(db, 'ros', ro.id), {
      notes: prevNotes ? `${line}\n${prevNotes}` : line,
      updatedAt: serverTimestamp(),
    })
  }

  const handleCycleTask = async (task) => {
    if (task.status === 'completed') return
    const next = nextTaskStatus(task.status)
    try {
      await updateTaskDoc(doc(db, 'tasks', task.id), {
        status: next,
        startedAt: next === 'in_progress' ? serverTimestamp() : task.startedAt || null,
        completedAt: next === 'completed' ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      })
      const ro = workerRos.find(item => item.id === task.roId)
      if (ro) {
        const timestamp = format(new Date(), 'MM/dd h:mm a')
        const label = next === 'completed'
          ? `completed task: ${compactTaskTitle(task)}. Completion date: ${timestamp}.`
          : next === 'in_progress'
          ? `started task: ${compactTaskTitle(task)}.`
          : `reopened task: ${compactTaskTitle(task)}.`
        await updateRoNote(ro, makeNote(authorName, label))
      }
    } catch (err) {
      toast.error('Task update failed: ' + err.message)
    }
  }

  const handleSelectRo = (roId) => {
    setSelectedRoId(roId)
    setPendingCommand(null)
    setSheetRoId(roId)
  }

  const createFlagTask = async (ro, flag) => {
    const needsParts = flag === 'needsParts'
    const assignedTo = needsParts
      ? (ro.assignedPartsManager || roleFallbackAssignee(employees, [ROLES.PARTS_MANAGER, ...MANAGER_ROLES]))
      : (ro.assignedEstimator || roleFallbackAssignee(employees, [ROLES.ESTIMATOR, ...MANAGER_ROLES]))

    await createTaskDoc(collection(db, 'tasks'), {
      roId: ro.id,
      roNumber: ro.roNumber,
      vehicleInfo: vehicleLine(ro),
      assignedTo,
      assignedBy: user.uid,
      assignedByName: authorName,
      assignedAt: serverTimestamp(),
      autoTriggered: true,
      source: 'worker',
      status: 'pending',
      priority: 'high',
      category: needsParts ? 'parts' : 'supplement',
      title: needsParts ? 'Review parts issue' : 'Review supplement damage',
      description: `Worker flagged ${needsParts ? 'needs parts' : 'supplement damage'} on RO#${ro.roNumber}.`,
      createdAt: serverTimestamp(),
    })
  }

  const handleToggleFlag = async (ro, flag) => {
    const current = Boolean(ro.workerFlags?.[flag])
    const next = !current
    const needsParts = flag === 'needsParts'
    const note = next
      ? makeNote(authorName, needsParts ? 'Needs parts flagged from mobile work view.' : 'Supplement damage flagged from mobile work view.')
      : makeNote(authorName, needsParts ? 'Needs parts flag cleared.' : 'Supplement damage flag cleared.')

    try {
      await updateRoDoc(doc(db, 'ros', ro.id), {
        [`workerFlags.${flag}`]: next,
        [`workerFlags.${flag}By`]: next ? user.uid : null,
        [`workerFlags.${flag}ByName`]: next ? authorName : null,
        [`workerFlags.${flag}At`]: next ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
      })
      await updateRoNote(ro, note)
      if (next) await createFlagTask(ro, flag)
      toast.success(next ? (needsParts ? 'Parts manager notified' : 'Estimator notified') : 'Flag cleared')
    } catch (err) {
      toast.error('Update failed: ' + err.message)
    }
  }

  const findRoForQuickText = () => {
    const match = quickText.match(/#?\b(\d{4,6})\b/)
    if (match) {
      const found = workerRos.find(ro => String(ro.roNumber) === match[1]) || ros.find(ro => String(ro.roNumber) === match[1])
      if (found) return found
    }
    return selectedRo
  }

  const updateTaskStatusFromWorker = async (task, next, ro, commandText, options = {}) => {
    if (!task || task.status === next) return ''
    await updateTaskDoc(doc(db, 'tasks', task.id), {
      status: next,
      startedAt: next === 'in_progress' ? serverTimestamp() : task.startedAt || null,
      completedAt: next === 'completed' ? serverTimestamp() : null,
      updatedAt: serverTimestamp(),
    })
    const timestamp = format(new Date(), 'MM/dd h:mm a')
    const label = next === 'completed'
      ? `completed task: ${compactTaskTitle(task)}. Completion date: ${timestamp}.`
      : `started task: ${compactTaskTitle(task)}.`
    if (!options.skipNote) await updateRoNote(ro, makeNote(authorName, commandText ? `${label} Note: ${commandText}` : label))
    return label
  }

  const compressPhoto = async (file) => {
    const blob = await compressImageFile(file)
    return blob ? { blob, name: file.name, preview: URL.createObjectURL(blob) } : null
  }

  const uploadOnePhoto = (sRef, blob) => new Promise((resolve, reject) => {
    const task = uploadBytesResumable(sRef, blob, { contentType: 'image/jpeg' })
    task.on('state_changed', null, reject, () => resolve(task.snapshot))
  })

  const resolvePhotoLabel = (text, idx) => {
    const padded = String(idx + 1).padStart(2, '0')
    const isDefault = !text.trim() || /\b(ip|in\s*progress)\b/i.test(text.trim())
    if (isDefault) return `Rpr photo_${padded}`
    const clean = text.trim().slice(0, 30).replace(/[^\w\s-]/g, '').trim()
    return photos.length > 1 ? `${clean}_${padded}` : clean
  }

  const uploadQueuedPhotos = async (ro, noteText, options = {}) => {
    if (!photos.length) return { count: 0, note: '' }
    setUploading(true)
    const now = new Date().toISOString()
    const ts = Date.now()
    const attachments = []
    for (let idx = 0; idx < photos.length; idx += 1) {
      const photo = photos[idx]
      const label = resolvePhotoLabel(noteText, idx)
      const slug = label.replace(/\s+/g, '_').toLowerCase()
      const path = `ros/${ro.id}/attachments/${ts}_${slug}.jpg`
      const ref = storageRef(storage, path)
      await uploadOnePhoto(ref, photo.blob)
      const url = await getDownloadURL(ref)
      attachments.push({
        url,
        name: `${slug}.jpg`,
        label,
        type: 'image',
        uploadedAt: now,
        uploadedBy: user.uid,
        uploadedByName: authorName,
      })
    }
    await updateRoDoc(doc(db, 'ros', ro.id), {
      attachments: arrayUnion(...attachments),
      updatedAt: serverTimestamp(),
    })
    const note = `uploaded ${photos.length} photo${photos.length === 1 ? '' : 's'}: ${attachments.map(a => a.label).join(', ')}.`
    if (!options.skipNote) await updateRoNote(ro, makeNote(authorName, note))
    photos.forEach(photo => URL.revokeObjectURL(photo.preview))
    setPhotos([])
    setUploading(false)
    return { count: attachments.length, note }
  }

  const buildWorkerConfirmation = (ro, text) => {
    const roTasks = visibleTasksByRo.get(ro.id) || []
    const command = parseWorkerCommand(text)
    const task = text ? chooseTaskForCommand(roTasks, text) : null
    const actions = []
    if (command.wantsComplete && task) actions.push(`Complete task: ${compactTaskTitle(task)}`)
    else if (command.wantsStart && task) actions.push(`Start task: ${compactTaskTitle(task)}`)
    else if ((command.wantsComplete || command.wantsStart) && !task) actions.push('Add note: task not matched')
    if (command.wantsNeedsParts && !ro.workerFlags?.needsParts) actions.push('Flag: Needs parts')
    if (command.wantsSuppDamage && !ro.workerFlags?.suppDamage) actions.push('Flag: Supplement damage')
    if (photos.length) actions.push(`Upload ${photos.length} worker progress photo${photos.length === 1 ? '' : 's'}`)
    if (text && actions.length === 0) actions.push(`Add note: ${text}`)
    return {
      roId: ro.id,
      roNumber: ro.roNumber,
      text,
      actions,
    }
  }

  const handleQuickSubmit = async () => {
    const text = quickText.trim()
    if ((!text && photos.length === 0) || busy) return
    const ro = findRoForQuickText()
    if (!ro) {
      toast.warn('Select an RO or include the RO number')
      return
    }
    if (!pendingCommand) {
      setPendingCommand(buildWorkerConfirmation(ro, text))
      setSelectedRoId(ro.id)
      return
    }
    setBusy(true)
    try {
      const roTasks = visibleTasksByRo.get(ro.id) || []
      const command = parseWorkerCommand(text)
      const task = text ? chooseTaskForCommand(roTasks, text) : null
      const actions = []
      const noteLines = []

      if (command.wantsComplete && task) {
        const label = await updateTaskStatusFromWorker(task, 'completed', ro, text, { skipNote: true })
        if (label) noteLines.push(text ? `${label} Note: ${text}` : label)
        actions.push(`completed ${compactTaskTitle(task)}`)
      } else if (command.wantsStart && task) {
        const label = await updateTaskStatusFromWorker(task, 'in_progress', ro, text, { skipNote: true })
        if (label) noteLines.push(text ? `${label} Note: ${text}` : label)
        actions.push(`started ${compactTaskTitle(task)}`)
      }

      if (command.wantsNeedsParts && !ro.workerFlags?.needsParts) {
        await updateRoDoc(doc(db, 'ros', ro.id), {
          'workerFlags.needsParts': true,
          'workerFlags.needsPartsAt': new Date().toISOString(),
          'workerFlags.needsPartsBy': user.uid,
          'workerFlags.needsPartsByName': authorName,
          updatedAt: serverTimestamp(),
        })
        await createFlagTask(ro, 'needsParts')
        noteLines.push('Needs parts flagged from mobile worker GIB.')
        actions.push('needs parts')
      }
      if (command.wantsSuppDamage && !ro.workerFlags?.suppDamage) {
        await updateRoDoc(doc(db, 'ros', ro.id), {
          'workerFlags.suppDamage': true,
          'workerFlags.suppDamageAt': new Date().toISOString(),
          'workerFlags.suppDamageBy': user.uid,
          'workerFlags.suppDamageByName': authorName,
          updatedAt: serverTimestamp(),
        })
        await createFlagTask(ro, 'suppDamage')
        noteLines.push('Supplement damage flagged from mobile worker GIB.')
        actions.push('supp damage')
      }

      const uploaded = await uploadQueuedPhotos(ro, text, { skipNote: true })
      if (uploaded.count) {
        noteLines.push(uploaded.note)
        actions.push(`${uploaded.count} photo${uploaded.count === 1 ? '' : 's'}`)
      }

      if (text && actions.length === 0) {
        noteLines.push(text)
        actions.push('note')
      }
      if (noteLines.length) {
        const prevNotes = typeof ro.notes === 'string' ? ro.notes : ''
        const newNotes = noteLines.map(line => makeNote(authorName, line)).join('\n')
        await updateRoDoc(doc(db, 'ros', ro.id), {
          notes: prevNotes ? `${newNotes}\n${prevNotes}` : newNotes,
          updatedAt: serverTimestamp(),
        })
      }

      setRecentUpdates(prev => ({
        ...prev,
        [ro.id]: { label: 'Just now', text: actions.join(' · ') || text, at: Date.now() },
      }))
      setQuickText('')
      setPendingCommand(null)
      setSelectedRoId(ro.id)
      setComposerOpen(false)
      toast.success(`Saved to RO#${ro.roNumber}`)
    } catch (err) {
      toast.error('Quick update failed: ' + err.message)
    } finally {
      setBusy(false)
      setUploading(false)
    }
  }

  const handleListen = async () => {
    if (listening) {
      setListening(false)
      const recorder = mediaRecorderRef.current
      if (!recorder) return
      const blob = await new Promise(resolve => {
        recorder.onstop = () => resolve(new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
        recorder.stop()
        recorder.stream.getTracks().forEach(track => track.stop())
      })
      if (!blob || blob.size < 1000) return
      setTranscribing(true)
      try {
        const transcript = await transcribeWithWhisper(blob)
        if (transcript.trim()) setQuickText(prev => prev.trimEnd() ? `${prev.trimEnd()} ${transcript.trim()}` : transcript.trim())
      } catch (err) {
        toast.warn(err.message === 'NO_OPENAI_KEY' ? 'OpenAI key is needed for voice input' : `Transcription failed: ${err.message}`)
      } finally {
        setTranscribing(false)
      }
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      recorder.ondataavailable = event => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data)
      }
      recorder.start(250)
      mediaRecorderRef.current = recorder
      setListening(true)
    } catch {
      toast.warn('Microphone access denied')
    }
  }

  const handlePhotoSelect = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length || busy) return
    setBusy(true)
    try {
      const compressed = await Promise.all(files.map(compressPhoto))
      setPhotos(prev => [...prev, ...compressed.filter(Boolean)])
    } catch (err) {
      toast.error('Photo failed: ' + err.message)
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = (index) => setPhotos(prev => {
    URL.revokeObjectURL(prev[index]?.preview)
    return prev.filter((_, i) => i !== index)
  })

  if (loading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-zinc-500">{t(language, 'loading', 'Loading...')}</div>
  }

  return (
    <>
    {showPhotoSheet && (
      <PhotoSheet
        onCamera={() => {
          setShowPhotoSheet(false)
          setShowCamera(true)
        }}
        onLibrary={() => {
          setShowPhotoSheet(false)
          fileInputRef.current?.click()
        }}
        onClose={() => setShowPhotoSheet(false)}
      />
    )}
    {showCamera && (
      <CameraModal
        onDone={(shots) => {
          setPhotos(prev => [...prev, ...shots])
          setShowCamera(false)
        }}
        onClose={() => setShowCamera(false)}
      />
    )}
    <div className="-mx-4 -my-4 min-h-[calc(100vh-3.5rem)] bg-[#f6f7f9] px-4 pb-28 pt-5 text-zinc-950 dark:bg-[#050608] dark:text-zinc-100 md:-my-6 md:rounded-[2rem] md:px-6 md:pb-32 md:pt-6">
      <div className="mx-auto max-w-md md:max-w-2xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-zinc-950 dark:text-white">{t(language, 'myWork', 'My Work')}</h1>
            <p className="mt-1 text-[13px] text-zinc-500">
              {displayName || 'Worker'} · {format(new Date(), 'EEEE, MMM d')}
            </p>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-500/20 text-sm font-semibold text-blue-100 ring-1 ring-blue-400/30">
            {(displayName || user.email || 'ME').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
          </div>
        </header>

        <section className="mt-5 grid grid-cols-3 gap-2">
          <StatCard number={stats.cars} label={t(language, 'cars', 'cars')} />
          <StatCard number={stats.tasks} label={t(language, 'tasks', 'tasks')} />
          <StatCard number={stats.blocked} label={t(language, 'needsManager', 'needs manager')} />
        </section>

        <section className="mt-4 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[
            ['today', t(language, 'active', 'Active')],
            ['soon', `${t(language, 'dueSoon', 'Due soon')} ${stats.dueSoon}`],
            ['waiting', t(language, 'waitingOnMe', 'Waiting on me')],
            ['done', t(language, 'done', 'Done')],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                filter === key
                  ? 'bg-blue-500 text-white'
                  : 'bg-white/80 text-zinc-600 shadow-sm shadow-zinc-200/60 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-black/20 dark:ring-zinc-800'
              }`}
            >
              {label}
            </button>
          ))}
        </section>

        <section className="mt-5">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, 'myRos', 'My ROs')}</h2>
            <p className="text-[12px] text-zinc-500">{t(language, 'assignedWorkOnly', 'assigned work only')}</p>
          </div>
          {filteredRos.length === 0 ? (
            <div className="rounded-3xl border border-zinc-200 bg-white/70 px-4 py-8 text-center text-sm text-zinc-500 shadow-sm shadow-zinc-200/60 dark:border-zinc-800 dark:bg-zinc-950/70 dark:shadow-black/20">
              {t(language, 'noRos', 'No ROs in this view.')}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRos.map(ro => (
                <ROCard
                  key={ro.id}
                  ro={ro}
                  tasks={visibleTasksByRo.get(ro.id) || []}
                  selected={selectedRo?.id === ro.id}
                  onSelect={handleSelectRo}
                  onCycleTask={handleCycleTask}
                  recentUpdate={recentUpdates[ro.id]}
                  showCompleted={filter === 'done'}
                  language={language}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <QuickDrawer
        ro={drawerOpen ? selectedRo : null}
        onClose={() => setDrawerOpen(false)}
        onToggleFlag={handleToggleFlag}
      />
      <MobileROSheet ro={sheetRo} language={language} onClose={() => setSheetRoId(null)} />

      <MiniGib
        text={quickText}
        selectedRo={selectedRo}
        onExpand={() => setComposerOpen(true)}
        onPhoto={() => setShowPhotoSheet(true)}
        photos={photos}
        transcribing={transcribing}
        uploading={uploading}
        busy={busy}
      />
      <WorkerGibComposer
        open={composerOpen}
        text={quickText}
        setText={setQuickText}
        selectedRo={selectedRo}
        onSubmit={handleQuickSubmit}
        onClose={() => setComposerOpen(false)}
        onListen={handleListen}
        onPhoto={() => setShowPhotoSheet(true)}
        onClearPhoto={removePhoto}
        onCancelPending={() => setPendingCommand(null)}
        pending={pendingCommand}
        photos={photos}
        listening={listening}
        transcribing={transcribing}
        uploading={uploading}
        busy={busy}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handlePhotoSelect}
      />
    </div>
    </>
  )
}
