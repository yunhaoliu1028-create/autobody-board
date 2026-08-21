import { ROLES } from '../constants/roles'

const BODY_PHASES = new Set(['teardown', 'body', 'body_work', 'reassembly', 'waiting_parts', 'sublet', 'detail'])
const TASK_STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 }
const PAINTER_VISIBLE_STATUSES = new Set(['checked_in', 'teardown', 'waiting_parts', 'body_work', 'body_complete', 'paint_prep', 'in_paint'])

function etaOf(ro) {
  return ro?.eta || ro?.cccDateOut || ro?.promisedDate || null
}

function parsePaintHrs(value) {
  const n = Number.parseFloat(String(value ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function roNeedsPaint(ro) {
  return ro?.needsPaint === true || parsePaintHrs(ro?.paintHrs ?? ro?.refinishTime ?? ro?.refinishHrs) > 0
}

function taskSortVal(task) {
  const status = TASK_STATUS_ORDER[task.status] ?? 1
  const v = task.sortOrder ?? task.createdAt?.toMillis?.() ?? (task.createdAt?.seconds != null ? task.createdAt.seconds * 1000 : 0)
  return status * 1_000_000_000 + v
}

function paintTaskSortVal(task) {
  const phaseOrder = { paint_prep: 0, paint: 1 }
  const primaryRank = isPrimaryPaintTask(task) ? 0 : 1
  const phaseRank = phaseOrder[paintInferredPhase(task)] ?? 2
  return primaryRank * 10_000_000_000 + phaseRank * 1_000_000_000 + taskSortVal(task)
}

function statusRank(status) {
  if (status === 'in_progress') return 3
  if (status === 'pending') return 2
  if (status === 'completed') return 1
  return 0
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

// ---- Bodyman title / dedup ----

function bodyTaskText(task) {
  return `${task.title || ''} ${task.description || ''}`.toLowerCase()
}

function bodyInferredPhase(task) {
  if (task.phase === 'teardown') return 'teardown'
  if (task.phase === 'body' || task.phase === 'body_work') return 'body'
  if (task.phase === 'reassembly') return 'reassembly'
  const text = bodyTaskText(task)
  if (text.includes('teardown') || text.includes('tear down')) return 'teardown'
  if (text.includes('reassembly') || text.includes('reassemble')) return 'reassembly'
  if (/\brepair|body work|process repair\b/i.test(text)) return 'body'
  return ''
}

function isPrimaryBodyTask(task) {
  if (task.taskKind === 'secondary') return false
  return task.taskKind === 'primary' || ['teardown', 'body', 'reassembly'].includes(bodyInferredPhase(task))
}

export function bodyCompactTitle(task) {
  if (task.displayTitle) return task.displayTitle
  if (task.taskKind !== 'secondary') {
    const phase = bodyInferredPhase(task)
    if (phase === 'teardown') return 'Teardown'
    if (phase === 'body') return 'Repair'
    if (phase === 'reassembly') return 'Reassembly'
  }
  const text = bodyTaskText(task)
  if (text.includes('tire') || text.includes('tyre') || text.includes('pressure') || text.includes('tpms')) return 'Tire pressure check'
  if (text.includes('process repair')) return 'Process repair'
  if (text.includes('progress') && text.includes('photo')) return 'Progress photos'
  if (text.includes('photo')) return 'Photos'
  if (text.includes('fitment')) return 'Fitment check'
  if (text.includes('supplement')) return 'Supplement review'
  if (text.includes('paint prep')) return 'Paint prep'
  return task.title || 'Task'
}

function bodyDedupeKey(task) {
  if (isPrimaryBodyTask(task)) return `primary:${bodyInferredPhase(task)}`
  return `${bodyCompactTitle(task).toLowerCase()}:${(task.description || '').toLowerCase()}`
}

function bodyDedupeTasks(list) {
  const map = new Map()
  for (const task of list) {
    const key = bodyDedupeKey(task)
    const current = map.get(key)
    if (!current || statusRank(task.status) > statusRank(current.status) || taskSortVal(task) > taskSortVal(current)) {
      map.set(key, task)
    }
  }
  return [...map.values()].sort((a, b) => paintTaskSortVal(a) - paintTaskSortVal(b))
}

function isGenericBodyTask(task) {
  const title = bodyCompactTitle(task).toLowerCase()
  return title === 'teardown' || title === 'process repair' || title === 'teardown & process repair'
}

function taskLooksLikeBodyAssignment(text) {
  return /\b(teardown|tear\s*down|begin repair|start repair|process repair|body\s*(man|tech|work))\b/i.test(text)
}

function bodyVisibleTasksForRo(ro, tasks, workerName) {
  const legacyCustomTitles = taskAssignmentTitlesFromNotes(ro.notes, workerName)
    .filter(title => !taskLooksLikeBodyAssignment(title))
  let titleIndex = 0
  const decorated = tasks.map(task => {
    if (!legacyCustomTitles.length || !isGenericBodyTask(task)) return task
    const title = legacyCustomTitles[titleIndex++]
    return title ? { ...task, displayTitle: title } : task
  })
  return bodyDedupeTasks(decorated).map(t => t.displayTitle ? t : { ...t, displayTitle: bodyCompactTitle(t) })
}

// ---- Painter title / dedup ----

function paintTaskText(task) {
  return `${task.title || ''} ${task.description || ''}`.toLowerCase()
}

function paintInferredPhase(task) {
  if (task.phase === 'paint_prep') return 'paint_prep'
  if (task.phase === 'paint') return 'paint'
  const text = paintTaskText(task)
  if (text.includes('paint prep') || text.includes('prep')) return 'paint_prep'
  if (text.includes('paint')) return 'paint'
  return ''
}

function isPrimaryPaintTask(task) {
  if (task.taskKind === 'secondary') return false
  return task.taskKind === 'primary' || ['paint_prep', 'paint'].includes(paintInferredPhase(task))
}

export function paintCompactTitle(task) {
  if (task.displayTitle) return task.displayTitle
  if (task.taskKind !== 'secondary') {
    const phase = paintInferredPhase(task)
    if (phase === 'paint_prep') return 'Paint Prep'
    if (phase === 'paint') return 'Paint'
  }
  const text = paintTaskText(task)
  if (text.includes('photo') || text.includes('picture') || text.includes('image')) return 'Photos'
  if (text.includes('color') || text.includes('colour')) return 'Color match'
  if (text.includes('blend')) return 'Blend'
  if (text.includes('mask') || text.includes('masking')) return 'Masking'
  return task.title || 'Task'
}

function paintDedupeKey(task) {
  if (isPrimaryPaintTask(task)) return `primary:${paintInferredPhase(task)}`
  return `${paintCompactTitle(task).toLowerCase()}:${(task.description || '').toLowerCase()}`
}

function paintDedupeTasks(list) {
  const map = new Map()
  for (const task of list) {
    const key = paintDedupeKey(task)
    const current = map.get(key)
    if (!current || statusRank(task.status) > statusRank(current.status) || taskSortVal(task) > taskSortVal(current)) {
      map.set(key, task)
    }
  }
  return [...map.values()].sort((a, b) => taskSortVal(a) - taskSortVal(b))
}

function isGenericPaintTask(task) {
  const title = paintCompactTitle(task).toLowerCase()
  return title === 'paint prep' || title === 'paint' || title === 'paint prep & paint job'
}

function taskLooksLikePaintAssignment(text) {
  return /\b(paint\s*prep|prep\s*paint|paint\s*job|paint\s*work|in\s*paint)\b/i.test(text)
}

function paintVisibleTasksForRo(ro, tasks, workerName) {
  const legacyCustomTitles = taskAssignmentTitlesFromNotes(ro.notes, workerName)
    .filter(title => !taskLooksLikePaintAssignment(title))
  let titleIndex = 0
  const decorated = tasks.map(task => {
    if (!legacyCustomTitles.length || !isGenericPaintTask(task)) return task
    const title = legacyCustomTitles[titleIndex++]
    return title ? { ...task, displayTitle: title } : task
  })
  return paintDedupeTasks(decorated).map(t => t.displayTitle ? t : { ...t, displayTitle: paintCompactTitle(t) })
}

// ---- Shared RO sort ----

function sortByEta(ros) {
  return [...ros].sort((a, b) => {
    const ea = etaOf(a) || '9999-12-31'
    const eb = etaOf(b) || '9999-12-31'
    if (ea !== eb) return ea.localeCompare(eb)
    return String(a.roNumber || '').localeCompare(String(b.roNumber || ''))
  })
}

// ---- Build functions ----

function buildPaintView(tasks, ros, uid, authorName) {
  const paintTeamRoIds = new Set(
    ros.filter(ro => ro.assignedPainter === uid || ro.assignedPaintHelper === uid || roNeedsPaint(ro)).map(ro => ro.id)
  )
  const paintTeamUids = new Set([uid])
  for (const ro of ros) {
    if (ro.assignedPainter === uid || ro.assignedPaintHelper === uid || roNeedsPaint(ro)) {
      if (ro.assignedPainter) paintTeamUids.add(ro.assignedPainter)
      if (ro.assignedPaintHelper) paintTeamUids.add(ro.assignedPaintHelper)
    }
  }
  const assignedTasks = tasks.filter(task => {
    if (BODY_PHASES.has(task.phase)) return false
    if (task.assignedTo === uid) return true
    if (['paint_prep', 'paint'].includes(task.phase) && paintTeamRoIds.has(task.roId)) return true
    if (['paint_prep', 'paint'].includes(task.phase) && paintTeamUids.has(task.assignedTo)) return true
    return false
  })
  const taskRoIds = new Set(assignedTasks.map(t => t.roId).filter(Boolean))
  const taskRoNumbers = new Set(assignedTasks.map(t => String(t.roNumber || '')).filter(Boolean))
  const workerRos = sortByEta(
    ros
      .filter(ro => ro.status !== 'delivered')
      .filter(ro => PAINTER_VISIBLE_STATUSES.has(ro.status))
      .filter(roNeedsPaint)
      .filter(ro => paintTeamRoIds.has(ro.id) || taskRoIds.has(ro.id) || taskRoNumbers.has(String(ro.roNumber || '')))
  )
  const roByNumber = new Map(ros.map(ro => [String(ro.roNumber || ''), ro.id]))
  const tasksByRo = new Map()
  for (const task of assignedTasks) {
    const roId = task.roId || roByNumber.get(String(task.roNumber || ''))
    if (!roId) continue
    const list = tasksByRo.get(roId) || []
    list.push(task)
    tasksByRo.set(roId, list)
  }
  const visibleTasksByRo = new Map()
  for (const ro of workerRos) {
    visibleTasksByRo.set(ro.id, paintVisibleTasksForRo(ro, tasksByRo.get(ro.id) || [], authorName))
  }
  return { workerRos, visibleTasksByRo }
}

function buildBodyView(tasks, ros, uid, authorName) {
  const assignedTasks = tasks.filter(task => task.assignedTo === uid)
  const taskRoIds = new Set(assignedTasks.map(t => t.roId).filter(Boolean))
  const taskRoNumbers = new Set(assignedTasks.map(t => String(t.roNumber || '')).filter(Boolean))
  const workerRos = sortByEta(
    ros
      .filter(ro => ro.status !== 'delivered')
      .filter(ro => ro.assignedBodyMan === uid || taskRoIds.has(ro.id) || taskRoNumbers.has(String(ro.roNumber || '')))
  )
  const roByNumber = new Map(ros.map(ro => [String(ro.roNumber || ''), ro.id]))
  const tasksByRo = new Map()
  for (const task of assignedTasks) {
    const roId = task.roId || roByNumber.get(String(task.roNumber || ''))
    if (!roId) continue
    const list = tasksByRo.get(roId) || []
    list.push(task)
    tasksByRo.set(roId, list)
  }
  const visibleTasksByRo = new Map()
  for (const ro of workerRos) {
    visibleTasksByRo.set(ro.id, bodyVisibleTasksForRo(ro, tasksByRo.get(ro.id) || [], authorName))
  }
  return { workerRos, visibleTasksByRo }
}

/**
 * Returns { workerRos, visibleTasksByRo } matching exactly what the worker sees in their own view.
 * Tasks in visibleTasksByRo are deduped and have displayTitle set.
 */
export function buildWorkerView(tasks, ros, uid, role, authorName) {
  if (role === ROLES.PAINTER || role === ROLES.PAINT_HELPER) {
    return buildPaintView(tasks, ros, uid, authorName)
  }
  if (role === ROLES.BODY_MAN) {
    return buildBodyView(tasks, ros, uid, authorName)
  }
  // Fallback for other roles: simple assignedTo, no dedup
  const assignedTasks = tasks.filter(t => t.assignedTo === uid)
  const taskRoIds = new Set(assignedTasks.map(t => t.roId).filter(Boolean))
  const workerRos = sortByEta(
    ros.filter(ro => ro.status !== 'delivered' && taskRoIds.has(ro.id))
  )
  const tasksByRo = new Map()
  for (const task of assignedTasks) {
    if (!task.roId) continue
    const list = tasksByRo.get(task.roId) || []
    list.push(task)
    tasksByRo.set(task.roId, list)
  }
  const visibleTasksByRo = new Map()
  for (const ro of workerRos) {
    visibleTasksByRo.set(ro.id, (tasksByRo.get(ro.id) || []).sort((a, b) => taskSortVal(a) - taskSortVal(b)))
  }
  return { workerRos, visibleTasksByRo }
}
