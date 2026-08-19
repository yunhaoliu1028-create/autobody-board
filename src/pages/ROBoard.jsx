import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { addDoc, collection, onSnapshot, query, orderBy, doc, updateDoc, serverTimestamp, arrayUnion, getDocs, where } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { StatusBadge, PartsStatusBadge } from '../components/StatusBadge'
import AIInputBox from '../components/AIInputBox'
import RODrawer   from '../components/RODrawer'
import {
  RO_STATUSES, STATUS_MAP, PARTS_STATUSES,
  MANAGER_ROLES, EDIT_RO_ROLES,
  STATUS_GROUPS,
} from '../constants/roles'
import { parseISO, differenceInDays, isValid, format } from 'date-fns'
import { getDownstreamTasks } from '../engine/taskRules'

// ── Change detection ──────────────────────────────────────────────────────────
const PARTS_LABEL = Object.fromEntries(
  (typeof PARTS_STATUSES !== 'undefined' ? PARTS_STATUSES : []).map(p => [p.key, p.label])
)
const DEFAULT_MONTHLY_REPAIR_GOAL = 26000
const EXPECTED_CCC_REPORT_LOCATION = 'CARSTAR SCA COLLISION WALNUT'

function moneyValue(value) {
  if (value == null || value === '') return 0
  const n = Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function moneyFmt(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value || 0)
}

function dateFromAny(value) {
  if (!value) return null
  if (value instanceof Date) return isValid(value) ? value : null
  if (typeof value?.toDate === 'function') {
    const d = value.toDate()
    return isValid(d) ? d : null
  }
  if (typeof value?.seconds === 'number') {
    const d = new Date(value.seconds * 1000)
    return isValid(d) ? d : null
  }
  if (typeof value === 'string') {
    const d = parseISO(value)
    return isValid(d) ? d : null
  }
  return null
}

function deliveredDateOf(ro) {
  const deliveredEntry = [...(ro.changeLog || [])]
    .reverse()
    .find(entry => (
      (entry.type === 'status' || entry.type === 'update_status' || entry.type === 'status_change')
      && String(entry.value || entry.label || '').toLowerCase().includes('delivered')
    ))
  return dateFromAny(ro.cccDeliveredAt) || dateFromAny(ro.deliveredAt) || dateFromAny(deliveredEntry?.at) || dateFromAny(ro.updatedAt)
}

function sameMonth(date, monthDate = new Date()) {
  return Boolean(date)
    && date.getFullYear() === monthDate.getFullYear()
    && date.getMonth() === monthDate.getMonth()
}

function monthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthDateFromValue(value) {
  const [year, month] = String(value || '').split('-').map(Number)
  if (!year || !month) return new Date()
  return new Date(year, month - 1, 1)
}

function shiftMonthValue(value, delta) {
  const d = monthDateFromValue(value)
  d.setMonth(d.getMonth() + delta)
  return monthValue(d)
}

function dateKey(date) {
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function revenueAmountOf(ro) {
  const reportGross = moneyValue(ro.cccDeliveredGrossAmount)
  return reportGross > 0 ? reportGross : moneyValue(ro.totalAmount)
}

function readXmlText(node, tag) {
  return node?.getElementsByTagName(tag)?.[0]?.textContent?.trim() || ''
}

function parseCccMoney(value) {
  const n = Number(String(value || '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function parseCccDeliveredXml(xmlText, selectedMonth, ros) {
  const parser = new DOMParser()
  const docXml = parser.parseFromString(xmlText, 'text/xml')
  if (docXml.getElementsByTagName('parsererror').length) {
    throw new Error('Could not read this XML file.')
  }

  const selectedMonthDate = monthDateFromValue(selectedMonth)
  const location = readXmlText(docXml, 'valueName')
  const startDateText = readXmlText(docXml, 'startDate')
  const endDateText = readXmlText(docXml, 'endDate')
  const startDate = dateFromAny(startDateText)
  const endDate = dateFromAny(endDateText)
  const roByNumber = new Map(ros.map(ro => [String(ro.roNumber || '').trim(), ro]))
  const nodes = Array.from(docXml.getElementsByTagName('repairOrder'))

  const rows = nodes.map(node => {
    const outDateText = readXmlText(node, 'vehicle_out_datetime')
    const outDate = dateFromAny(outDateText)
    const roNumber = readXmlText(node, 'repair_order_number')
    const gross = parseCccMoney(readXmlText(node, 'estimate_gross_amount'))
    const sales = parseCccMoney(readXmlText(node, 'sales_amount'))
    const isTotalLoss = readXmlText(node, 'is_total_loss').toLowerCase() === 'true'
    const matchedRo = roByNumber.get(String(roNumber).trim()) || null
    const webDate = matchedRo ? deliveredDateOf(matchedRo) : null
    const webAmount = matchedRo ? revenueAmountOf(matchedRo) : 0
    return {
      roNumber,
      outDate,
      outDateIso: outDate?.toISOString() || outDateText,
      gross,
      sales,
      isTotalLoss,
      fileStatus: readXmlText(node, 'file_status_name'),
      vehicle: readXmlText(node, 'vehicle_year_make_model'),
      customer: readXmlText(node, 'owner_name'),
      matchedRo,
      webDate,
      webAmount,
      needsStatusUpdate: matchedRo?.status !== 'delivered',
      amountMismatch: matchedRo ? Math.abs(webAmount - gross) > 1 : false,
      dateMismatch: matchedRo ? dateKey(webDate) !== dateKey(outDate) : false,
    }
  }).filter(row => row.roNumber)

  const reportRoNumbers = new Set(rows.map(row => row.roNumber))
  const extraDelivered = ros
    .filter(ro => ro.status === 'delivered')
    .filter(ro => sameMonth(deliveredDateOf(ro), selectedMonthDate))
    .filter(ro => !reportRoNumbers.has(String(ro.roNumber || '').trim()))

  const grossTotal = rows.reduce((sum, row) => sum + row.gross, 0)
  const salesTotal = rows.reduce((sum, row) => sum + row.sales, 0)
  const ttlRows = rows.filter(row => row.isTotalLoss)
  const ttlGross = ttlRows.reduce((sum, row) => sum + row.gross, 0)
  const matchedRows = rows.filter(row => row.matchedRo)
  const warnings = []

  if (location && !location.toUpperCase().includes(EXPECTED_CCC_REPORT_LOCATION)) {
    warnings.push(`Location is ${location}`)
  }
  if (startDate && !sameMonth(startDate, selectedMonthDate)) {
    warnings.push(`Start date is outside ${format(selectedMonthDate, 'MMMM yyyy')}`)
  }
  if (endDate && !sameMonth(endDate, selectedMonthDate)) {
    warnings.push(`End date is outside ${format(selectedMonthDate, 'MMMM yyyy')}`)
  }
  if (rows.some(row => row.outDate && !sameMonth(row.outDate, selectedMonthDate))) {
    warnings.push('Some delivered dates are outside the selected month')
  }
  if (rows.length && !matchedRows.length) {
    warnings.push('None of the CCC ROs matched the web board')
  }

  return {
    location,
    startDate,
    endDate,
    rows,
    matchedRows,
    missingRows: rows.filter(row => !row.matchedRo),
    amountMismatches: matchedRows.filter(row => row.amountMismatch),
    dateMismatches: matchedRows.filter(row => row.dateMismatch),
    statusUpdates: matchedRows.filter(row => row.needsStatusUpdate),
    extraDelivered,
    warnings,
    totals: {
      gross: grossTotal,
      sales: salesTotal,
      ttlCount: ttlRows.length,
      ttlGross,
    },
  }
}

function MonthlyRevenueProgress({ ros, goal, selectedMonth, onMonthChange, canReconcile, onOpenReconcile }) {
  const [showMonthMenu, setShowMonthMenu] = useState(false)
  const [showActionMenu, setShowActionMenu] = useState(false)
  const data = useMemo(() => {
    const selectedMonthDate = monthDateFromValue(selectedMonth)
    const isCurrent = sameMonth(selectedMonthDate, new Date())
    const delivered = []
    let excludedTotalLoss = 0

    for (const ro of ros) {
      const hasFinalCccTotalLossBill = ro.cccIsTotalLoss === true && moneyValue(ro.cccDeliveredGrossAmount) > 0
      if (ro.status === 'total_loss' && !hasFinalCccTotalLossBill) {
        excludedTotalLoss += moneyValue(ro.totalAmount)
        continue
      }
      if (ro.status !== 'delivered') continue
      const deliveredDate = deliveredDateOf(ro)
      if (!sameMonth(deliveredDate, selectedMonthDate)) continue
      const amount = revenueAmountOf(ro)
      if (amount > 0) delivered.push({ ro, amount, deliveredDate })
    }

    const total = delivered.reduce((sum, item) => sum + item.amount, 0)
    const activeEstimate = isCurrent
      ? ros
        .filter(ro => !['delivered', 'total_loss'].includes(ro.status))
        .reduce((sum, ro) => sum + moneyValue(ro.totalAmount), 0)
      : 0
    return { delivered, total, activeEstimate, excludedTotalLoss, isCurrent }
  }, [ros, selectedMonth])

  const safeGoal = goal > 0 ? goal : DEFAULT_MONTHLY_REPAIR_GOAL
  const deliveredPercent = safeGoal > 0 ? Math.min(100, Math.round((data.total / safeGoal) * 100)) : 0
  const combinedPercent = safeGoal > 0
    ? Math.min(100, Math.round(((data.total + data.activeEstimate) / safeGoal) * 100))
    : 0
  const activeSegmentPercent = Math.max(0, combinedPercent - deliveredPercent)
  const monthDate = monthDateFromValue(selectedMonth)
  const monthLabel = format(monthDate, 'MMMM').toUpperCase()
  const monthMenuOptions = Array.from({ length: 6 }, (_, index) => {
    const d = new Date()
    d.setMonth(d.getMonth() - index)
    return { value: monthValue(d), label: format(d, 'MMMM yyyy') }
  })
  const remaining = Math.max(0, safeGoal - data.total - data.activeEstimate)

  return (
    <section className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="relative inline-flex">
            <button
              type="button"
              onClick={() => setShowMonthMenu(v => !v)}
              className="inline-flex items-center gap-1 rounded-md text-[11px] font-bold uppercase tracking-wide text-gray-400 hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-200"
              title="Select revenue month"
            >
              {monthLabel} REVENUE
              <IconChevronDown />
            </button>
            {showMonthMenu && (
              <div className="absolute left-0 top-6 z-30 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                {monthMenuOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onMonthChange(option.value)
                      setShowMonthMenu(false)
                    }}
                    className={`block w-full px-3 py-2 text-left text-sm font-medium ${
                      option.value === selectedMonth
                        ? 'bg-gray-100 text-gray-950 dark:bg-zinc-800 dark:text-zinc-100'
                        : 'text-gray-600 hover:bg-gray-50 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
                <div className="border-t border-gray-100 px-3 py-2 dark:border-zinc-800">
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Pick Month</label>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={e => {
                      onMonthChange(e.target.value || monthValue())
                      setShowMonthMenu(false)
                    }}
                    className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-gray-900/10 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                  />
                </div>
              </div>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-lg font-extrabold text-gray-950 dark:text-zinc-100">{moneyFmt(data.total)}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-zinc-400">DELIVERED</span>
            {data.isCurrent && (
              <span className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">{moneyFmt(data.activeEstimate)} ACTIVE EST.</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {canReconcile && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowActionMenu(v => !v)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                title="Revenue actions"
              >
                <IconDots />
              </button>
              {showActionMenu && (
                <div className="absolute right-0 top-9 z-30 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => {
                      setShowActionMenu(false)
                      onOpenReconcile()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-800/70"
                  >
                    <IconUpload />
                    Import CCC Delivered Report
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowActionMenu(false)
                      onMonthChange(monthValue())
                    }}
                    className="block w-full px-3 py-2 text-left text-sm font-medium text-gray-500 hover:bg-gray-50 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
                  >
                    Reset to current month
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 text-right">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Goal</p>
            <p className="text-xs font-bold text-gray-900 dark:text-zinc-100">{moneyFmt(safeGoal)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Finalized</p>
            <p className="text-xs font-bold text-gray-900 dark:text-zinc-100">{deliveredPercent}%</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Projected</p>
            <p className="text-xs font-bold text-gray-900 dark:text-zinc-100">{data.isCurrent ? `${combinedPercent}%` : '--'}</p>
          </div>
          </div>
        </div>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-gray-100 dark:bg-zinc-800">
        <div className="h-full bg-blue-600 transition-all dark:bg-blue-500/35 dark:ring-1 dark:ring-inset dark:ring-blue-300/45" style={{ width: `${deliveredPercent}%` }} />
        {data.isCurrent && (
          <div className="h-full bg-violet-400 transition-all dark:bg-violet-500/20 dark:ring-1 dark:ring-inset dark:ring-violet-300/35" style={{ width: `${activeSegmentPercent}%` }} />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] font-medium text-gray-500 dark:text-zinc-500">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-500/35 dark:ring-1 dark:ring-blue-300/45" />DELIVERED {data.delivered.length}</span>
          {data.isCurrent && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-violet-400 dark:bg-violet-500/25 dark:ring-1 dark:ring-violet-300/40" />ACTIVE EST.</span>}
        </span>
        <span>
          {data.isCurrent ? `${moneyFmt(remaining)} gap after active est.` : 'Historical month'}
          {' '}TTL review excluded{data.excludedTotalLoss > 0 ? ` ${moneyFmt(data.excludedTotalLoss)}` : ''}
        </span>
      </div>
    </section>
  )
}

function RevenueReconcileModal({ ros, selectedMonth, onClose }) {
  const toast = useToast()
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)

  const handleFile = async (file) => {
    setError('')
    setPreview(null)
    if (!file) return
    try {
      const text = await file.text()
      setPreview(parseCccDeliveredXml(text, selectedMonth, ros))
    } catch (err) {
      setError(err.message || 'Could not read this report.')
    }
  }

  const handleApply = async () => {
    if (!preview?.matchedRows?.length) return
    setApplying(true)
    const importedAt = new Date().toISOString()
    try {
      await Promise.all(preview.matchedRows.map(row => updateDoc(doc(db, 'ros', row.matchedRo.id), {
        status: 'delivered',
        deliveredAt: row.outDateIso,
        cccDeliveredAt: row.outDateIso,
        cccDeliveredGrossAmount: row.gross.toFixed(2),
        cccDeliveredSalesAmount: row.sales.toFixed(2),
        cccDeliveredReportMonth: selectedMonth,
        cccDeliveredReportImportedAt: importedAt,
        cccDeliveredReportLocation: preview.location || '',
        cccIsTotalLoss: row.isTotalLoss,
        totalAmount: row.gross.toFixed(2),
        updatedAt: serverTimestamp(),
        changeLog: arrayUnion({
          type: 'ccc_delivered_report',
          value: selectedMonth,
          label: `CCC delivered report ${format(monthDateFromValue(selectedMonth), 'MMM yyyy')}`,
          by: 'CCC Report Import',
          at: importedAt,
          source: 'ccc_report',
        }),
      })))
      toast.success(`CCC report applied to ${preview.matchedRows.length} ROs`)
      onClose()
    } catch (err) {
      setError(err.message || 'Could not apply this report.')
    } finally {
      setApplying(false)
    }
  }

  const dateRangeLabel = preview?.startDate && preview?.endDate
    ? `${format(preview.startDate, 'MMM d, yyyy')} - ${format(preview.endDate, 'MMM d, yyyy')}`
    : 'No date range found'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-zinc-800">
          <div>
            <p className="text-sm font-bold text-gray-950 dark:text-zinc-100">CCC Delivered Report</p>
            <p className="text-xs text-gray-500 dark:text-zinc-400">{format(monthDateFromValue(selectedMonth), 'MMMM yyyy')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center hover:border-blue-300 hover:bg-blue-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30">
            <IconUpload />
            <span className="mt-2 text-sm font-bold text-gray-900 dark:text-zinc-100">Upload Vehicles Delivered XML</span>
            <span className="mt-1 text-xs text-gray-500 dark:text-zinc-400">Preview first, then apply when the totals look right.</span>
            <input
              type="file"
              accept=".xml,text/xml,application/xml"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
          </label>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          {preview && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-zinc-800">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Report</p>
                  <p className="mt-1 text-sm font-bold text-gray-900 dark:text-zinc-100">{preview.rows.length} vehicles</p>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">{dateRangeLabel}</p>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-zinc-800">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Gross Revenue</p>
                  <p className="mt-1 text-sm font-bold text-gray-900 dark:text-zinc-100">{moneyFmt(preview.totals.gross)}</p>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">Sales {moneyFmt(preview.totals.sales)}</p>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-zinc-800">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">TTL Final Bills</p>
                  <p className="mt-1 text-sm font-bold text-gray-900 dark:text-zinc-100">{preview.totals.ttlCount}</p>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">{moneyFmt(preview.totals.ttlGross)} included</p>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-zinc-800">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-zinc-500">Matched</p>
                  <p className="mt-1 text-sm font-bold text-gray-900 dark:text-zinc-100">{preview.matchedRows.length}</p>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">{preview.missingRows.length} not found</p>
                </div>
              </div>

              {(preview.warnings.length > 0 || preview.missingRows.length > 0 || preview.extraDelivered.length > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  <p className="font-bold">Check before applying</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                    {preview.warnings.map(warning => <li key={warning}>{warning}</li>)}
                    {preview.missingRows.length > 0 && <li>{preview.missingRows.length} report ROs are not on the web board</li>}
                    {preview.extraDelivered.length > 0 && <li>{preview.extraDelivered.length} web delivered ROs are not in this report</li>}
                  </ul>
                </div>
              )}

              <div className="grid gap-3 lg:grid-cols-3">
                <MismatchList
                  title="Status"
                  rows={preview.statusUpdates}
                  empty="No status updates"
                  renderRow={row => `#${row.roNumber} -> delivered`}
                />
                <MismatchList
                  title="Amount"
                  rows={preview.amountMismatches}
                  empty="No amount mismatches"
                  renderRow={row => `#${row.roNumber} ${moneyFmt(row.webAmount)} -> ${moneyFmt(row.gross)}`}
                />
                <MismatchList
                  title="Date"
                  rows={preview.dateMismatches}
                  empty="No date mismatches"
                  renderRow={row => `#${row.roNumber} ${row.webDate ? format(row.webDate, 'M/d') : '--'} -> ${row.outDate ? format(row.outDate, 'M/d') : '--'}`}
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3 dark:border-zinc-800">
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            Applies only matched report rows. Extra web delivered ROs are left unchanged.
          </p>
          <button
            type="button"
            onClick={handleApply}
            disabled={!preview?.matchedRows?.length || applying}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
          >
            {applying ? 'Applying...' : `Apply ${preview?.matchedRows?.length || 0} ROs`}
          </button>
        </div>
      </div>
    </div>
  )
}

function MismatchList({ title, rows, empty, renderRow }) {
  const visible = rows.slice(0, 6)
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-zinc-400">{title}</p>
        <span className="text-xs font-bold text-gray-400 dark:text-zinc-500">{rows.length}</span>
      </div>
      {rows.length ? (
        <div className="mt-2 space-y-1 text-xs text-gray-700 dark:text-zinc-300">
          {visible.map(row => <p key={`${title}-${row.roNumber}`}>{renderRow(row)}</p>)}
          {rows.length > visible.length && <p className="text-gray-400 dark:text-zinc-500">+{rows.length - visible.length} more</p>}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400 dark:text-zinc-500">{empty}</p>
      )}
    </div>
  )
}

function detectRoChanges(prev, next) {
  const changes = []
  if (prev.status      !== next.status)      changes.push(`Status → ${STATUS_MAP[next.status]?.label ?? next.status}`)
  if (prev.partsStatus !== next.partsStatus) changes.push(`Parts → ${PARTS_LABEL[next.partsStatus] ?? next.partsStatus}`)
  if (prev.totalAmount !== next.totalAmount && next.totalAmount) changes.push(`Amount → $${Number(next.totalAmount).toLocaleString()}`)
  if (prev.hasRental   !== next.hasRental)   changes.push(next.hasRental ? 'Rental added' : 'Rental removed')
  if (prev.dropOffDate !== next.dropOffDate && next.dropOffDate) changes.push(`Drop-off → ${next.dropOffDate}`)
  return changes
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dueDateClass(dateStr) {
  if (!dateStr) return ''
  try {
    const days = differenceInDays(parseISO(dateStr), new Date())
    if (days < 0)  return 'text-red-500 dark:text-red-400 font-semibold'
    if (days <= 2) return 'text-amber-500 dark:text-amber-400 font-medium'
  return 'text-gray-500 dark:text-zinc-300'
  } catch { return '' }
}

const PRE_PAINT_STATUSES = new Set(['checked_in', 'teardown', 'waiting_parts', 'body_work', 'body_complete', 'paint_prep'])
const PARTS_DELAY_LABELS = { back_ordered: 'Back Ordered', delayed: 'Delayed', wrong_part: 'Wrong Part', defective: 'Defective' }

function isPaintDueSoon(ro) {
  if (!PRE_PAINT_STATUSES.has(ro.status)) return false
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate
  if (!dueDate) return false
  try {
    return differenceInDays(parseISO(dueDate), new Date()) <= 2
  } catch { return false }
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = parseISO(dateStr)
    return isValid(d) ? format(d, 'M/dd') : dateStr
  } catch { return dateStr }
}

// Strip generic insurance suffixes — keep the brand name only
// e.g. "TESLA INSURANCE SERVICES" → "TESLA"
//      "STATE FARM INSURANCE"     → "STATE FARM"
function partsQty(value, fallback = 0) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function partsReceivedSummary(ro) {
  const orders = Array.isArray(ro.partsOrders) ? ro.partsOrders : []
  const totals = orders.reduce((acc, order) => {
    const ordered = partsQty(order.qty ?? order.quantity, 0)
    const rawReceived = partsQty(order.qtyReceived ?? order.receivedQty, 0)
    const received = ordered ? Math.min(rawReceived, ordered) : rawReceived
    return {
      ordered: acc.ordered + ordered,
      received: acc.received + received,
    }
  }, { ordered: 0, received: 0 })
  return totals.ordered > 0 ? totals : null
}

function partsBadgeLabel(ro) {
  if (ro.noReplacementPartsNeeded && ro.partsStatus === 'all_received') return 'No Repl Parts Needed'
  if (ro.partsStatus !== 'partially_received') return null
  const summary = partsReceivedSummary(ro)
  return summary ? `Partial ${summary.received}/${summary.ordered}` : null
}

function fmtPrintDate(dateStr) {
  if (!dateStr) return '-'
  try {
    const d = parseISO(dateStr)
    return isValid(d) ? format(d, 'M/dd EEE') : dateStr
  } catch { return dateStr }
}

function isPrintDueThisWeek(dateStr) {
  if (!dateStr) return false
  try {
    const due = parseISO(dateStr)
    if (!isValid(due)) return false
    const today = new Date()
    const start = new Date(today)
    const day = start.getDay()
    const mondayOffset = day === 0 ? -6 : 1 - day
    start.setDate(start.getDate() + mondayOffset)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    end.setHours(23, 59, 59, 999)
    return due >= start && due <= end
  } catch { return false }
}
function shortInsurance(name) {
  if (!name) return ''
  const upper = name.toUpperCase()
  const known = [
    ['STATE FARM', 'STATE FARM'],
    ['ALLSTATE', 'ALLSTATE'],
    ['ASPIRE', 'ASPIRE'],
    ['FARMERS', 'FARMERS'],
    ['AMERICAN FAMILY', 'AMERICAN FAMILY'],
    ['MOBILITAS', 'MOBILITAS'],
    ['GEICO', 'GEICO'],
    ['PROGRESSIVE', 'PROGRESSIVE'],
    ['MERCURY', 'MERCURY'],
    ['AAA', 'AAA'],
    ['USAA', 'USAA'],
    ['LIBERTY MUTUAL', 'LIBERTY MUTUAL'],
    ['NATIONWIDE', 'NATIONWIDE'],
    ['TRAVELERS', 'TRAVELERS'],
  ]
  const hit = known.find(([needle]) => upper.includes(needle))
  if (hit) return hit[1]
  const trimmed = name
    .replace(/\s+INSURANCE\b.*/i, '')
    .replace(/\s+INDEMNITY\b.*/i, '')
    .replace(/\s+COMPAN(Y|IES)\b.*/i, '')
    .trim()
  return trimmed || name
}

function normalizePersonName(value = '') {
  return value.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function matchEmployeeByName(employees = [], rawName = '', roles = []) {
  const target = normalizePersonName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  return employees
    .filter(emp => !roles.length || roles.includes(emp.role))
    .find(emp => {
      const name = normalizePersonName(emp.name)
      if (!name) return false
      if (name === target) return true
      const parts = name.split(' ').filter(Boolean)
      return targetParts.every(part =>
        parts.some(namePart => namePart === part || namePart.startsWith(part) || part.startsWith(namePart))
      )
    }) || null
}

function needsDropOffWarning(ro) {
  return !ro.dropOffDate && ro.status !== 'checked_in' && ro.carStatus !== 'pending_dropoff'
}

function DropOffInfo({ ro, compact = false }) {
  if (ro.dropOffDate) {
    return <span className={compact ? 'text-xs text-gray-500 dark:text-zinc-300' : ''}>{compact ? `In: ${fmtDate(ro.dropOffDate)}` : fmtDate(ro.dropOffDate)}</span>
  }

  if (!ro.status && !ro.carStatus) return null

  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/60 dark:text-amber-200 ${compact ? '' : 'whitespace-nowrap'}`}>
      Pending
      {needsDropOffWarning(ro) && (
        <span title="Drop-off date needs update" className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold text-red-700 dark:bg-red-900/60 dark:text-red-200">!</span>
      )}
    </span>
  )
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
function IconSearch() { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg> }
function IconList()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg> }
function IconGrid()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IconPencil() { return <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> }
function IconChevronLeft() { return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6"/></svg> }
function IconChevronRight() { return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6"/></svg> }
function IconChevronDown() { return <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.25} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6"/></svg> }
function IconDots() { return <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg> }
function IconUpload() { return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> }

// ── List row ─────────────────────────────────────────────────────────────────
function RORow({ ro, employees, onSelect }) {
  const bodyTech  = employees[ro.assignedBodyMan]   ?? '—'
  // Estimator: prefer CCC name, fall back to assigned UID lookup
  const estimator = ro.estimatorName || employees[ro.assignedEstimator] || '—'
  const dueDate   = ro.eta || ro.cccDateOut || ro.promisedDate

  return (
    <tr
      onClick={() => onSelect(ro)}
      className="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors group cursor-pointer"
    >
      {/* RO# */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="font-mono text-sm font-bold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {ro.roNumber}
        </span>
      </td>

      {/* Insurance + Vehicle + Owner */}
      <td className="px-4 py-3 min-w-[180px]">
        {ro.insuranceCompany && (
          <div className="text-xs text-gray-400 dark:text-zinc-400 mb-0.5 truncate">{shortInsurance(ro.insuranceCompany)}</div>
        )}
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
          {ro.vehicle}{ro.vehicleColor ? ` · ${ro.vehicleColor}` : ''}
        </div>
        <div className="text-xs text-gray-500 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</div>
        {/* Rental highlight */}
        {ro.hasRental === true && (
          <span className="inline-block mt-1 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 font-medium">
            Rental
          </span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge status={ro.status} />
      </td>

      {/* Estimator (CCC) */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-300 whitespace-nowrap">{estimator}</td>

      {/* Body Tech */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-300 whitespace-nowrap">{bodyTech}</td>

      {/* Parts + delay badge */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex flex-col gap-1">
          <PartsStatusBadge status={ro.partsStatus} label={partsBadgeLabel(ro)} />
          {ro.partsDelay && (
            <span
              title={ro.partsDelay.note || PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts delay'}
              className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 font-medium"
            >
              ⚠ {PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts Delay'}
            </span>
          )}
        </div>
      </td>

      {/* Drop-off Date (manual, not CCC) */}
      <td className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400 whitespace-nowrap">
        <DropOffInfo ro={ro} />
      </td>

      {/* Due Date + paint alert */}
      <td className={`px-4 py-3 text-xs whitespace-nowrap ${dueDateClass(dueDate)}`}>
        <div className="flex flex-col gap-1">
          <span>{fmtDate(dueDate)}</span>
          {isPaintDueSoon(ro) && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-medium">
              ⚠ Paint Due
            </span>
          )}
        </div>
      </td>

      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
        <Link
          to={`/ro/${ro.id}`}
          className="text-xs text-gray-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Detail →
        </Link>
      </td>
    </tr>
  )
}

// ── Kanban card ───────────────────────────────────────────────────────────────
function KanbanCard({ ro, onSelect, draggable, onDragStart, onDragEnd, onDragOver, onDrop, dropPosition = null, isDragging = false }) {
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate

  return (
    <div
      onClick={() => onSelect(ro)}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative bg-white dark:bg-zinc-800/90 border rounded-xl p-3.5 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing group ${
        isDragging
          ? 'opacity-50 border-blue-300 dark:border-blue-700'
          : dropPosition
          ? 'border-blue-400 dark:border-blue-500'
          : 'border-gray-200 dark:border-zinc-700 hover:border-gray-300 dark:hover:border-zinc-600'
      }`}
    >
      {dropPosition === 'before' && (
        <div className="pointer-events-none absolute -top-1 left-2 right-2 h-0.5 rounded-full bg-blue-500" />
      )}
      {dropPosition === 'after' && (
        <div className="pointer-events-none absolute -bottom-1 left-2 right-2 h-0.5 rounded-full bg-blue-500" />
      )}
      {/* Edit icon — navigates to RODetail without opening drawer */}
      <Link
        to={`/ro/${ro.id}`}
        onClick={e => e.stopPropagation()}
        title="Open full detail"
        className="absolute top-2.5 right-2.5 p-1 rounded-md text-gray-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors opacity-0 group-hover:opacity-100"
      >
        <IconPencil />
      </Link>

        {/* Top row: RO# | right col (Parts badge + Status badge stacked) */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <span className="text-base font-mono font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
            #{ro.roNumber}
          </span>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <PartsStatusBadge status={ro.partsStatus} label={partsBadgeLabel(ro)} />
            {ro.status && STATUS_MAP[ro.status] && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_MAP[ro.status].color}`}>
                {STATUS_MAP[ro.status].label}
              </span>
            )}
          </div>
        </div>

        {/* Vehicle */}
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate leading-snug">{ro.vehicle}</p>
        {ro.vehicleColor && (
        <p className="text-xs text-gray-400 dark:text-zinc-300">{ro.vehicleColor}</p>
        )}

        {/* Owner */}
        <p className="text-xs text-gray-500 dark:text-zinc-300 mt-0.5 truncate">{ro.customerName}</p>

        {/* Insurance + Claim — brand only, strip "INSURANCE SERVICES" etc. */}
        {(ro.insuranceCompany || ro.claimNumber) && (
          <div className="mt-2 text-xs text-gray-400 dark:text-zinc-400 truncate">
            {ro.insuranceCompany && <span>{shortInsurance(ro.insuranceCompany)}</span>}
            {ro.claimNumber && <span className="ml-1 text-gray-400 dark:text-zinc-500">#{ro.claimNumber}</span>}
          </div>
        )}

        {/* Dates row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          {/* Drop-off (manual entry, not CCC) */}
          <DropOffInfo ro={ro} compact />

          {/* Due date */}
          {dueDate && (
            <span className={`text-xs font-medium ${dueDateClass(dueDate)}`}>
              Due {fmtDate(dueDate)}
            </span>
          )}
        </div>

        {/* Rental indicator */}
        {ro.hasRental === true && (
          <div className="mt-1.5">
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 font-medium">
              Rental
            </span>
          </div>
        )}

        {/* Alert badges */}
        {(ro.partsDelay || isPaintDueSoon(ro)) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ro.partsDelay && (
              <span
                title={ro.partsDelay.note || PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts delay'}
                className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 font-medium"
              >
                ⚠ {PARTS_DELAY_LABELS[ro.partsDelay.reason] || 'Parts Delay'}
              </span>
            )}
            {isPaintDueSoon(ro) && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-medium">
                ⚠ Paint Due
              </span>
            )}
          </div>
        )}
    </div>
  )
}

function MobileROCard({ ro, onSelect, expanded = false, onToggle }) {
  const dueDate = ro.eta || ro.cccDateOut || ro.promisedDate
  const status = STATUS_MAP[ro.status]

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" onClick={() => onSelect(ro)} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-extrabold text-gray-950 dark:text-gray-100">#{ro.roNumber}</span>
              {status && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.color}`}>
                  {status.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">{ro.vehicle || 'Vehicle missing'}</p>
            {ro.vehicleColor && <p className="text-xs text-gray-400 dark:text-zinc-500">{ro.vehicleColor}</p>}
          </div>
          <PartsStatusBadge status={ro.partsStatus} label={partsBadgeLabel(ro)} />
        </div>
      </button>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-gray-500 dark:text-zinc-400">{shortInsurance(ro.insuranceCompany) || ro.customerName || 'No owner'}</span>
        {dueDate && <span className={`shrink-0 font-semibold ${dueDateClass(dueDate)}`}>Due {fmtDate(dueDate)}</span>}
      </div>

      {(ro.partsDelay || isPaintDueSoon(ro)) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {ro.partsDelay && (
            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/50 dark:text-orange-300">
              Parts Delay
            </span>
          )}
          {isPaintDueSoon(ro) && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/50 dark:text-red-300">
              Paint Due
            </span>
          )}
        </div>
      )}

      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 text-xs font-semibold text-blue-600 dark:text-blue-400"
        >
          {expanded ? 'Hide details' : 'Show full info'}
        </button>
      )}

      {expanded && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-gray-50 p-2 text-xs dark:bg-zinc-800/70">
          <dt className="text-gray-400">Owner</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.customerName || '-'}</dd>
          <dt className="text-gray-400">Insurance</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.insuranceCompany || '-'}</dd>
          <dt className="text-gray-400">Claim</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.claimNumber || '-'}</dd>
          <dt className="text-gray-400">Drop-off</dt><dd className="text-right text-gray-700 dark:text-zinc-200">{ro.dropOffDate ? fmtDate(ro.dropOffDate) : 'Pending'}</dd>
        </dl>
      )}
    </article>
  )
}

function MobileListCard({ ro, onSelect }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <MobileROCard
      ro={ro}
      onSelect={onSelect}
      expanded={expanded}
      onToggle={() => setExpanded(v => !v)}
    />
  )
}

// ── PendingToBodyModal ────────────────────────────────────────────────────────
function PendingToBodyModal({ ro, employees, onConfirm, onCancel }) {
  const bodyMen = employees.filter(e => e.role === 'body_man')
  const painters = employees.filter(e => e.role === 'painter' || e.role === 'paint_helper')

  const prefilled = !!ro.dropOffDate  // was already set via GIB before drag

  const [bodyManUid,    setBodyManUid]    = useState(ro.assignedBodyMan || '')
  const [painterUid,    setPainterUid]    = useState(ro.assignedPainter || (painters[0]?.uid ?? ''))
  const [authorized,    setAuthorized]    = useState(ro.customerAuthorized ?? null)
  const [dropOffDate,   setDropOffDate]   = useState(ro.dropOffDate || '')
  const [hasRental,     setHasRental]     = useState(ro.hasRental ?? false)
  const [error,         setError]         = useState('')

  const handleConfirm = () => {
    if (!bodyManUid)           return setError('Please assign a body technician.')
    if (authorized === null)   return setError('Please confirm customer authorization.')
    if (!dropOffDate)          return setError('Please enter the drop-off date.')
    setError('')
    onConfirm({ bodyManUid, authorized, dropOffDate, hasRental })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm border border-gray-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-800">
          <h3 className="font-bold text-gray-900 dark:text-gray-100">Move to Body Work</h3>
          <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">RO #{ro.roNumber} · {ro.vehicle}</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          {/* Body Tech */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Body Technician <span className="text-red-500">*</span>
            </label>
            <select
              value={bodyManUid}
              onChange={e => setBodyManUid(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select body tech —</option>
              {bodyMen.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* Painter (auto-fill) */}
          <div className="hidden">
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Paint Team
            </label>
            <select
              value={painterUid}
              onChange={e => setPainterUid(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— None —</option>
              {painters.map(e => <option key={e.uid} value={e.uid}>{e.name}</option>)}
            </select>
          </div>

          {/* Customer Authorization */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300 mb-1.5">
              Customer Authorized to Start? <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setAuthorized(true)}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors
                  ${authorized === true ? 'bg-green-600 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
              >Yes</button>
              <button
                onClick={() => setAuthorized(false)}
                className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors
                  ${authorized === false ? 'bg-red-500 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
              >No</button>
            </div>
          </div>

          {/* Drop-off Date */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-zinc-300">
                Drop-off Date <span className="text-red-500">*</span>
              </label>
              {prefilled && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300 font-medium">
                  ✓ from GIB
                </span>
              )}
            </div>
            <input
              type="date"
              value={dropOffDate}
              onChange={e => setDropOffDate(e.target.value)}
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Rental */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Rental Car?</span>
            <button
              onClick={() => setHasRental(v => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${hasRental ? 'bg-blue-600' : 'bg-gray-300 dark:bg-zinc-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                ${hasRental ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-zinc-800 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 border border-gray-300 dark:border-zinc-700 rounded-xl text-sm font-medium text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
          >Cancel</button>
          <button
            onClick={handleConfirm}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded-xl text-sm font-medium text-white transition-colors"
          >Confirm →</button>
        </div>
      </div>
    </div>
  )
}

const VIEWS = ['list', 'kanban']

const STATUS_PRINT_ORDER = STATUS_GROUPS.flatMap(group => group.statuses)

function statusOrderValue(status) {
  const idx = STATUS_PRINT_ORDER.indexOf(status)
  return idx === -1 ? 999 : idx
}

function roDueValue(ro) {
  return ro.eta || ro.cccDateOut || ro.promisedDate || ''
}

function sortValue(ro, key, employees = {}) {
  switch (key) {
    case 'roNumber': return Number.parseInt(ro.roNumber, 10) || String(ro.roNumber || '')
    case 'vehicle': return `${ro.insuranceCompany || ''} ${ro.vehicle || ''} ${ro.customerName || ''}`.toLowerCase()
    case 'status': return statusOrderValue(ro.status)
    case 'estimator': return (ro.estimatorName || employees[ro.assignedEstimator] || '').toLowerCase()
    case 'bodyTech': return (employees[ro.assignedBodyMan] || '').toLowerCase()
    case 'parts': {
      const idx = PARTS_STATUSES.findIndex(p => p.key === ro.partsStatus)
      return idx === -1 ? 999 : idx
    }
    case 'dropOff': return ro.dropOffDate || '9999-12-31'
    case 'due': return roDueValue(ro) || '9999-12-31'
    default: return ''
  }
}

function sortRosForList(list, sort, employees = {}) {
  return [...list].sort((a, b) => {
    const av = sortValue(a, sort.key, employees)
    const bv = sortValue(b, sort.key, employees)
    const dir = sort.dir === 'desc' ? -1 : 1
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return String(a.roNumber || '').localeCompare(String(b.roNumber || ''))
  })
}

function sortRosForPrint(list) {
  return [...list].sort((a, b) => {
    const sa = statusOrderValue(a.status)
    const sb = statusOrderValue(b.status)
    if (sa !== sb) return sa - sb
    const da = roDueValue(a) || '9999-12-31'
    const db = roDueValue(b) || '9999-12-31'
    if (da !== db) return da.localeCompare(db)
    return String(a.roNumber || '').localeCompare(String(b.roNumber || ''))
  })
}

function printStatusGroupFor(ro) {
  return STATUS_GROUPS.find(group => group.statuses.includes(ro.status)) || { key: 'OTHER', label: 'Other' }
}

function boardOrderValue(ro, groupKey) {
  if (ro.boardOrderGroup === groupKey && Number.isFinite(Number(ro.boardOrder))) {
    return Number(ro.boardOrder)
  }
  const roNumber = Number.parseInt(ro.roNumber, 10)
  return 900000 + (Number.isFinite(roNumber) ? roNumber : 99999)
}

function numericPartQty(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function partsPrintSummary(ro) {
  const orders = Array.isArray(ro.partsOrders) ? ro.partsOrders : []
  const ordered = orders.reduce((sum, order) => sum + numericPartQty(order.qty ?? order.quantity, 0), 0)
  const received = orders.reduce((sum, order) => sum + numericPartQty(order.qtyReceived ?? order.receivedQty, 0), 0)
  const statusLabel = PARTS_STATUSES.find(p => p.key === ro.partsStatus)?.label ?? ro.partsStatus ?? 'Not Ordered'

  if (ordered > 0) return `${received}/${ordered}`
  return statusLabel === 'Not Ordered' ? 'No Order' : statusLabel
}

function rentalPrintValue(ro) {
  if (ro.hasRental === true) return 'RENTAL'
  if (ro.hasRental === false) return 'NO'
  return '--'
}

function printFirstName(name = '') {
  const value = String(name || '').trim()
  if (!value || value === '-') return '-'
  return value.split(/\s+/)[0] || value
}

function escapePrintText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function SortHeader({ label, column, sort, onSort }) {
  const active = sort.key === column
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-left font-semibold transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${active ? 'text-gray-800 dark:text-zinc-100' : ''}`}
    >
      {label}
      <span className={`text-[10px] ${active ? 'opacity-100' : 'opacity-35'}`}>
        {active ? (sort.dir === 'asc' ? '^' : 'v') : '-'}
      </span>
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
function handlePrintRos(rosToPrint, employees) {
  const popup = window.open('', '_blank', 'width=1200,height=800')
  if (!popup) return

  const sortedRos = rosToPrint
  let currentGroup = ''
  const rows = sortedRos.map(ro => {
    const group = printStatusGroupFor(ro)
    const groupRow = group.key !== currentGroup
      ? `<tr class="status-group"><td colspan="10">${group.label}</td></tr>`
      : ''
    currentGroup = group.key

    return `${groupRow}
      <tr class="ro-row">
        <td class="ro-num">${escapePrintText(ro.roNumber ?? '')}</td>
        <td class="vehicle-cell">
          <div class="vehicle">${escapePrintText(ro.vehicle ?? '')}${ro.vehicleColor ? ` - ${escapePrintText(ro.vehicleColor)}` : ''}</div>
          <div class="subline">${escapePrintText(shortInsurance(ro.insuranceCompany) || '-')} - ${escapePrintText(ro.customerName ?? '')}</div>
        </td>
        <td>${escapePrintText(printFirstName(employees[ro.assignedBodyMan] ?? '-'))}</td>
        <td class="status-text">${escapePrintText(STATUS_MAP[ro.status]?.label ?? ro.status ?? '')}</td>
        <td>${escapePrintText(printFirstName(ro.estimatorName || employees[ro.assignedEstimator] || '-'))}</td>
        <td class="parts-text">${escapePrintText(partsPrintSummary(ro))}</td>
        <td>${escapePrintText(ro.dropOffDate ? fmtDate(ro.dropOffDate) : 'Pending')}</td>
        <td class="${isPrintDueThisWeek(ro.cccDateOut || ro.promisedDate || ro.eta) ? 'due-week' : ''}">${escapePrintText(fmtPrintDate(ro.cccDateOut || ro.promisedDate || ro.eta))}</td>
        <td class="rental-text">${rentalPrintValue(ro)}</td>
        <td class="note-cell"></td>
      </tr>
    `
  }).join('')

  popup.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>RO List</title>
        <style>
          @page { size: landscape; margin: 0.30in; }
          * { box-sizing: border-box; }
          body { font-family: Arial, sans-serif; color: #111; margin: 0; }
          h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: 0; }
          p { margin: 0 0 8px; font-size: 9.5px; color: #333; }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
          thead { display: table-header-group; }
          th, td { border-bottom: 1px solid #c7c7c7; padding: 3px 5px; text-align: left; vertical-align: middle; line-height: 1.14; }
          th { background: #eeeeee; border-top: 1px solid #999; border-bottom: 1px solid #777; color: #222; font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
          th:nth-child(1), td:nth-child(1) { width: 5%; }
          th:nth-child(2), td:nth-child(2) { width: 31%; }
          th:nth-child(3), td:nth-child(3) { width: 9%; }
          th:nth-child(4), td:nth-child(4) { width: 8%; }
          th:nth-child(5), td:nth-child(5) { width: 8%; }
          th:nth-child(6), td:nth-child(6) { width: 7%; }
          th:nth-child(7), td:nth-child(7) { width: 6%; }
          th:nth-child(8), td:nth-child(8) { width: 6%; }
          th:nth-child(9), td:nth-child(9) { width: 5%; }
          th:nth-child(10), td:nth-child(10) { width: 10%; }
          .ro-row { height: 38px; break-inside: avoid; page-break-inside: avoid; }
          .status-group td { background: #dedede; color: #111; border-top: 1px solid #777; border-bottom: 1px solid #999; font-weight: 900; font-size: 11.5px; text-align: center; text-transform: uppercase; padding: 5px 5px; break-after: avoid; page-break-after: avoid; }
          .ro-num { font-weight: 900; font-size: 10.5px; white-space: nowrap; }
          .vehicle-cell { overflow: hidden; }
          .vehicle { font-weight: 700; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .subline { color: #333; font-size: 8.5px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
          .status-text, .parts-text, .rental-text { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .parts-text { text-align: left; }
          .due-week { font-weight: 800; text-decoration: underline; }
          .note-cell { min-width: 0; }
        </style>
      </head>
      <body>
        <h1>Repair Order List</h1>
        <p>${new Date().toLocaleString()} - ${rosToPrint.length} ROs - grouped by production status</p>
        <table>
          <thead>
            <tr>
              <th>RO #</th><th>Vehicle / Owner</th><th>Body Tech</th><th>Status</th>
              <th>Estimator</th><th>Parts</th><th>Drop-off</th><th>Due</th><th>Rental</th><th>Note</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <script>window.print(); window.onafterprint = () => window.close();<\/script>
      </body>
    </html>
  `)
  popup.document.close()
}

function uniqueEmployeeByRole(employees = [], role) {
  const matches = employees.filter(e => e.role === role)
  return matches.length === 1 ? matches[0] : null
}

function defaultPaintTeam(employees = []) {
  return {
    painter: uniqueEmployeeByRole(employees, 'painter'),
    helper: uniqueEmployeeByRole(employees, 'paint_helper'),
  }
}

function employeeHasRole(employees = [], uid, role) {
  return Boolean(uid && employees.some(e => e.uid === uid && e.role === role))
}

function hasBodyReleaseInfo(ro, employees = []) {
  return Boolean(
    employeeHasRole(employees, ro.assignedBodyMan, 'body_man')
    && ro.dropOffDate
    && ro.customerAuthorized !== undefined
    && ro.customerAuthorized !== null
  )
}

export default function ROBoard() {
  const { role, user } = useAuth()
  const toast      = useToast()
  const isManager  = MANAGER_ROLES.includes(role)
  const canEdit    = EDIT_RO_ROLES.includes(role)
  const prevRosRef = useRef(null)          // for change-detection
  const cleanedInvalidBodyRef = useRef(new Set())
  const quickUpdateRef = useRef(null)
  const stickyGibVisibleRef = useRef(false)

  const [ros,            setRos]            = useState([])
  const [employees,      setEmployees]      = useState({})   // uid -> name map
  const [employeeList,   setEmployeeList]   = useState([])   // [{uid, name, role}]
  const [selectedRO,     setSelectedRO]     = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('kanban')
  const [search,         setSearch]         = useState('')
  const [filterStatus,   setFilterStatus]   = useState('all')
  const [listSort,       setListSort]       = useState({ key: 'board', dir: 'asc' })
  const [showDeliveredArchive, setShowDeliveredArchive] = useState(false)
  const [monthlyRepairGoal, setMonthlyRepairGoal] = useState(DEFAULT_MONTHLY_REPAIR_GOAL)
  const [revenueMonth, setRevenueMonth] = useState(monthValue())
  const [showRevenueReconcile, setShowRevenueReconcile] = useState(false)
  // Drag-and-drop state
  const [dragRoId,       setDragRoId]       = useState(null)
  const [dragOverGroup,  setDragOverGroup]  = useState(null)
  const [dragOverCard,   setDragOverCard]   = useState(null)  // { roId, position }
  const [statusPicker,   setStatusPicker]   = useState(null)  // { roId, groupKey, statuses }
  const [pendingToBody,  setPendingToBody]  = useState(null)  // { ro }
  const [showStickyGib,  setShowStickyGib]  = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      const map  = {}
      const list = []
      snap.forEach(d => {
        const data = d.data()
        map[d.id] = data.name
        list.push({ uid: d.id, name: data.name, role: data.role ?? '' })
      })
      setEmployees(map)
      setEmployeeList(list)
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'revenue'), snap => {
      const nextGoal = moneyValue(snap.data()?.monthlyRepairGoal)
      setMonthlyRepairGoal(nextGoal || DEFAULT_MONTHLY_REPAIR_GOAL)
    })
    return unsub
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))

    const unsub = onSnapshot(q, snap => {
      const newRos = snap.docs.map(d => ({ id: d.id, ...d.data() }))

      // Fire update toasts on live changes (skip initial load)
      if (prevRosRef.current !== null) {
        for (const newRo of newRos) {
          const prev = prevRosRef.current.find(r => r.id === newRo.id)
          if (!prev) continue
          const changes = detectRoChanges(prev, newRo)
          if (changes.length) {
            toast.info(`RO #${newRo.roNumber} · ${changes.join(' · ')}`)
          }
        }
      }
      prevRosRef.current = newRos
      setRos(newRos)
      setLoading(false)
    }, err => { console.error(err); setLoading(false) })
    return unsub
  }, [])   // toast is stable, no need in deps

  useEffect(() => {
    let triggerY = null
    const measureTrigger = () => {
      const box = quickUpdateRef.current
      if (!box) return
      const rect = box.getBoundingClientRect()
      triggerY = rect.top + window.scrollY + rect.height - 88
    }
    const onScroll = () => {
      if (triggerY === null) measureTrigger()
      if (triggerY === null) return
      const nextVisible = stickyGibVisibleRef.current
        ? window.scrollY > triggerY - 72
        : window.scrollY > triggerY + 12
      if (nextVisible !== stickyGibVisibleRef.current) {
        stickyGibVisibleRef.current = nextVisible
        setShowStickyGib(nextVisible)
      }
    }
    const onResize = () => {
      triggerY = null
      onScroll()
    }
    measureTrigger()
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    if (!employeeList.length || !ros.length) return
    const toAssign = ros
      .filter(ro => ro.estimatorName && !ro.assignedEstimator)
      .map(ro => ({ ro, emp: matchEmployeeByName(employeeList, ro.estimatorName, ['estimator', 'shop_manager', 'production_manager']) }))
      .filter(item => item.emp?.uid)
      .slice(0, 20)

    toAssign.forEach(({ ro, emp }) => {
      updateDoc(doc(db, 'ros', ro.id), {
        assignedEstimator: emp.uid,
        updatedAt: serverTimestamp(),
      }).catch(err => console.warn('[ROBoard] estimator auto-assign failed', ro.roNumber, err))
    })
  }, [employeeList, ros])

  useEffect(() => {
    if (!MANAGER_ROLES.includes(role) || !employeeList.length || !ros.length) return
    const roleByUid = new Map(employeeList.map(e => [e.uid, e.role]))
    const invalidRos = ros
      .filter(ro => ro.assignedBodyMan && roleByUid.get(ro.assignedBodyMan) !== 'body_man')
      .filter(ro => !cleanedInvalidBodyRef.current.has(ro.id))
      .slice(0, 10)

    invalidRos.forEach(ro => {
      cleanedInvalidBodyRef.current.add(ro.id)
      updateDoc(doc(db, 'ros', ro.id), {
        assignedBodyMan: '',
        updatedAt: serverTimestamp(),
        changeLog: arrayUnion({
          type: 'assign_body_man',
          value: '',
          label: 'Cleared invalid Body Tech assignment',
          by: employees[user?.uid] ?? 'System',
          at: new Date().toISOString(),
          source: 'role_cleanup',
        }),
      }).catch(err => {
        cleanedInvalidBodyRef.current.delete(ro.id)
        console.warn('[ROBoard] invalid body tech cleanup failed', ro.roNumber, err)
      })
    })
  }, [employeeList, employees, role, ros, user?.uid])

  const filtered = useMemo(() => ros.filter(ro => {
    if (ro.status === 'delivered') return false
    const matchStatus = filterStatus === 'all' || ro.status === filterStatus
    const q = search.toLowerCase()
    const matchSearch = !q
      || ro.roNumber?.toLowerCase().includes(q)
      || ro.customerName?.toLowerCase().includes(q)
      || ro.vehicle?.toLowerCase().includes(q)
      || ro.insuranceCompany?.toLowerCase().includes(q)
    return matchStatus && matchSearch
  }), [ros, filterStatus, search])

  const handleListSort = (key) => {
    setListSort(prev => (
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    ))
  }

  const deliveredRos = useMemo(() => {
    return ros.filter(ro => ro.status === 'delivered')
  }, [ros])

  // Count per status (for filter pills)
  const statusCounts = useMemo(() => {
    const counts = {}
    ros.forEach(r => {
      if (r.status !== 'delivered') counts[r.status] = (counts[r.status] || 0) + 1
    })
    return counts
  }, [ros])

  // Kanban: 6 fixed group columns
  const kanbanGroups = useMemo(() => {
    return STATUS_GROUPS.map(group => ({
      ...group,
      items: filtered
        .filter(ro => group.statuses.includes(ro.status) || (group.key === 'PENDING' && !ro.status))
        .sort((a, b) => {
          const ao = boardOrderValue(a, group.key)
          const bo = boardOrderValue(b, group.key)
          if (ao !== bo) return ao - bo
          return String(a.roNumber || '').localeCompare(String(b.roNumber || ''), undefined, { numeric: true })
        }),
    }))
  }, [filtered])
  const totalLossGroup = useMemo(() => kanbanGroups.find(group => group.key === 'TOTAL_LOSS'), [kanbanGroups])
  const mainKanbanGroups = useMemo(() => kanbanGroups.filter(group => group.key !== 'TOTAL_LOSS'), [kanbanGroups])
  const boardOrderedRos = useMemo(() => (
    mainKanbanGroups.flatMap(group => (
      group.key === 'PENDING' && totalLossGroup
        ? [...group.items, ...totalLossGroup.items]
        : group.items
    ))
  ), [mainKanbanGroups, totalLossGroup])
  const sortedListRos = useMemo(() => (
    listSort.key === 'board'
      ? boardOrderedRos
      : listSort.key === 'status'
        ? (listSort.dir === 'desc' ? [...boardOrderedRos].reverse() : boardOrderedRos)
      : sortRosForList(filtered, listSort, employees)
  ), [boardOrderedRos, filtered, listSort, employees])

  // ── Drag-and-drop handlers ───────────────────────────────────────────────────

  const handleDrop = (group) => {
    if (!dragRoId) return
    const ro = ros.find(r => r.id === dragRoId)
    if (!ro) return
    setDragRoId(null)
    setDragOverGroup(null)
    setDragOverCard(null)

    // PENDING → BODY: requires confirmation modal
    const currentGroup = STATUS_GROUPS.find(g => g.statuses.includes(ro.status))
    if (currentGroup?.key === 'PENDING' && group.key === 'BODY') {
      if (hasBodyReleaseInfo(ro, employeeList)) {
        applyPendingToBody({
          ro,
          bodyManUid: ro.assignedBodyMan,
          authorized: ro.customerAuthorized,
          dropOffDate: ro.dropOffDate,
          hasRental: ro.hasRental ?? false,
        })
        return
      }
      setPendingToBody({ ro })
      return
    }

    if (group.statuses.length === 1) {
      applyStatusDrop(dragRoId, group.statuses[0])
    } else if (group.statuses.length > 1) {
      setStatusPicker({ roId: dragRoId, groupKey: group.key, statuses: group.statuses })
    }
  }

  const saveBoardOrder = async (group, orderedItems) => {
    const author = employees[user?.uid] ?? 'Unknown'
    await Promise.all(orderedItems.map((ro, index) => updateDoc(doc(db, 'ros', ro.id), {
      boardOrder: (index + 1) * 1000,
      boardOrderGroup: group.key,
      updatedAt: serverTimestamp(),
      changeLog: arrayUnion({
        type: 'board_order',
        value: String((index + 1) * 1000),
        label: `Priority position ${index + 1} in ${group.label}`,
        by: author,
        at: new Date().toISOString(),
        source: 'drag',
      }),
    })))
  }

  const handleCardDrop = async (group, targetRoId, position = 'before') => {
    if (!dragRoId || dragRoId === targetRoId) return
    const dragged = ros.find(r => r.id === dragRoId)
    const target = ros.find(r => r.id === targetRoId)
    if (!dragged || !target) return

    const draggedGroup = STATUS_GROUPS.find(g => g.statuses.includes(dragged.status) || (g.key === 'PENDING' && !dragged.status))
    const targetGroup = STATUS_GROUPS.find(g => g.statuses.includes(target.status) || (g.key === 'PENDING' && !target.status))
    if (draggedGroup?.key !== group.key || targetGroup?.key !== group.key) {
      handleDrop(group)
      return
    }

    setDragRoId(null)
    setDragOverGroup(null)
    setDragOverCard(null)

    const orderedItems = [...(kanbanGroups.find(g => g.key === group.key)?.items || [])]
    const withoutDragged = orderedItems.filter(item => item.id !== dragRoId)
    const targetIndex = withoutDragged.findIndex(item => item.id === targetRoId)
    if (targetIndex < 0) return
    const insertAt = position === 'after' ? targetIndex + 1 : targetIndex
    withoutDragged.splice(insertAt, 0, dragged)

    try {
      await saveBoardOrder(group, withoutDragged)
    } catch (err) {
      toast.error(`Could not save board order: ${err.message}`)
    }
  }

  const applyStatusDrop = async (roId, newStatus) => {
    const ro = ros.find(r => r.id === roId)
    if (!ro || ro.status === newStatus) return
    const author = employees[user?.uid] ?? 'Unknown'
    await updateDoc(doc(db, 'ros', roId), {
      status:    newStatus,
      updatedAt: serverTimestamp(),
      changeLog: arrayUnion({
        type:   'status_change',
        value:  newStatus,
        label:  STATUS_MAP[newStatus]?.label ?? newStatus,
        by:     author,
        at:     new Date().toISOString(),
        source: 'drag',
      }),
    })
    await createDownstreamTasks(newStatus, ro)
  }

  const createDownstreamTasks = async (newStatus, roData) => {
    const templates = getDownstreamTasks(newStatus, roData)
    const roUpdates = {}
    for (const tmpl of templates) {
      // Skip if a non-completed task with the same title for this RO+phase already
      // exists (e.g. Reassembly created at paint_complete, then user drags to
      // reassembly status manually). Title is part of the key so multiple distinct
      // tasks within a phase (e.g. QC inspection + Final delivery prep) coexist.
      const dupSnap = await getDocs(query(
        collection(db, 'tasks'),
        where('roId', '==', roData.id),
        where('phase', '==', tmpl.phase),
      ))
      const hasOpenDup = dupSnap.docs.some(d => {
        const data = d.data()
        if (tmpl.category === 'paint' && tmpl.taskKind === 'primary') {
          return data.taskKind !== 'secondary' && (tmpl.statusBackfill || data.status !== 'completed')
        }
        return data.title === tmpl.title && data.status !== 'completed'
      })
      if (hasOpenDup) continue
      let assignTo = tmpl.assignedToUid
      if (!assignTo && tmpl.assignedToRole) {
        const emp = employeeList.find(e => e.role === tmpl.assignedToRole)
        assignTo = emp?.uid ?? null
      }
      if (tmpl.setRoField && assignTo) roUpdates[tmpl.setRoField] = assignTo
      await addDoc(collection(db, 'tasks'), {
        roId:          roData.id,
        roNumber:      roData.roNumber,
        vehicleInfo:   roData.vehicle || roData.vehicleInfo || '',
        assignedTo:    assignTo,
        assignedBy:    user.uid,
        assignedByName: employees[user?.uid] ?? user?.email ?? 'Unknown',
        assignedAt:    serverTimestamp(),
        title:         tmpl.title,
        phase:         tmpl.phase,
        category:      tmpl.category,
        taskKind:      tmpl.taskKind,
        autoTriggered: true,
        source:        'auto',
        status:        'pending',
        createdAt:     serverTimestamp(),
        ...(tmpl.noAssigneeNote
          ? { taskNotes: [{ text: tmpl.noAssigneeNote, by: 'System', at: new Date().toISOString() }] }
          : {}),
      })
    }
    if (Object.keys(roUpdates).length) {
      await updateDoc(doc(db, 'ros', roData.id), { ...roUpdates, updatedAt: serverTimestamp() })
    }
  }

  const applyPendingToBody = async ({ ro: explicitRo, bodyManUid, authorized, dropOffDate, hasRental }) => {
    const ro     = explicitRo || pendingToBody?.ro
    if (!ro) return
    if (!employeeHasRole(employeeList, bodyManUid, 'body_man')) {
      toast.error('Body Tech must be assigned to an employee with the Body Technician role.')
      setPendingToBody(null)
      return
    }
    const author  = employees[user?.uid] ?? 'Unknown'
    const paintTeam = defaultPaintTeam(employeeList)
    const painterUid = paintTeam.painter?.uid || ro.assignedPainter || null
    const helperUid = paintTeam.helper?.uid || ro.assignedPaintHelper || null
    const stamp   = new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    const noteText = `Moved to Body Work — Tech: ${employees[bodyManUid] ?? bodyManUid}` +
      (painterUid || helperUid ? `, Paint Team: ${[painterUid, helperUid].filter(Boolean).map(uid => employees[uid] ?? uid).join(' / ')}` : '') +
      `, Authorized: ${authorized ? 'Yes' : 'No'}` +
      `, Drop-off: ${dropOffDate}` +
      (hasRental ? ', Rental: Yes' : '')
    const noteLine   = `[${stamp} - ${author}] ${noteText}`
    const prevNotes  = typeof ro.notes === 'string' ? ro.notes : ''
    await updateDoc(doc(db, 'ros', ro.id), {
      status:              'body_work',
      assignedBodyMan:     bodyManUid,
      assignedPainter:     painterUid,
      assignedPaintHelper: helperUid,
      customerAuthorized:  authorized,
      dropOffDate,
      hasRental,
      carStatus:           'car_in_shop',
      updatedAt:           serverTimestamp(),
      changeLog:           arrayUnion({
        type: 'status_change', value: 'body_work', label: 'Body Work',
        by: author, at: new Date().toISOString(), source: 'drag',
      }),
      notes: prevNotes ? `${noteLine}\n${prevNotes}` : noteLine,
    })
    const updatedRo = { ...ro, assignedBodyMan: bodyManUid, assignedPainter: painterUid, assignedPaintHelper: helperUid }
    await createDownstreamTasks('teardown', updatedRo)
    setPendingToBody(null)
  }

  const activeCount    = ros.filter(r => r.status !== 'delivered').length
  const deliveredCount = deliveredRos.length

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-400 dark:text-zinc-600">
      <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      Loading…
    </div>
  )

  return (
    <div className="space-y-4">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">Production Board</h1>
          <p className="text-sm text-gray-400 dark:text-zinc-500 mt-0.5">
            {activeCount} active · {deliveredCount} delivered
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex bg-gray-100 dark:bg-zinc-800 rounded-lg p-1 gap-0.5">
            {VIEWS.map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs rounded-md font-medium transition-colors
                  ${view === v
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-gray-900 dark:text-gray-100'
                    : 'text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
              >
                {v === 'list' ? <><IconList /> List</> : <><IconGrid /> Kanban</>}
              </button>
            ))}
          </div>

          {view === 'list' && filtered.length > 0 && (
            <button
              onClick={() => handlePrintRos(boardOrderedRos, employees)}
              className="hidden sm:inline-flex items-center gap-1.5 bg-gray-900 dark:bg-gray-100 hover:bg-gray-700 dark:hover:bg-gray-300 text-white dark:text-gray-900 text-sm font-medium px-3 sm:px-4 py-2 rounded-lg transition-colors"
            >
              Print
            </button>
          )}
        </div>
      </div>

      {/* ── AI Quick Update — desktop only (mobile uses the Update tab) */}
      <div ref={quickUpdateRef} className="hidden md:block">
        <AIInputBox
          ros={ros}
          employees={employeeList}
          sharedDraftKey="ro-board-gib-draft"
          compactSubtitle="RO updates / parts / tasks"
          compactPlaceholder="Quick RO update, e.g. RO9448 dropped off, rental, parts ETA, status..."
          fullPlaceholder={'e.g. "RO9448 dropped off 4-25, w/o rental, ordered parts thru PT eta 4-29"'}
        />
      </div>
      {showStickyGib && (
        <div className="fixed left-4 right-4 top-[64px] z-40 hidden md:block xl:left-[calc((100vw-1184px)/2)] xl:right-[calc((100vw-1184px)/2)]">
          <AIInputBox
            ros={ros}
            employees={employeeList}
            compact
            sharedDraftKey="ro-board-gib-draft"
            compactSubtitle="RO updates / parts / tasks"
            compactPlaceholder="Quick RO update, e.g. RO9448 dropped off, rental, parts ETA, status..."
            fullPlaceholder={'e.g. "RO9448 dropped off 4-25, w/o rental, ordered parts thru PT eta 4-29"'}
          />
        </div>
      )}

      <MonthlyRevenueProgress
        ros={ros}
        goal={monthlyRepairGoal}
        selectedMonth={revenueMonth}
        onMonthChange={setRevenueMonth}
        canReconcile={isManager}
        onOpenReconcile={() => setShowRevenueReconcile(true)}
      />
      {showRevenueReconcile && (
        <RevenueReconcileModal
          ros={ros}
          selectedMonth={revenueMonth}
          onClose={() => setShowRevenueReconcile(false)}
        />
      )}

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {/* Search */}
        <div className="relative">
          <span className="absolute left-3 top-2.5 text-gray-400 dark:text-zinc-500">
            <IconSearch />
          </span>
          <input
            type="text"
            placeholder="Search RO#, name, vehicle, insurance…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 dark:border-zinc-800 rounded-lg text-sm bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:ring-opacity-20"
          />
        </div>

        {/* Clickable status pills — horizontal scroll on mobile, wrap on desktop */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => setFilterStatus('all')}
            className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
              ${filterStatus === 'all'
                ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-transparent'
                : 'bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
          >
            All <span className="opacity-60 ml-0.5">{activeCount}</span>
          </button>
          {RO_STATUSES.filter(s => s.key !== 'delivered').map(s => {
            const count = statusCounts[s.key] || 0
            if (count === 0 && filterStatus !== s.key) return null
            return (
              <button
                key={s.key}
                onClick={() => setFilterStatus(prev => prev === s.key ? 'all' : s.key)}
                className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
                  ${filterStatus === s.key
                    ? `${s.color} border-transparent`
                    : 'bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${s.dot}`} />
                {s.label}
                <span className="opacity-60 ml-1">{count}</span>
              </button>
            )
          })}

          {/* Show Delivered toggle */}
          {deliveredCount > 0 && (
            <button
              onClick={() => setShowDeliveredArchive(v => !v)}
              className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium border transition-colors
                ${showDeliveredArchive
                  ? 'bg-zinc-700 dark:bg-zinc-300 text-white dark:text-zinc-900 border-transparent'
                  : 'bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border-gray-200 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500'}`}
            >
              {showDeliveredArchive ? '✓ ' : ''}Delivered
              <span className="opacity-60 ml-1">{deliveredCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <div className="text-center py-24 text-gray-400 dark:text-zinc-600">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M16 6l-1.5-3h-5L8 6M3 10l1-4h16l1 4M5 10v7a1 1 0 001 1h1a1 1 0 001-1v-1h8v1a1 1 0 001 1h1a1 1 0 001-1v-7"/>
            <circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="16.5" cy="11.5" r="1" fill="currentColor"/>
          </svg>
          <p className="font-medium">No repair orders found</p>
        </div>
      )}

      {/* ── List view ────────────────────────────────────────────────────── */}
      {view === 'list' && filtered.length > 0 && (
        <>
        <div className="space-y-2 sm:hidden">
          {sortedListRos.map(ro => (
            <MobileListCard key={ro.id} ro={ro} onSelect={setSelectedRO} />
          ))}
        </div>
        <div className="hidden sm:block bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-zinc-800 text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="RO #" column="roNumber" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Insurance / Vehicle / Owner" column="vehicle" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Status" column="status" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Estimator" column="estimator" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Body Tech" column="bodyTech" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Parts" column="parts" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Drop-off" column="dropOff" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3 text-left font-semibold"><SortHeader label="Due" column="due" sort={listSort} onSort={handleListSort} /></th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                {sortedListRos.map(ro => <RORow key={ro.id} ro={ro} employees={employees} onSelect={setSelectedRO} />)}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {/* ── Kanban view ───────────────────────────────────────────────────── */}
      {view === 'kanban' && filtered.length > 0 && (
        <>
          <div className="space-y-3 sm:hidden">
            {mainKanbanGroups.map(group => (
              <section key={group.key} className="space-y-2">
                <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${group.accent} ${group.color}`}>
                  <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                  <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map(ro => (
                    <MobileROCard key={ro.id} ro={ro} onSelect={setSelectedRO} />
                  ))}
                  {group.items.length === 0 && (
                    <div className="rounded-xl border border-dashed border-gray-200 py-4 text-center text-xs text-gray-300 dark:border-zinc-800 dark:text-zinc-700">No vehicles</div>
                  )}
                </div>
                {group.key === 'PENDING' && totalLossGroup && totalLossGroup.items.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${totalLossGroup.accent} ${totalLossGroup.color}`}>
                      <span className={`text-sm font-bold ${totalLossGroup.header}`}>{totalLossGroup.label}</span>
                      <span className={`ml-auto text-xs font-semibold ${totalLossGroup.header} opacity-70`}>{totalLossGroup.items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {totalLossGroup.items.map(ro => (
                        <MobileROCard key={ro.id} ro={ro} onSelect={setSelectedRO} />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>

          {/* Desktop: full kanban */}
          <div className="hidden sm:grid sm:grid-cols-5 gap-3 pb-4">
            {mainKanbanGroups.map(group => (
              <div
                key={group.key}
                className="min-w-0"
                onDragOver={e => { e.preventDefault(); setDragOverGroup(group.key) }}
                onDragLeave={() => { setDragOverGroup(null); setDragOverCard(null) }}
                onDrop={() => handleDrop(group)}
              >
                <div className={`flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl border transition-colors
                  ${dragOverGroup === group.key ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30' : `${group.accent} ${group.color}`}`}>
                  <span className={`text-sm font-bold ${group.header}`}>{group.label}</span>
                  <span className={`ml-auto text-xs font-semibold ${group.header} opacity-70`}>{group.items.length}</span>
                </div>
                <div className={`space-y-2.5 min-h-[60px] rounded-xl transition-colors ${dragOverGroup === group.key ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                  {group.items.map(ro => (
                    <KanbanCard
                      key={ro.id}
                      ro={ro}
                      onSelect={setSelectedRO}
                      draggable={isManager}
                      isDragging={dragRoId === ro.id}
                      dropPosition={dragOverCard?.roId === ro.id ? dragOverCard.position : null}
                      onDragStart={() => setDragRoId(ro.id)}
                      onDragEnd={() => { setDragRoId(null); setDragOverGroup(null); setDragOverCard(null) }}
                      onDragOver={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (!dragRoId || dragRoId === ro.id) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                        setDragOverGroup(group.key)
                        setDragOverCard({ roId: ro.id, position })
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleCardDrop(group, ro.id, dragOverCard?.roId === ro.id ? dragOverCard.position : 'before')
                      }}
                    />
                  ))}
                  {group.items.length === 0 && (
                    <div className="text-center py-6 text-gray-300 dark:text-zinc-700 text-xs">—</div>
                  )}
                </div>
                {group.key === 'PENDING' && totalLossGroup && totalLossGroup.items.length > 0 && (
                  <div className="mt-3">
                    <div
                      className={`flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl border transition-colors
                        ${dragOverGroup === totalLossGroup.key ? 'border-red-400 bg-red-50 dark:bg-red-950/30' : `${totalLossGroup.accent} ${totalLossGroup.color}`}`}
                      onDragOver={e => { e.preventDefault(); setDragOverGroup(totalLossGroup.key) }}
                      onDragLeave={() => { setDragOverGroup(null); setDragOverCard(null) }}
                      onDrop={() => handleDrop(totalLossGroup)}
                    >
                      <span className={`text-sm font-bold ${totalLossGroup.header}`}>{totalLossGroup.label}</span>
                      <span className={`ml-auto text-xs font-semibold ${totalLossGroup.header} opacity-70`}>{totalLossGroup.items.length}</span>
                    </div>
                    <div
                      className={`space-y-2.5 min-h-[44px] rounded-xl transition-colors ${dragOverGroup === totalLossGroup.key ? 'bg-red-50/60 dark:bg-red-950/10' : ''}`}
                      onDragOver={e => { e.preventDefault(); setDragOverGroup(totalLossGroup.key) }}
                      onDragLeave={() => { setDragOverGroup(null); setDragOverCard(null) }}
                      onDrop={() => handleDrop(totalLossGroup)}
                    >
                      {totalLossGroup.items.map(ro => (
                        <KanbanCard
                          key={ro.id}
                          ro={ro}
                          onSelect={setSelectedRO}
                          draggable={isManager}
                          isDragging={dragRoId === ro.id}
                          dropPosition={dragOverCard?.roId === ro.id ? dragOverCard.position : null}
                          onDragStart={() => setDragRoId(ro.id)}
                          onDragEnd={() => { setDragRoId(null); setDragOverGroup(null); setDragOverCard(null) }}
                          onDragOver={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (!dragRoId || dragRoId === ro.id) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                            setDragOverGroup(totalLossGroup.key)
                            setDragOverCard({ roId: ro.id, position })
                          }}
                          onDrop={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleCardDrop(totalLossGroup, ro.id, dragOverCard?.roId === ro.id ? dragOverCard.position : 'before')
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Status picker modal (for multi-status columns) ───────────────── */}
      {deliveredCount > 0 && (
        <div className="border-t border-gray-200 dark:border-zinc-800 pt-4">
          <button
            onClick={() => setShowDeliveredArchive(v => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500"
          >
            Delivered Vehicles
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-zinc-800 dark:text-zinc-400">{deliveredCount}</span>
          </button>
          {showDeliveredArchive && (
            <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-gray-400 dark:border-zinc-800 dark:text-zinc-500">
                      <th className="px-4 py-3 text-left font-semibold">RO #</th>
                      <th className="px-4 py-3 text-left font-semibold">Vehicle</th>
                      <th className="px-4 py-3 text-left font-semibold">Owner</th>
                      <th className="px-4 py-3 text-left font-semibold">Insurance</th>
                      <th className="px-4 py-3 text-left font-semibold">Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                    {deliveredRos.map(ro => (
                      <tr key={ro.id} onClick={() => setSelectedRO(ro)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50">
                        <td className="px-4 py-3 font-mono text-sm font-bold text-gray-900 dark:text-gray-100">#{ro.roNumber}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 dark:text-zinc-300">{ro.vehicle}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{ro.customerName}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{shortInsurance(ro.insuranceCompany)}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-zinc-400">{fmtDate(ro.cccDateOut || ro.promisedDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {statusPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-xs border border-gray-200 dark:border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
              <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">Set Status</p>
            </div>
            <div className="p-3 space-y-1.5">
              {statusPicker.statuses.map(s => {
                const info = STATUS_MAP[s]
                return (
                  <button
                    key={s}
                    onClick={() => { applyStatusDrop(statusPicker.roId, s); setStatusPicker(null) }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className={`w-2 h-2 rounded-full ${info?.dot}`} />
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{info?.label ?? s}</span>
                  </button>
                )
              })}
            </div>
            <div className="px-4 py-3 border-t border-gray-100 dark:border-zinc-800">
              <button
                onClick={() => setStatusPicker(null)}
                className="w-full py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-gray-200"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── PendingToBodyModal ───────────────────────────────────────────── */}
      {pendingToBody && (
        <PendingToBodyModal
          ro={pendingToBody.ro}
          employees={employeeList}
          onConfirm={applyPendingToBody}
          onCancel={() => setPendingToBody(null)}
        />
      )}

      {/* ── RODrawer ────────────────────────────────────────────────────────── */}
      {selectedRO && (
        <RODrawer
          ro={selectedRO}
          employees={employees}
          onClose={() => setSelectedRO(null)}
        />
      )}
    </div>
  )
}


