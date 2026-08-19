/**
 * Pure business logic: task phase → RO status suggestions, and
 * RO status → downstream task templates.
 * All shop-specific overrides are injected via shopConfig.
 */

// Phase → next status mapping
const PHASE_NEXT_STATUS = {
  checkin:    (ro) => ({ nextStatus: 'teardown', noteText: 'Check-in complete. Ready for Teardown.' }),
  teardown:      (ro) => ro.partsStatus === 'all_received'
    ? { nextStatus: 'body_work',      noteText: 'Teardown complete. Parts already received. Ready for body work.' }
    : { nextStatus: 'waiting_parts',  noteText: 'Teardown complete. Waiting on parts — estimator to order.' },
  waiting_parts: (ro) => ({ nextStatus: 'body_work', noteText: 'Parts received. Ready for body work.' }),
  body:       (ro) => ro.needsPaint === false
    ? { nextStatus: 'reassembly',    noteText: 'Body work complete. No paint required. Ready for reassembly.' }
    : { nextStatus: 'body_complete', noteText: 'Body work complete.' },
  paint_prep: (ro) => ({ nextStatus: 'in_paint',       noteText: 'Paint prep complete. Vehicle in paint.' }),
  paint:      (ro) => ({ nextStatus: 'paint_complete', noteText: 'Paint complete.' }),
  reassembly: (ro) => ro.needsSublet === false
    ? { nextStatus: 'detail', noteText: 'Reassembly complete. No sublet needed. Ready for QC/Detail.' }
    : { nextStatus: 'sublet', noteText: 'Reassembly complete. Ready for Sublet.' },
  sublet:     (ro) => ({ nextStatus: 'detail', noteText: 'Sublet complete.' }),
  detail:     (ro) => ({ nextStatus: 'ready',  noteText: 'QC/Detail complete. Vehicle ready for pickup.' }),
}

// Status trigger check: which phase tasks must ALL be complete to show the promotion prompt
export const STATUS_PHASE_TRIGGER = {
  checked_in:    'checkin',
  teardown:      'teardown',
  waiting_parts: 'waiting_parts',
  body_work:     'body',
  paint_prep:    'paint_prep',
  in_paint:      'paint',
  reassembly:    'reassembly',
  sublet:        'sublet',
  detail:        'detail',
}

/**
 * Given the phase of just-completed tasks and the current RO doc,
 * returns suggested next status and note text, or null if no promotion.
 *
 * @param {string} completedPhase - the phase of the task(s) just completed
 * @param {object} roData - current RO Firestore document data
 * @returns {{ nextStatus: string, noteText: string } | null}
 */
export function getSuggestedNextStatus(completedPhase, roData) {
  const fn = PHASE_NEXT_STATUS[completedPhase]
  if (!fn) return null
  return fn(roData)
}

function paintPrimaryTasks(roData, options = {}) {
  return [
    {
      title:          'Paint Prep',
      phase:          'paint_prep',
      category:       'paint',
      taskKind:       'primary',
      assignedToUid:  roData.assignedPaintHelper || null,
      assignedToRole: roData.assignedPaintHelper ? null : 'paint_helper',
      setRoField:     'assignedPaintHelper',
      statusBackfill: options.statusBackfill || false,
    },
    {
      title:          'Paint',
      phase:          'paint',
      category:       'paint',
      taskKind:       'primary',
      assignedToUid:  roData.assignedPainter || null,
      assignedToRole: roData.assignedPainter ? null : 'painter',
      noAssigneeNote: roData.assignedPainter ? null : 'No painter assigned. Please assign a painter.',
      statusBackfill: options.statusBackfill || false,
    },
  ]
}

// Downstream task templates keyed by the status the RO just moved INTO
const DOWNSTREAM_TASK_RULES = {
  teardown: (roData) => [{
    title:         'Teardown & process repair',
    phase:         'teardown',
    assignedToUid: roData.assignedBodyMan || null,
    assignedToRole: roData.assignedBodyMan ? null : 'body_man',
  }],

  body_complete: (roData) => {
    if (roData.needsPaint === false) return []
    return paintPrimaryTasks(roData)
  },

  paint_prep: (roData) => {
    if (roData.needsPaint === false) return []
    return paintPrimaryTasks(roData, { statusBackfill: true })
  },

  in_paint: (roData) => {
    if (roData.needsPaint === false) return []
    return paintPrimaryTasks(roData, { statusBackfill: true })
  },

  paint_complete: (roData) => [{
    title:         'Reassembly',
    phase:         'reassembly',
    assignedToUid: roData.assignedBodyMan || null,
    assignedToRole: roData.assignedBodyMan ? null : 'body_man',
  }],

  // Covers the !needsPaint shortcut path: body work complete → straight to reassembly
  reassembly: (roData) => [{
    title:         'Reassembly',
    phase:         'reassembly',
    assignedToUid: roData.assignedBodyMan || null,
    assignedToRole: roData.assignedBodyMan ? null : 'body_man',
  }],

  sublet: (roData) => [{
    title:         'Sublet coordination (AC / 4WA / Calibration / Clear Film)',
    phase:         'sublet',
    assignedToUid: null,
    assignedToRole: 'production_manager',
  }],

  body_work: (roData) => [{
    title:         'Repair',
    phase:         'body',
    assignedToUid: roData.assignedBodyMan || null,
    assignedToRole: roData.assignedBodyMan ? null : 'body_man',
  }],

  detail: (roData) => [
    {
      title:          'QC inspection',
      phase:          'detail',
      assignedToUid:  null,
      assignedToRole: 'production_manager',
    },
    {
      title:          'Final delivery prep',
      phase:          'detail',
      assignedToUid:  roData.assignedEstimator || null,
      assignedToRole: roData.assignedEstimator ? null : 'estimator',
    },
  ],
}

/**
 * Given a new RO status and the RO doc, returns task template objects to create.
 * Callers are responsible for writing to Firestore (addDoc with serverTimestamp).
 *
 * @param {string} newStatus - the status the RO just transitioned to
 * @param {object} roData - current RO Firestore document data (id, roNumber, vehicleInfo, etc.)
 * @returns {Array<{title, phase, assignedToUid, assignedToRole, noAssigneeNote}>}
 */
export function getDownstreamTasks(newStatus, roData) {
  const fn = DOWNSTREAM_TASK_RULES[newStatus]
  if (!fn) return []
  return fn(roData)
}
