import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import AIInputBox from '../components/AIInputBox'
import { PARTS_STATUSES, STATUS_MAP } from '../constants/roles'

const FILTERS = [
  { key: 'all', label: 'ALL' },
  { key: 'incomplete', label: 'INCOMPLETE' },
  { key: 'complete', label: 'COMPLETE' },
  { key: 'return', label: 'RETURN' },
]

const SORTS = [
  { key: 'due', label: 'Due Date' },
  { key: 'parts', label: 'Parts Status' },
  { key: 'ro', label: 'RO Number' },
]

const PARTS_LABEL = Object.fromEntries(PARTS_STATUSES.map(s => [s.key, s.label]))

function fmtDate(value) {
  if (!value) return '-'
  try {
    const d = parseISO(value)
    return isValid(d) ? format(d, 'M/dd') : value
  } catch {
    return value
  }
}

function daysUntil(value) {
  if (!value) return null
  try {
    const d = parseISO(value)
    return isValid(d) ? differenceInCalendarDays(d, new Date()) : null
  } catch {
    return null
  }
}

function qty(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizeVendorName(value = '') {
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(part => !['dealer', 'dealership', 'oem', 'parts', 'part'].includes(part))
    .join(' ')
    .trim()
}

function vendorGroupKey(order) {
  return normalizeVendorName(order?.vendorFull) || normalizeVendorName(order?.vendor) || 'missing vendor'
}

function isReceiptOnlyOrder(order) {
  return !order?.orderedAt && !order?.eta && receivedQty(order) > 0
}

function orderQty(order) {
  return qty(order?.qty ?? order?.quantity, 0)
}

function receivedQty(order) {
  return qty(order?.qtyReceived ?? order?.receivedQty, 0)
}

function normalizedOrderStatus(order) {
  if (order?.status === 'partially_received') return 'partial'
  return order?.status || 'ordered'
}

function isOrderReceived(order) {
  const ordered = orderQty(order)
  const received = receivedQty(order)
  return normalizedOrderStatus(order) === 'received' || (ordered > 0 && received >= ordered)
}

function calculatedPartsStatus(orders = [], fallback = 'not_ordered') {
  if (!orders.length) return fallback || 'not_ordered'
  if (orders.every(isOrderReceived)) return 'all_received'
  if (orders.some(order => normalizedOrderStatus(order) === 'partial' || receivedQty(order) > 0)) {
    return 'partially_received'
  }
  return 'ordered'
}

function displayPartsStatus(status) {
  if (status === 'partially_received') return 'Partial Received'
  if (status === 'all_received') return 'All Received'
  if (status === 'ordered') return 'Ordered'
  return statusText(status)
}

function orderEta(order) {
  return order?.eta || null
}

function returnStatus(item) {
  return item?.status || 'pending'
}

function returnReason(item) {
  return String(item?.reason || item?.description || item?.notes || '').toLowerCase()
}

function returnMatchesVendor(item, group) {
  const retKey = normalizeVendorName(item?.vendor)
  if (!retKey) return false
  return retKey === group.key || retKey === normalizeVendorName(group.vendor) || retKey === normalizeVendorName(group.vendorFull)
}

function earliestOrderEta(orders = []) {
  return orders
    .map(orderEta)
    .filter(Boolean)
    .sort()[0] ?? null
}

function etaSortValue(ro, orders) {
  return earliestOrderEta(orders) || ro.eta || ro.cccDateOut || ro.promisedDate || '9999-12-31'
}

function statusText(status) {
  return PARTS_LABEL[status] ?? status?.replace(/_/g, ' ') ?? 'Not ordered'
}

function mergeOrdersByVendor(orders = []) {
  const map = new Map()
  for (const order of orders) {
    const vendor = (order.vendor || '').trim() || 'Missing vendor'
    const key = vendorGroupKey(order)
    const current = map.get(key) ?? {
      key,
      vendor,
      vendorFull: '',
      quantity: 0,
      received: 0,
      eta: null,
      statuses: [],
      orderedQty: 0,
      orderedReceived: 0,
      receiptOnlyQty: 0,
      receiptOnlyReceived: 0,
    }
    if (!current.vendorFull && order.vendorFull) current.vendorFull = order.vendorFull
    if (current.vendor === 'Missing vendor' && vendor !== 'Missing vendor') current.vendor = vendor
    const ordered = orderQty(order)
    const received = Math.min(receivedQty(order), ordered || receivedQty(order))
    if (isReceiptOnlyOrder(order)) {
      current.receiptOnlyQty += ordered
      current.receiptOnlyReceived = Math.max(current.receiptOnlyReceived, received)
    } else {
      current.orderedQty += ordered
      current.orderedReceived += received
    }
    current.statuses.push(normalizedOrderStatus(order))
    if (order.eta && (!current.eta || order.eta < current.eta)) current.eta = order.eta
    map.set(key, current)
  }

  return [...map.values()].map(group => ({
    ...group,
    quantity: group.orderedQty || group.receiptOnlyQty,
    received: group.orderedQty
      ? Math.max(group.orderedReceived, group.receiptOnlyReceived)
      : group.receiptOnlyReceived,
  })).sort((a, b) => {
    const ea = a.eta || '9999-12-31'
    const eb = b.eta || '9999-12-31'
    if (ea !== eb) return ea.localeCompare(eb)
    return a.vendor.localeCompare(b.vendor)
  })
}

function mergeDuplicatePartsOrders(orders = []) {
  const next = [...orders]
  const removeIndexes = new Set()
  let mergedCount = 0

  const groups = new Map()
  orders.forEach((order, index) => {
    const key = vendorGroupKey(order)
    const group = groups.get(key) ?? []
    group.push({ order, index })
    groups.set(key, group)
  })

  for (const group of groups.values()) {
    const orderedRows = group.filter(item => !isReceiptOnlyOrder(item.order) && orderQty(item.order) > 0)
    const receiptRows = group.filter(item => isReceiptOnlyOrder(item.order) && orderQty(item.order) > 0)
    if (!orderedRows.length || !receiptRows.length) continue

    const orderedTotal = orderedRows.reduce((sum, item) => sum + orderQty(item.order), 0)
    for (const receiptItem of receiptRows) {
      const receiptQty = orderQty(receiptItem.order)
      if (receiptQty > orderedTotal) continue

      const target = orderedRows.find(item => orderQty(item.order) >= receiptQty) ?? orderedRows[0]
      const existing = next[target.index]
      const existingQty = orderQty(existing)
      const nextReceived = Math.max(receivedQty(existing), receivedQty(receiptItem.order))
      next[target.index] = {
        ...existing,
        vendorFull: existing.vendorFull || receiptItem.order.vendorFull || '',
        qty: existingQty || receiptQty || null,
        qtyReceived: nextReceived,
        status: existingQty && nextReceived >= existingQty ? 'received' : 'partial',
        receivedAt: existing.receivedAt || receiptItem.order.receivedAt || new Date().toISOString(),
        notes: existing.notes || receiptItem.order.notes || '',
      }
      removeIndexes.add(receiptItem.index)
      mergedCount += 1
    }
  }

  return { orders: next.filter((_, index) => !removeIndexes.has(index)), mergedCount }
}

function progressText(group) {
  if (!group.quantity) return `${group.received}/Missing rcvd`
  return `${group.received}/${group.quantity} rcvd`
}

function receivedText(group) {
  if (!group.quantity) return `Received ${group.received}/Missing`
  return `Received ${group.received}/${group.quantity}`
}

function groupIsFullyReceived(group) {
  return group.quantity > 0 && group.received >= group.quantity
}

function etaClass(days, isMissing = false) {
  if (isMissing) return 'text-xs font-bold text-amber-500 dark:text-amber-300'
  if (days != null && days <= 0) return 'text-xs font-extrabold text-red-600 dark:text-red-400'
  if (days != null && days <= 2) return 'text-xs font-bold text-orange-500 dark:text-orange-300'
  if (days != null && days <= 5) return 'text-xs font-bold text-blue-500 dark:text-blue-300'
  return 'text-xs font-semibold text-gray-500 dark:text-zinc-400'
}

function vendorLabel(group) {
  return group.vendorFull || group.vendor
}

function vendorException(group, returns = []) {
  const pendingReturn = returns.find(item => returnStatus(item) === 'pending' && returnMatchesVendor(item, group))
  if (pendingReturn) {
    const reason = returnReason(pendingReturn)
    if (pendingReturn.needsReplacement || reason.includes('wrong') || reason.includes('exchange')) {
      return { label: 'Exchange', color: 'bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300' }
    }
    return { label: 'Return', color: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' }
  }

  if (groupIsFullyReceived(group)) return null

  if (group.quantity > 0 && group.received > 0 && group.received < group.quantity) {
    return { label: `Short ${group.quantity - group.received}`, color: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300' }
  }
  return null
}

function hasManualPartsSignal(ro) {
  return ro.partsStatus && ro.partsStatus !== 'not_ordered'
}

function displayOrdersFor(ro) {
  const orders = Array.isArray(ro.partsOrders) ? ro.partsOrders : []
  if (orders.length) return orders
  if (hasManualPartsSignal(ro) || ro.status === 'waiting_parts') {
    return [{
      id: 'missing-parts-order',
      vendor: 'Missing vendor',
      vendorFull: '',
      qty: null,
      qtyReceived: 0,
      eta: null,
      status: ro.partsStatus === 'all_received'
        ? 'received'
        : ro.partsStatus === 'partially_received'
        ? 'partial'
        : 'ordered',
    }]
  }
  return []
}

function roFlags(ro, orders, status) {
  const overdue = orders.some(order => {
    const days = daysUntil(orderEta(order))
    return days != null && days < 0 && !isOrderReceived(order)
  })
  const returns = Array.isArray(ro.partsReturns) && ro.partsReturns.some(item => returnStatus(item) === 'pending')
  const done = ro.partsSubtasks || {}
  const repairStage = ['body_work', 'paint_prep'].includes(ro.status)
  const reassemblyStage = ro.status === 'reassembly'
  const delivery = status === 'all_received' && (
    (repairStage && !done.deliveredToRepair) ||
    (reassemblyStage && !done.deliveredToReassembly)
  )
  return {
    overdue,
    partial: status === 'partially_received',
    delivery,
    returns,
    attention: overdue || status === 'partially_received',
  }
}

function partsSummary(vendors) {
  const totalVendors = vendors.length
  const totalQty = vendors.reduce((sum, group) => sum + (group.quantity || 0), 0)
  const totalReceived = vendors.reduce((sum, group) => sum + (group.received || 0), 0)
  const overdueCount = vendors.filter(group => {
    const days = daysUntil(group.eta)
    return days != null && days < 0 && !groupIsFullyReceived(group)
  }).length
  const earliestEta = vendors.map(group => group.eta).filter(Boolean).sort()[0]
  const pieces = [
    `${totalVendors} vendor${totalVendors === 1 ? '' : 's'}`,
    `${totalReceived}/${totalQty || '?'} received`,
  ]
  if (overdueCount > 0) pieces.push(`${overdueCount} overdue`)
  pieces.push(`earliest ETA ${fmtDate(earliestEta)}`)
  return pieces.join(' · ')
}

function derivedNextAction(ro, orders, returns, partsStatus) {
  const done = ro.partsSubtasks || {}
  const pendingReturn = returns.find(item => returnStatus(item) === 'pending')
  if (pendingReturn) {
    const count = qty(pendingReturn.qty ?? pendingReturn.quantity, 1)
    return {
      key: 'return-pending',
      returnId: pendingReturn.id,
      label: `Process return: ${pendingReturn.vendor || 'vendor'} ${count} pc${count === 1 ? '' : 's'}`,
      tone: 'red',
    }
  }

  if (!orders.length) return null

  const allOrdersReady = orders.every(order => {
    const ordered = orderQty(order)
    return ordered > 0 && receivedQty(order) >= ordered
  })

  if (allOrdersReady && (partsStatus !== 'all_received' || !done.verifiedAllReceived)) {
    return {
      key: 'verify',
      label: 'Confirm all parts received',
      done: Boolean(done.verifiedAllReceived),
      tone: 'green',
    }
  }

  if (partsStatus === 'all_received' && ['body_work', 'paint_prep'].includes(ro.status) && !done.deliveredToRepair) {
    return {
      key: 'deliver-repair',
      label: 'Confirm delivered to tech',
      tone: 'blue',
    }
  }

  if (partsStatus === 'all_received' && ro.status === 'reassembly' && !done.deliveredToReassembly) {
    return {
      key: 'deliver-reassembly',
      label: 'Confirm delivered for reassembly',
      tone: 'blue',
    }
  }

  return null
}

function VendorProgress({ group, returns = [], onEdit, canEdit = false }) {
  const etaDays = daysUntil(group.eta)
  const fullyReceived = group.quantity > 0 && group.received >= group.quantity
  const urgentEta = etaDays != null && etaDays <= 0 && !fullyReceived
  const exception = vendorException(group, returns)

  return (
    <div className={`grid ${canEdit ? 'grid-cols-[minmax(96px,1fr)_86px_62px_74px_34px]' : 'grid-cols-[minmax(96px,1fr)_86px_62px_74px]'} items-center gap-2 rounded-md border px-2.5 py-2 dark:bg-zinc-950 ${
      urgentEta ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/25' : 'border-gray-200 bg-white dark:border-zinc-700'
    }`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-gray-900 dark:text-zinc-100">
          <span className="sm:hidden">{group.vendor}</span>
          <span className="hidden sm:inline">{vendorLabel(group)}</span>
        </p>
        {group.eta && (
          <p className={fullyReceived ? 'text-xs font-bold text-emerald-600 dark:text-emerald-300' : etaClass(etaDays)}>
            {fullyReceived ? receivedText(group) : `ETA ${fmtDate(group.eta)}${urgentEta ? ' !' : ''}`}
          </p>
        )}
        {!group.eta && (
          <p className={fullyReceived ? 'text-xs font-bold text-emerald-600 dark:text-emerald-300' : etaClass(null, true)}>
            {fullyReceived ? receivedText(group) : 'ETA Missing'}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {exception && (
          <span className={`inline-flex max-w-full items-center truncate rounded px-2 py-0.5 text-[11px] font-extrabold ${exception.color}`}>
            {exception.label}
          </span>
        )}
      </div>
      <p className="text-xs font-semibold text-gray-600 dark:text-zinc-300">
        {group.quantity ? `${group.quantity} pcs` : 'Qty Missing'}
      </p>
      <p className="shrink-0 text-right text-xs font-bold text-gray-700 dark:text-zinc-200">
        {progressText(group)}
      </p>
      {canEdit && (
        <button
          type="button"
          onClick={() => onEdit(group)}
          className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-500 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-blue-700 dark:hover:text-blue-300"
        >
          Edit
        </button>
      )}
    </div>
  )
}

function ROCard({ ro, authorName }) {
  const orders = displayOrdersFor(ro)
  const returns = Array.isArray(ro.partsReturns) ? ro.partsReturns : []
  const pendingReturns = returns.filter(item => returnStatus(item) === 'pending')
  const partsStatus = calculatedPartsStatus(orders, ro.partsStatus)
  const flags = roFlags(ro, orders, partsStatus)
  const eta = earliestOrderEta(orders) || ro.eta || ro.cccDateOut || ro.promisedDate
  const etaDays = daysUntil(eta)
  const statusMeta = STATUS_MAP[ro.status]
  const vendors = mergeOrdersByVendor(orders)
  const duplicateCleanup = useMemo(() => mergeDuplicatePartsOrders(orders), [orders])
  const nextAction = derivedNextAction(ro, orders, returns, partsStatus)
  const activeVendors = vendors.filter(group => !groupIsFullyReceived(group))
  const receivedVendors = vendors.filter(group => groupIsFullyReceived(group) && !activeVendors.some(active => active.key === group.key))
  const [showReceivedVendors, setShowReceivedVendors] = useState(false)
  const [manualEdit, setManualEdit] = useState(false)
  const visibleVendors = manualEdit || showReceivedVendors ? vendors : activeVendors
  const [warning, setWarning] = useState('')
  const [cleaning, setCleaning] = useState(false)
  const [editingOrder, setEditingOrder] = useState(null)
  const toast = useToast()

  const noteLine = (text) => {
    const stamp = format(new Date(), 'MM/dd HH:mm')
    const prev = typeof ro.notes === 'string' ? ro.notes : ''
    const line = `[${stamp} - ${authorName}] ${text}`
    return prev ? `${line}\n${prev}` : line
  }

  const handleTaskCheck = async (task) => {
    setWarning('')
    const taskKey = typeof task === 'string' ? task : task?.key
    const done = ro.partsSubtasks || {}

    if (taskKey === 'return-pending') {
      const targetReturn = pendingReturns.find(item => item.id === task?.returnId) || pendingReturns[0]
      if (!targetReturn) return
      const nextReturns = returns.map(item => item === targetReturn || item.id === targetReturn.id
        ? {
          ...item,
          status: 'processed',
          processedAt: new Date().toISOString(),
        }
        : item
      )
      await updateDoc(doc(db, 'ros', ro.id), {
        partsReturns: nextReturns,
        notes: noteLine(`Parts return processed: ${targetReturn.vendor || 'vendor'} ${qty(targetReturn.qty ?? targetReturn.quantity, 1)} pc${qty(targetReturn.qty ?? targetReturn.quantity, 1) === 1 ? '' : 's'}.`),
        updatedAt: serverTimestamp(),
      })
      toast.success(`RO#${ro.roNumber} return processed`)
      return
    }

    if (taskKey === 'verify') {
      if (done.verifiedAllReceived) {
        await updateDoc(doc(db, 'ros', ro.id), {
          'partsSubtasks.verifiedAllReceived': false,
          notes: noteLine('Parts manager retracted all-parts-received verification.'),
          updatedAt: serverTimestamp(),
        })
        toast.success(`RO#${ro.roNumber} received-all unchecked`)
        return
      }

      const bad = orders.filter(order => {
        const ordered = orderQty(order)
        return ordered <= 0 || receivedQty(order) < ordered
      })
      if (bad.length) {
        setWarning(`Cannot verify all received: ${bad.map(order => `${order.vendor || 'vendor'} ${receivedQty(order)}/${orderQty(order) || '?'}`).join(', ')}.`)
        return
      }
      const nextOrders = orders.map(order => ({
        ...order,
        qty: orderQty(order),
        qtyReceived: orderQty(order),
        status: 'received',
        receivedAt: order.receivedAt || new Date().toISOString(),
      }))
      await updateDoc(doc(db, 'ros', ro.id), {
        partsOrders: nextOrders,
        partsStatus: 'all_received',
        'partsSubtasks.verifiedAllReceived': true,
        notes: noteLine('Parts manager verified all ordered parts received.'),
        updatedAt: serverTimestamp(),
      })
      toast.success(`RO#${ro.roNumber} parts verified`)
      return
    }

    if (taskKey === 'deliver-repair') {
      if (done.deliveredToRepair) {
        await updateDoc(doc(db, 'ros', ro.id), {
          'partsSubtasks.deliveredToRepair': false,
          notes: noteLine('Parts manager retracted repair-parts delivery.'),
          updatedAt: serverTimestamp(),
        })
        toast.success(`RO#${ro.roNumber} repair delivery unchecked`)
        return
      }

      const updates = {
        'partsSubtasks.deliveredToRepair': true,
        notes: noteLine('Repair parts delivered to body/painter.'),
        updatedAt: serverTimestamp(),
      }
      if (['checked_in', 'teardown', 'waiting_parts'].includes(ro.status)) updates.status = 'body_work'
      await updateDoc(doc(db, 'ros', ro.id), updates)
      toast.success(`RO#${ro.roNumber} repair parts delivered`)
      return
    }

    if (taskKey === 'deliver-reassembly') {
      if (done.deliveredToReassembly) {
        await updateDoc(doc(db, 'ros', ro.id), {
          'partsSubtasks.deliveredToReassembly': false,
          notes: noteLine('Parts manager retracted all-parts delivery.'),
          updatedAt: serverTimestamp(),
        })
        toast.success(`RO#${ro.roNumber} all-parts delivery unchecked`)
        return
      }

      const updates = {
        'partsSubtasks.deliveredToReassembly': true,
        notes: noteLine('All parts delivered.'),
        updatedAt: serverTimestamp(),
      }
      if (!['reassembly', 'sublet', 'detail', 'ready'].includes(ro.status)) updates.status = 'reassembly'
      await updateDoc(doc(db, 'ros', ro.id), updates)
      toast.success(`RO#${ro.roNumber} reassembly parts delivered`)
    }
  }

  const handleMergeDuplicateVendors = async () => {
    if (!duplicateCleanup.mergedCount || cleaning) return
    setCleaning(true)
    setWarning('')
    try {
      const nextStatus = calculatedPartsStatus(duplicateCleanup.orders, ro.partsStatus)
      await updateDoc(doc(db, 'ros', ro.id), {
        partsOrders: duplicateCleanup.orders,
        partsStatus: nextStatus,
        notes: noteLine(`Merged ${duplicateCleanup.mergedCount} duplicate vendor receiving row${duplicateCleanup.mergedCount === 1 ? '' : 's'}.`),
        updatedAt: serverTimestamp(),
      })
      toast.success(`RO#${ro.roNumber} duplicate vendor merged`)
    } catch (err) {
      setWarning(`Could not merge duplicate vendors: ${err.message}`)
    } finally {
      setCleaning(false)
    }
  }

  const startEditOrder = (group) => {
    setWarning('')
    setEditingOrder({
      key: group.key,
      vendor: group.vendor === 'Missing vendor' ? '' : group.vendor,
      vendorFull: group.vendorFull || '',
      qty: group.quantity || '',
      qtyReceived: group.quantity ? Math.min(group.received || 0, group.quantity) : (group.received || ''),
      eta: group.eta || '',
    })
  }

  const toggleManualEdit = () => {
    if (manualEdit) {
      setManualEdit(false)
      setEditingOrder(null)
      return
    }
    setManualEdit(true)
    setShowReceivedVendors(true)
  }

  const setEditingField = (field, value) => {
    setEditingOrder(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const saveOrderEdit = async (event) => {
    event.preventDefault()
    if (!editingOrder) return
    const nextQty = qty(editingOrder.qty, 0)
    const rawReceived = qty(editingOrder.qtyReceived, 0)
    const nextReceived = nextQty ? Math.min(rawReceived, nextQty) : rawReceived
    const nextVendor = editingOrder.vendor.trim() || 'Missing vendor'
    const nextVendorFull = editingOrder.vendorFull.trim()
    const nextEta = editingOrder.eta || null
    const status = nextQty && nextReceived >= nextQty
      ? 'received'
      : nextReceived > 0
      ? 'partial'
      : 'ordered'

    const otherOrders = orders.filter(order => vendorGroupKey(order) !== editingOrder.key)
    const canonicalOrder = {
      vendor: nextVendor,
      vendorFull: nextVendorFull,
      qty: nextQty || null,
      qtyReceived: nextReceived,
      eta: nextEta,
      status,
      orderedAt: orders.find(order => vendorGroupKey(order) === editingOrder.key)?.orderedAt || new Date().toISOString(),
      manuallyAdjustedAt: new Date().toISOString(),
    }
    const nextOrders = [...otherOrders, canonicalOrder]
    const nextStatus = calculatedPartsStatus(nextOrders, ro.partsStatus)

    try {
      await updateDoc(doc(db, 'ros', ro.id), {
        partsOrders: nextOrders,
        partsStatus: nextStatus,
        notes: noteLine(`Parts order corrected: ${vendorLabel({ vendor: nextVendor, vendorFull: nextVendorFull })} ${nextReceived}/${nextQty || '?'} received, ETA ${nextEta ? fmtDate(nextEta) : 'missing'}.`),
        updatedAt: serverTimestamp(),
      })
      setEditingOrder(null)
      toast.success(`RO#${ro.roNumber} parts order updated`)
    } catch (err) {
      setWarning(`Could not update parts order: ${err.message}`)
    }
  }

  return (
    <article className={`overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-zinc-900 ${
      flags.overdue ? 'border-red-300 ring-1 ring-red-100 dark:border-red-800 dark:ring-red-950' : 'border-gray-200 dark:border-zinc-800'
    }`}>
      <div className="border-b border-gray-100 px-3 py-2.5 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/ro/${ro.id}`} className="font-mono text-base font-extrabold text-blue-600 hover:underline dark:text-blue-400">
                #{ro.roNumber}
              </Link>
              <p className="min-w-0 truncate text-sm font-bold text-gray-900 dark:text-zinc-100">
                {ro.vehicle || 'Vehicle missing'}
              </p>
            </div>
            <p className="mt-1 break-all text-xs font-medium text-gray-900 dark:text-zinc-100">
              {ro.vin || '-'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <span className={etaDays != null && etaDays < 0 ? 'rounded px-2 py-0.5 text-[11px] font-bold bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'rounded px-2 py-0.5 text-[11px] font-bold bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-zinc-200'}>
              Due {fmtDate(eta)}
            </span>
            {statusMeta && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusMeta.color}`}>
                {statusMeta.label}
              </span>
            )}
            <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${
              PARTS_STATUSES.find(item => item.key === partsStatus)?.color || 'bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300'
            }`}>
              {displayPartsStatus(partsStatus)}
            </span>
          </div>
        </div>
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-zinc-400">
            <span className={flags.overdue ? 'font-bold text-red-600 dark:text-red-400' : ''}>
              {partsSummary(vendors)}
            </span>
            {flags.delivery && <span className="font-semibold text-blue-600 dark:text-blue-300">Ready to deliver to tech</span>}
            {pendingReturns.length > 0 && <span className="font-semibold text-red-600 dark:text-red-400">{pendingReturns.length} pending return{pendingReturns.length === 1 ? '' : 's'}</span>}
          </div>
          {vendors.length > 0 && (
            <button
              type="button"
              onClick={toggleManualEdit}
              className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-bold transition-colors ${
                manualEdit
                  ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-blue-700 dark:hover:text-blue-300'
              }`}
              title="Manually edit parts order details"
            >
              {manualEdit ? 'Done' : 'Edit parts'}
            </button>
          )}
        </div>
        {duplicateCleanup.mergedCount > 0 && (
          <button
            type="button"
            onClick={handleMergeDuplicateVendors}
            disabled={cleaning}
            className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800 hover:border-amber-400 disabled:opacity-60 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          >
            {cleaning ? 'Merging...' : `Merge ${duplicateCleanup.mergedCount} duplicate vendor`}
          </button>
        )}
      </div>

      {vendors.length > 0 && (
        <div className="space-y-1.5 px-3 py-2.5">
          {manualEdit && (
            <p className="rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/25 dark:text-blue-300">
              Manual correction mode. Use this when GIB-AI parsed a vendor, qty, received count, or ETA incorrectly.
            </p>
          )}
          {visibleVendors.map(group => (
            <VendorProgress
              key={group.key}
              group={group}
              returns={returns}
              onEdit={startEditOrder}
              canEdit={manualEdit}
            />
          ))}
          {receivedVendors.length > 0 && !showReceivedVendors && !manualEdit && (
            <button
              type="button"
              onClick={() => setShowReceivedVendors(true)}
              className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-left text-xs font-bold text-emerald-700 hover:border-emerald-300 dark:border-emerald-900 dark:bg-emerald-950/25 dark:text-emerald-300"
            >
              {receivedVendors.length} received vendor{receivedVendors.length === 1 ? '' : 's'} hidden
            </button>
          )}
          {receivedVendors.length > 0 && showReceivedVendors && !manualEdit && (
            <button
              type="button"
              onClick={() => setShowReceivedVendors(false)}
              className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-left text-xs font-bold text-gray-500 hover:border-gray-300 dark:border-zinc-700 dark:text-zinc-400"
            >
              Hide received vendor{receivedVendors.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {editingOrder && (
        <form onSubmit={saveOrderEdit} className="border-t border-gray-100 px-3 py-3 dark:border-zinc-800">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/25">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300">Edit parts order</p>
              <button
                type="button"
                onClick={() => setEditingOrder(null)}
                className="text-xs font-semibold text-gray-500 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 text-xs font-semibold text-gray-500 dark:text-zinc-400">
                Vendor
                <input
                  value={editingOrder.vendor}
                  onChange={e => setEditingField('vendor', e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  placeholder="Vendor"
                />
              </label>
              <label className="col-span-2 text-xs font-semibold text-gray-500 dark:text-zinc-400">
                Vendor full name
                <input
                  value={editingOrder.vendorFull}
                  onChange={e => setEditingField('vendorFull', e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  placeholder="Optional"
                />
              </label>
              <label className="text-xs font-semibold text-gray-500 dark:text-zinc-400">
                Ordered
                <input
                  type="number"
                  min="0"
                  value={editingOrder.qty}
                  onChange={e => setEditingField('qty', e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="text-xs font-semibold text-gray-500 dark:text-zinc-400">
                Received
                <input
                  type="number"
                  min="0"
                  value={editingOrder.qtyReceived}
                  onChange={e => setEditingField('qtyReceived', e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="col-span-2 text-xs font-semibold text-gray-500 dark:text-zinc-400">
                ETA
                <input
                  type="date"
                  value={editingOrder.eta}
                  onChange={e => setEditingField('eta', e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-bold text-white hover:bg-blue-700"
            >
              Save correction
            </button>
          </div>
        </form>
      )}

      {(nextAction || warning) && (
        <div className="border-t border-gray-100 px-3 py-2.5 dark:border-zinc-800">
          {warning && (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {warning}
            </p>
          )}
          {nextAction && (
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Next action</p>
              <button
                type="button"
                onClick={() => handleTaskCheck(nextAction)}
                className={`flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-80 ${
                  nextAction.tone === 'green'
                    ? 'border-green-200 bg-green-50 text-green-700 hover:border-green-300 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300'
                    : nextAction.tone === 'red'
                    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/25 dark:text-red-300'
                    : 'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300'
                }`}
              >
                <span className="h-4 w-4 shrink-0 rounded-full border border-current bg-white/60 dark:bg-zinc-950/40" />
                <span>{nextAction.label}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export default function PartsManagerView() {
  const { user } = useAuth()
  const [ros, setRos] = useState([])
  const [employees, setEmployees] = useState([])
  const [filter, setFilter] = useState('all')
  const [sortBy, setSortBy] = useState('due')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const rosQuery = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))
    const unsubRos = onSnapshot(rosQuery, snap => {
      setRos(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    const unsubUsers = onSnapshot(collection(db, 'users'), snap => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
    })
    return () => { unsubRos(); unsubUsers() }
  }, [])

  const candidates = useMemo(() => {
    return ros
      .filter(ro => {
        if (ro.status === 'delivered') return false
        const hasOrders = Array.isArray(ro.partsOrders) && ro.partsOrders.length > 0
        const hasReturns = Array.isArray(ro.partsReturns) && ro.partsReturns.length > 0
        return hasOrders || hasReturns || hasManualPartsSignal(ro) || ro.status === 'waiting_parts'
      })
      .map(ro => {
        const orders = displayOrdersFor(ro)
        const partsStatus = calculatedPartsStatus(orders, ro.partsStatus)
        return {
          ro,
          orders,
          partsStatus,
          flags: roFlags(ro, orders, partsStatus),
          eta: etaSortValue(ro, orders),
        }
      })
  }, [ros])

  const counts = useMemo(() => ({
    all: candidates.length,
    incomplete: candidates.filter(item => item.partsStatus !== 'all_received').length,
    complete: candidates.filter(item => item.partsStatus === 'all_received').length,
    return: candidates.filter(item => item.flags.returns).length,
  }), [candidates])

  const visible = useMemo(() => {
    return candidates
      .filter(item => {
        if (filter === 'incomplete') return item.partsStatus !== 'all_received'
        if (filter === 'complete') return item.partsStatus === 'all_received'
        if (filter === 'return') return item.flags.returns
        return true
      })
      .sort((a, b) => {
        if (sortBy === 'ro') return String(a.ro.roNumber || '').localeCompare(String(b.ro.roNumber || ''), undefined, { numeric: true })
        if (sortBy === 'parts') {
          const rank = { partially_received: 0, ordered: 1, not_ordered: 2, all_received: 3 }
          const diff = (rank[a.partsStatus] ?? 9) - (rank[b.partsStatus] ?? 9)
          if (diff) return diff
        }
        if (a.flags.overdue !== b.flags.overdue) return a.flags.overdue ? -1 : 1
        return a.eta.localeCompare(b.eta)
      })
      .map(item => item.ro)
  }, [candidates, filter, sortBy])

  const authorName = useMemo(() => {
    const employee = employees.find(emp => emp.uid === user?.uid)
    return employee?.name || user?.email || 'Parts Manager'
  }, [employees, user])

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-400 dark:text-zinc-600">Loading...</div>
  }

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-950 dark:text-zinc-100">Parts Manager</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-zinc-400">
            Ordered parts, ETA, receiving progress, delivery handoff, and returns.
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-right dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Open ROs</p>
          <p className="text-lg font-extrabold text-gray-900 dark:text-zinc-100">{counts.all}</p>
        </div>
      </div>

      <AIInputBox ros={ros} employees={employees} sourceRole="parts_manager" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`shrink-0 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                filter === item.key
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'
              }`}
            >
              {item.label}
              <span className="ml-2 text-xs opacity-70">{counts[item.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-zinc-400">
          Sort
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm font-semibold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {SORTS.map(item => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400 dark:border-zinc-800 dark:text-zinc-500">
          No ROs match this filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {visible.map(ro => <ROCard key={ro.id} ro={ro} authorName={authorName} />)}
        </div>
      )}
    </div>
  )
}
