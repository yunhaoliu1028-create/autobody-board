// ─── AutoBody Board – Daily Auto-Sync Service Worker ─────────────────────────
// Fires every morning at 8:00 AM local time.
// Calls the CCC shared-board API directly (no tab scraping needed) and syncs
// all ROs to Firebase Firestore.

const FIREBASE = {
  apiKey:    'AIzaSyAKFLU9a0ORp24kBcUp-6zK9K_a4qUfEwU',
  projectId: 'bodyshop-board',
}

const REFRESH_URL    = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`
const FIRESTORE_URL  = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`
const COMMIT_URL     = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents:commit`

const ALARM_NAME     = 'daily-ccc-sync'
// Read-only shared board — no login page, uses browser session cookies
const CCC_API_URL    = 'https://estimate.cccone.com/configure/api/shared-board/6fde700e-fc9b-4a05-ac9d-4eeddb2b38c5'

// ── Alarm setup ───────────────────────────────────────────────────────────────
function scheduleDaily8AM() {
  const now  = new Date()
  const next = new Date(now)
  next.setHours(8, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)

  chrome.alarms.get(ALARM_NAME, existing => {
    if (!existing || Math.abs(existing.scheduledTime - next.getTime()) > 5 * 60 * 1000) {
      chrome.alarms.create(ALARM_NAME, { when: next.getTime(), periodInMinutes: 24 * 60 })
      console.log('[AutoBody] Daily sync alarm set for', next.toLocaleString())
    }
  })
}

chrome.runtime.onInstalled.addListener(scheduleDaily8AM)
chrome.runtime.onStartup.addListener(scheduleDaily8AM)

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return
  console.log('[AutoBody] Daily auto-sync triggered at', new Date().toLocaleString())
  await runAutoSync()
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'MANUAL_SYNC') {
    runAutoSync().then(log => sendResponse({ ok: true, log })).catch(err => sendResponse({ ok: false, error: err.message }))
    return true
  }
})

// ── Main sync flow ────────────────────────────────────────────────────────────
async function runAutoSync() {
  _idToken      = null
  _refreshToken = null

  const log = {
    startedAt:        new Date().toISOString(),
    steps:            [],
    error:            null,
    syncResults:      [],
    deliveredResults: [],
    completedAt:      null,
  }

  try {
    // 1. Refresh Firebase auth
    const saved = await chromeGet('auth')
    if (!saved?.refreshToken) {
      log.error = '未登录 — 请先在扩展弹窗里登录 AutoBody Board'
      await saveLog(log); return log
    }
    await refreshIdToken(saved)
    log.steps.push('✓ Firebase 认证已刷新')

    // 2. Fetch CCC board data via API (uses browser session cookies)
    const scannedROs = await scanCCCViaAPI()
    log.steps.push(`✓ 从 CCC API 读取到 ${scannedROs.length} 个 RO`)

    // 3. Load existing Firebase data
    const [existingROs, users] = await Promise.all([loadExistingROs(), loadUsers()])
    log.steps.push(`✓ Firebase 中已有 ${existingROs.size} 个 RO`)

    // 4. Sync all ROs
    const timestamp = new Date().toISOString()
    for (const ro of scannedROs) {
      try {
        const existing = existingROs.get(ro.roNumber) || null
        await writeRO(ro, timestamp, existing?.docName || null, existing, users)
        log.syncResults.push({ roNumber: ro.roNumber, ok: true, updated: !!existing })
      } catch (err) {
        log.syncResults.push({ roNumber: ro.roNumber, ok: false, msg: err.message })
      }
    }

    // 5. Auto-mark ROs missing from CCC as delivered
    log.deliveredResults = await autoMarkMissingDelivered(scannedROs, existingROs, timestamp)

    const ok   = log.syncResults.filter(r => r.ok).length
    const fail = log.syncResults.filter(r => !r.ok).length
    log.steps.push(`✓ 同步完成: ${ok} 成功${fail ? `，${fail} 失败` : ''}`)
    if (log.deliveredResults.length) {
      log.steps.push(`✓ 标记已交车: ${log.deliveredResults.filter(r => r.ok).length} 个`)
    }
    log.completedAt = new Date().toISOString()

  } catch (err) {
    log.error = err.message
    console.error('[AutoBody] Auto-sync error:', err)
  }

  await saveLog(log)
  console.log('[AutoBody] Auto-sync log:', log)
  return log
}

// ── CCC shared-board API ──────────────────────────────────────────────────────
// The extension service worker shares the browser's cookie jar, so fetch with
// credentials:'include' works as long as the user has an active CCC session.
async function scanCCCViaAPI() {
  const res = await fetch(CCC_API_URL, { credentials: 'include' })

  if (res.status === 401) {
    throw new Error('CCC session 已过期 — 请打开 Chrome 并访问一次 CCC ONE 看板以刷新登录状态')
  }
  if (!res.ok) {
    throw new Error(`CCC API 返回错误 ${res.status}`)
  }

  const data = await res.json()
  if (data.isRedirect) {
    throw new Error('CCC 要求重新登录 — 请手动打开 CCC ONE 并登录')
  }

  const board = data.productionBoard
  const ros   = []

  for (const column of (board.columns || [])) {
    for (const card of (column.cards || [])) {
      // Build a fieldType → fieldData lookup
      const f = {}
      for (const field of (card.fields || [])) {
        f[field.fieldType] = field.fieldData
      }

      ros.push({
        roNumber:         String(card.repairOrderNumber),
        cccColumn:        column.columnName || '',
        vehicle:          parseCCCVehicle(f[21] || ''),
        customerName:     f[11] || '',
        insuranceCompany: f[8]  || card.carrier || '',
        claimNumber:      f[3]  || '',
        estimatorName:    f[26] || card.estimator || '',
        totalAmount:      parseCCCMoney(f[7] || ''),
        laborHrs:         String(f[10] || ''),
        paintHrs:         String(f[14] || ''),
        paintCode:        f[12] || '',
        vehicleColor:     f[13] || '',
        vin:              f[24] || '',
        dateIn:           parseCCCDate(f[22] || ''),
        promisedDate:     parseCCCDate(f[23] || ''),
      })
    }
  }

  if (!ros.length) throw new Error('CCC 看板上没有找到任何 RO — 请确认看板已有数据')
  return ros
}

function parseCCCVehicle(raw) {
  if (!raw) return ''
  // CCC format: "25 Hyundai Ioniq 5 SEL RWD" → "2025 Hyundai Ioniq 5 SEL RWD"
  const m = raw.match(/^(\d{2})\s+(.+)/)
  if (!m) return raw
  const yr       = parseInt(m[1])
  const fullYear = yr <= 35 ? `20${String(yr).padStart(2, '0')}` : `19${String(yr).padStart(2, '0')}`
  return `${fullYear} ${m[2]}`
}

function parseCCCMoney(str) {
  return str.replace(/[$,]/g, '').trim()
}

function parseCCCDate(str) {
  if (!str || str === '--' || str === '—') return ''
  // CCC format: "5/1/26" → "2026-05-01"
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return ''
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3]
  return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
}

// ── Firebase auth ─────────────────────────────────────────────────────────────
let _idToken      = null
let _refreshToken = null

async function refreshIdToken(savedAuth) {
  const rt = savedAuth?.refreshToken || _refreshToken
  if (!rt) throw new Error('No refresh token — please sign in again.')

  const res  = await fetch(REFRESH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || 'Token refresh failed')

  _idToken      = data.id_token
  _refreshToken = data.refresh_token
  const saved   = await chromeGet('auth')
  await chromeSet('auth', { ...saved, idToken: _idToken, refreshToken: _refreshToken })
}

async function authFetch(url, options = {}) {
  if (!_idToken) {
    const saved   = await chromeGet('auth')
    _idToken      = saved?.idToken
    _refreshToken = saved?.refreshToken
  }

  const doFetch = () => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${_idToken}` },
  })

  let res = await doFetch()
  if (res.status === 401) {
    const saved = await chromeGet('auth')
    await refreshIdToken(saved)
    res = await doFetch()
  }
  return res
}

// ── Firestore read helpers ────────────────────────────────────────────────────
async function loadExistingROs() {
  const map = new Map()
  try {
    const fields = ['roNumber', 'totalAmount', 'cccColumn', 'status', 'vehicle', 'customerName', 'paintHrs', 'needsPaint', 'assignedPainter', 'assignedPaintHelper']
    const mask   = fields.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&')
    const res    = await authFetch(`${FIRESTORE_URL}/ros?pageSize=500&${mask}`)
    if (!res.ok) return map
    const data   = await res.json()
    for (const doc of (data.documents || [])) {
      const roNum = doc.fields?.roNumber?.stringValue
      if (!roNum) continue
      map.set(roNum, {
        docName:             doc.name,
        totalAmount:         doc.fields?.totalAmount?.stringValue         || '',
        cccColumn:           doc.fields?.cccColumn?.stringValue           || '',
        status:              doc.fields?.status?.stringValue              || '',
        vehicle:             doc.fields?.vehicle?.stringValue             || '',
        customerName:        doc.fields?.customerName?.stringValue        || '',
        paintHrs:            doc.fields?.paintHrs?.stringValue            || '',
        needsPaint:          doc.fields?.needsPaint?.booleanValue,
        assignedPainter:     doc.fields?.assignedPainter?.stringValue     || '',
        assignedPaintHelper: doc.fields?.assignedPaintHelper?.stringValue || '',
      })
    }
  } catch (e) {
    console.warn('[AutoBody] loadExistingROs error:', e)
  }
  return map
}

async function loadUsers() {
  try {
    const fields = ['name', 'email', 'role']
    const mask   = fields.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&')
    const res    = await authFetch(`${FIRESTORE_URL}/users?pageSize=200&${mask}`)
    if (!res.ok) return []
    const data   = await res.json()
    return (data.documents || []).map(doc => ({
      uid:  doc.name.split('/').pop(),
      name: doc.fields?.name?.stringValue  || doc.fields?.email?.stringValue || '',
      role: doc.fields?.role?.stringValue  || '',
    }))
  } catch (e) {
    return []
  }
}

// ── Auto-mark missing ROs as delivered ───────────────────────────────────────
async function autoMarkMissingDelivered(scannedROs, existingROs, timestamp) {
  const scannedSet = new Set(scannedROs.map(r => r.roNumber))
  const results    = []
  for (const [roNum, info] of existingROs) {
    if (scannedSet.has(roNum) || info.status === 'delivered') continue
    try {
      const write = {
        update: {
          name:   info.docName,
          fields: { status: strVal('delivered'), updatedAt: strVal(timestamp) },
        },
        updateMask:       { fieldPaths: ['status', 'updatedAt'] },
        updateTransforms: [
          { fieldPath: 'gibRevision', increment: { integerValue: '1' } },
          {
            fieldPath:             'changeLog',
            appendMissingElements: { values: [changeLogEntry('status', 'Delivered', timestamp)] },
          },
        ],
      }
      const res = await authFetch(COMMIT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ writes: [write] }),
      })
      results.push({ roNumber: roNum, ok: res.ok })
    } catch (e) {
      results.push({ roNumber: roNum, ok: false, msg: e.message })
    }
  }
  return results
}

// ── Write single RO to Firestore ──────────────────────────────────────────────
async function writeRO(ro, timestamp, existingDocName, oldData, users) {
  const estimatorUser = findUserByName(ro.estimatorName, ['estimator', 'shop_manager', 'production_manager'], users)
  const wantsPaint    = parsePaintHrs(ro.paintHrs) > 0
  const painterUser   = wantsPaint ? findUniqueUserByRole('painter', users)      : null
  const helperUser    = wantsPaint ? findUniqueUserByRole('paint_helper', users) : null

  if (existingDocName) {
    const updateFields = {
      customerName:     strVal(ro.customerName),
      vehicle:          strVal(ro.vehicle),
      vehicleColor:     strVal(ro.vehicleColor),
      vin:              strVal(ro.vin),
      insuranceCompany: strVal(ro.insuranceCompany),
      claimNumber:      strVal(ro.claimNumber),
      estimatorName:    strVal(ro.estimatorName),
      cccDateIn:        strVal(ro.dateIn),
      cccDateOut:       strVal(ro.promisedDate),
      cccColumn:        strVal(ro.cccColumn || ''),
      totalAmount:      strVal(ro.totalAmount),
      laborHrs:         strVal(ro.laborHrs),
      paintHrs:         strVal(ro.paintHrs),
      paintCode:        strVal(ro.paintCode),
      updatedAt:        strVal(timestamp),
      cccLastSync:      strVal(timestamp),
    }
    if (estimatorUser?.uid) updateFields.assignedEstimator = strVal(estimatorUser.uid)
    // Auto-upgrade to needsPaint=true when CCC reports paint hours; never downgrade
    if (wantsPaint && oldData?.needsPaint !== true) {
      updateFields.needsPaint = { booleanValue: true }
    }
    if (wantsPaint && painterUser?.uid && !oldData?.assignedPainter) {
      updateFields.assignedPainter = strVal(painterUser.uid)
    }
    if (wantsPaint && helperUser?.uid && !oldData?.assignedPaintHelper) {
      updateFields.assignedPaintHelper = strVal(helperUser.uid)
    }

    const logEntries = []
    if (oldData) {
      const newAmt = String(ro.totalAmount || '')
      const newCol = String(ro.cccColumn   || '')
      if (oldData.totalAmount && newAmt && oldData.totalAmount !== newAmt)
        logEntries.push(changeLogEntry('amount',    `$${Number(oldData.totalAmount).toLocaleString()} → $${Number(newAmt).toLocaleString()}`, timestamp))
      if (oldData.cccColumn   && newCol && oldData.cccColumn   !== newCol)
        logEntries.push(changeLogEntry('cccColumn', `${oldData.cccColumn} → ${newCol}`, timestamp))
    }

    const write = {
      update:     { name: existingDocName, fields: updateFields },
      updateMask: { fieldPaths: Object.keys(updateFields) },
      updateTransforms: [{ fieldPath: 'gibRevision', increment: { integerValue: '1' } }],
    }
    if (logEntries.length) {
      write.updateTransforms.push({ fieldPath: 'changeLog', appendMissingElements: { values: logEntries } })
    }

    const res = await authFetch(COMMIT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ writes: [write] }),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `HTTP ${res.status}`) }
    return res.json()

  } else {
    const body = {
      fields: {
        roNumber:             strVal(ro.roNumber),
        customerName:         strVal(ro.customerName),
        vehicle:              strVal(ro.vehicle),
        vehicleColor:         strVal(ro.vehicleColor),
        vin:                  strVal(ro.vin),
        insuranceCompany:     strVal(ro.insuranceCompany),
        claimNumber:          strVal(ro.claimNumber),
        estimatorName:        strVal(ro.estimatorName),
        cccDateIn:            strVal(ro.dateIn),
        cccDateOut:           strVal(ro.promisedDate),
        cccImported:          { booleanValue: true },
        cccColumn:            strVal(ro.cccColumn || ''),
        cccLastSync:          strVal(timestamp),
        eta:                  strVal(ro.promisedDate),
        dropOffDate:          strVal(''),
        carStatus:            strVal('pending_dropoff'),
        status:               strVal('checked_in'),
        partsStatus:          strVal('not_ordered'),
        totalAmount:          strVal(ro.totalAmount),
        laborHrs:             strVal(ro.laborHrs),
        paintHrs:             strVal(ro.paintHrs),
        paintCode:            strVal(ro.paintCode),
        notes:                strVal(''),
        needsPaint:           { booleanValue: wantsPaint },
        assignedEstimator:    strVal(estimatorUser?.uid || ''),
        assignedBodyMan:      strVal(''),
        assignedPainter:      strVal((wantsPaint && painterUser?.uid) || ''),
        assignedPaintHelper:  strVal((wantsPaint && helperUser?.uid) || ''),
        assignedPartsManager: strVal(''),
        gibRevision:          { integerValue: '0' },
        createdAt:            strVal(timestamp),
        updatedAt:            strVal(timestamp),
        source:               strVal('auto_sync'),
      }
    }

    const res = await authFetch(`${FIRESTORE_URL}/ros`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `HTTP ${res.status}`) }
    return res.json()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function strVal(v) { return { stringValue: String(v ?? '') } }

function changeLogEntry(type, value, timestamp) {
  return {
    mapValue: {
      fields: {
        type:   { stringValue: type },
        value:  { stringValue: value },
        by:     { stringValue: 'Auto Sync' },
        at:     { stringValue: timestamp },
        source: { stringValue: 'auto_sync' },
      }
    }
  }
}

function normalizeName(value = '') {
  return value.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Parse CCC paint hours string ('--', '', '0', '1.5') → number; non-numeric → 0
function parsePaintHrs(v) {
  if (v == null) return 0
  const s = String(v).trim()
  if (!s || s === '--') return 0
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

// Returns the single user with the given role, or null if 0 or 2+ exist
function findUniqueUserByRole(role, users = []) {
  const matches = users.filter(u => u.role === role)
  return matches.length === 1 ? matches[0] : null
}

function findUserByName(rawName = '', roles = [], users = []) {
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  const candidates  = users.filter(u => !roles.length || roles.includes(u.role))
  return candidates.find(u => {
    const name = normalizeName(u.name)
    if (!name) return false
    if (name === target) return true
    const nameParts = name.split(' ').filter(Boolean)
    return targetParts.every(p => nameParts.some(n => n === p || n.startsWith(p) || p.startsWith(n)))
  }) || null
}

// ── Sync log ──────────────────────────────────────────────────────────────────
async function saveLog(log) {
  const logs = (await chromeGet('autoSyncLogs')) || []
  logs.unshift(log)
  if (logs.length > 14) logs.splice(14)
  await chromeSet('autoSyncLogs', logs)
}

function chromeGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])))
}
function chromeSet(key, val) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: val }, resolve))
}
