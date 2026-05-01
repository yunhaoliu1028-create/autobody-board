// ─── Roles ────────────────────────────────────────────────────────────────────
export const ROLES = {
  SHOP_MANAGER:       'shop_manager',
  PRODUCTION_MANAGER: 'production_manager',
  ESTIMATOR:          'estimator',
  BODY_MAN:           'body_man',
  PAINTER:            'painter',
  PAINT_HELPER:       'paint_helper',
  PARTS_MANAGER:      'parts_manager',
}

export const ROLE_LABELS = {
  shop_manager:       'Shop Manager',
  production_manager: 'Production Manager',
  estimator:          'Estimator',
  body_man:           'Body Technician',
  painter:            'Painter',
  paint_helper:       'Paint Helper',
  parts_manager:      'Parts Manager',
}

export const MANAGER_ROLES  = [ROLES.SHOP_MANAGER, ROLES.PRODUCTION_MANAGER]
export const EDIT_RO_ROLES  = [ROLES.SHOP_MANAGER, ROLES.PRODUCTION_MANAGER, ROLES.ESTIMATOR]

// ─── RO Statuses — colors include dark: variants for dark mode ────────────────
export const RO_STATUSES = [
  {
    key: 'checked_in',
    label: 'Checked In',
    color: 'bg-gray-100 text-gray-700 dark:bg-zinc-700 dark:text-zinc-200',
    dot:   'bg-gray-400 dark:bg-zinc-400',
  },
  {
    key: 'teardown',
    label: 'Teardown',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
    dot:   'bg-amber-500 dark:bg-amber-400',
  },
  {
    key: 'waiting_parts',
    label: 'Waiting Parts',
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200',
    dot:   'bg-orange-500 dark:bg-orange-400',
  },
  {
    key: 'body_work',
    label: 'Body Work',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200',
    dot:   'bg-blue-500 dark:bg-blue-400',
  },
  {
    key: 'body_complete',
    label: 'Body Complete',
    color: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/60 dark:text-cyan-200',
    dot:   'bg-cyan-500 dark:bg-cyan-400',
  },
  {
    key: 'paint_prep',
    label: 'Paint Prep',
    color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200',
    dot:   'bg-purple-500 dark:bg-purple-400',
  },
  {
    key: 'in_paint',
    label: 'In Paint',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200',
    dot:   'bg-violet-500 dark:bg-violet-400',
  },
  {
    key: 'paint_complete',
    label: 'Paint Complete',
    color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200',
    dot:   'bg-indigo-500 dark:bg-indigo-400',
  },
  {
    key: 'reassembly',
    label: 'Reassembly',
    color: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
    dot:   'bg-sky-500 dark:bg-sky-400',
  },
  {
    key: 'calibration',
    label: 'Calibration',
    color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
    dot:   'bg-emerald-500 dark:bg-emerald-400',
  },
  {
    key: 'detail',
    label: 'Detail',
    color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-200',
    dot:   'bg-teal-500 dark:bg-teal-400',
  },
  {
    key: 'qc',
    label: 'QC',
    color: 'bg-lime-100 text-lime-800 dark:bg-lime-900/60 dark:text-lime-200',
    dot:   'bg-lime-500 dark:bg-lime-400',
  },
  {
    key: 'ready',
    label: 'Ready for Pickup',
    color: 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-200',
    dot:   'bg-green-500 dark:bg-green-400',
  },
  {
    key: 'delivered',
    label: 'Delivered',
    color: 'bg-gray-100 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400',
    dot:   'bg-gray-300 dark:bg-zinc-500',
  },
]

export const STATUS_MAP = Object.fromEntries(RO_STATUSES.map(s => [s.key, s]))

export const ROLE_STATUS_FILTER = {
  body_man:      ['teardown', 'waiting_parts', 'body_work', 'body_complete'],
  painter:       ['paint_prep', 'in_paint', 'paint_complete'],
  paint_helper:  ['paint_prep', 'in_paint', 'paint_complete'],
  parts_manager: ['checked_in', 'teardown', 'waiting_parts', 'body_work'],
  estimator:     null,
}

// ─── Parts Status ─────────────────────────────────────────────────────────────
export const PARTS_STATUSES = [
  { key: 'not_ordered',        label: 'Not Ordered',        color: 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300'       },
  { key: 'ordered',            label: 'Ordered',            color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200'    },
  { key: 'partially_received', label: 'Partial',            color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
  { key: 'all_received',       label: 'All Received',       color: 'bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200' },
]

// ─── Car Physical Status ──────────────────────────────────────────────────────
// Kept for internal logic; display replaced by DropoffInfo in UI
export const CAR_STATUSES = [
  { key: 'pending_dropoff', label: 'Pending Drop-Off', color: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300', icon: '○' },
  { key: 'car_in_shop',     label: 'Car In Shop',      color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', icon: '●' },
]
export const CAR_STATUS_MAP = Object.fromEntries(CAR_STATUSES.map(s => [s.key, s]))

// ─── Kanban Status Groups ─────────────────────────────────────────────────────
// 6 simplified columns for the Kanban board view
export const STATUS_GROUPS = [
  {
    key:      'PENDING',
    label:    'Pending',
    statuses: ['checked_in', 'teardown', 'waiting_parts'],
    color:    'bg-gray-100 dark:bg-zinc-700/50',
    header:   'text-gray-600 dark:text-zinc-300',
    accent:   'border-gray-300 dark:border-zinc-600',
  },
  {
    key:      'BODY',
    label:    'Body',
    statuses: ['body_work', 'body_complete'],
    color:    'bg-blue-50 dark:bg-blue-900/30',
    header:   'text-blue-700 dark:text-blue-300',
    accent:   'border-blue-300 dark:border-blue-700',
  },
  {
    key:      'PAINT',
    label:    'Paint',
    statuses: ['paint_prep', 'in_paint', 'paint_complete'],
    color:    'bg-purple-50 dark:bg-purple-900/30',
    header:   'text-purple-700 dark:text-purple-300',
    accent:   'border-purple-300 dark:border-purple-700',
  },
  {
    key:      'REASSEM',
    label:    'Reassembly',
    statuses: ['reassembly', 'calibration', 'detail', 'qc'],
    color:    'bg-sky-50 dark:bg-sky-900/30',
    header:   'text-sky-700 dark:text-sky-300',
    accent:   'border-sky-300 dark:border-sky-700',
  },
  {
    key:      'COMPLETE',
    label:    'Complete',
    statuses: ['ready', 'delivered'],
    color:    'bg-green-50 dark:bg-green-900/30',
    header:   'text-green-700 dark:text-green-300',
    accent:   'border-green-300 dark:border-green-700',
  },
]
