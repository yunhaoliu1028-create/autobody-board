// ─── AutoBody Board – Extension Popup ────────────────────────────────────────

const FIREBASE = {
  apiKey:    'AIzaSyAKFLU9a0ORp24kBcUp-6zK9K_a4qUfEwU',
  projectId: 'bodyshop-board',
}

const AUTH_URL      = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE.apiKey}`
const REFRESH_URL   = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`
const COMMIT_URL    = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents:commit`

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── State ─────────────────────────────────────────────────────────────────────
let idToken      = null
let refreshToken = null
let scannedROs   = []           // all ROs from CCC
let existingROs  = new Map()    // roNumber → { docName, totalAmount, cccColumn, status, vehicle, customerName }
let users         = []           // { uid, name, role } for CCC estimator auto-assignment

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Restore saved auth
  const saved = await chromeGet('auth')
  if (saved?.idToken) {
    idToken      = saved.idToken
    refreshToken = saved.refreshToken || null
    showMain(saved.displayName || saved.email)
  } else {
    showLogin()
  }

  // Wire up events
  $('login-btn').addEventListener('click',   handleLogin)
  $('logout-btn').addEventListener('click',  handleLogout)
  $('scan-btn').addEventListener('click',    handleScan)
  $('sync-btn').addEventListener('click',    handleSync)
  $('sel-all-link').addEventListener('click',   () => setAllChecked(true))
  $('desel-all-link').addEventListener('click', () => setAllChecked(false))
  $('dt-btn').addEventListener('click',      handleDingTalkImport)
  $('save-url-btn').addEventListener('click', handleSaveUrl)

  // Enter key on password field
  $('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin()
  })

  // Load saved app URL
  const savedUrl = await chromeGet('appUrl')
  if (savedUrl) $('app-url').value = savedUrl
})

// ── Auth ──────────────────────────────────────────────────────────────────────
async function handleLogin() {
  const email    = $('login-email').value.trim()
  const password = $('login-password').value
  if (!email || !password) return

  setBtn('login-btn', '⏳ Signing in…', true)
  $('login-error').style.display = 'none'

  try {
    const res  = await fetch(AUTH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, returnSecureToken: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Login failed')

    idToken      = data.idToken
    refreshToken = data.refreshToken || null
    const displayName = data.displayName || email.split('@')[0]

    await chromeSet('auth', { idToken, refreshToken, email, displayName })
    showMain(displayName)

  } catch (err) {
    showError('login-error', friendlyAuthError(err.message))
    setBtn('login-btn', 'Sign In', false)
  }
}

async function handleLogout() {
  await chromeRemove('auth')
  idToken = null
  refreshToken = null
  scannedROs = []
  showLogin()
}

// ── Token refresh ─────────────────────────────────────────────────────────────
// Firebase ID tokens expire after 1 hour. This exchanges the refreshToken for
// a new idToken automatically, so users never need to re-login during the day.
async function refreshIdToken() {
  if (!refreshToken) throw new Error('No refresh token — please sign in again.')
  const res  = await fetch(REFRESH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || 'Token refresh failed')

  idToken      = data.id_token
  refreshToken = data.refresh_token  // Firebase rotates the refresh token too

  // Persist updated tokens
  const saved = await chromeGet('auth')
  await chromeSet('auth', { ...saved, idToken, refreshToken })
  console.log('[AutoBody] Token refreshed successfully')
}

// ── Auth-aware fetch — auto-retries once after token refresh on 401 ────────────
async function authFetch(url, options = {}) {
  const doFetch = () => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${idToken}` },
  })

  let res = await doFetch()

  // If 401 (token expired), refresh and retry once
  if (res.status === 401) {
    try {
      await refreshIdToken()
      res = await doFetch()
    } catch (refreshErr) {
      // Refresh failed — force re-login
      await handleLogout()
      throw new Error('Session expired — please sign in again.')
    }
  }

  return res
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function handleScan() {
  setBtn('scan-btn', '<span class="spinner"></span> Scanning…', true)
  $('main-msg').style.display = 'none'
  $('results-area').style.display = 'none'
  $('sync-results').style.display = 'none'

  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url?.includes('cccone.com')) {
      showMsg('main-msg', 'alert-warn', '⚠ Please navigate to the CCC Production Board first, then click Scan again.')
      setBtn('scan-btn', '🔍 Scan CCC Board', false)
      return
    }

    // Inject content script if needed & run scan
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content.js'],
    }).catch(() => {}) // already injected is fine

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => window.__autobodyScanner?.scan(),
    })

    const data = results?.[0]?.result
    if (!data)          throw new Error('Could not read CCC page. Try refreshing CCC first.')
    if (data.error)     throw new Error(data.error)
    if (!data.ros?.length) throw new Error('No RO cards found. Make sure the Production Board is loaded.')

    scannedROs = data.ros

    // Load existing RO numbers from Firebase
    await loadExistingROs()

    renderROList()
    renderPossiblyDelivered()
    $('results-area').style.display = 'block'
    $('found-count').textContent = `${scannedROs.length} ROs found · ${existingROs.size} already in system (will update data only)`

  } catch (err) {
    showMsg('main-msg', 'alert-error', '❌ ' + err.message)
  } finally {
    setBtn('scan-btn', '🔍 Scan CCC Board', false)
  }
}

// ── Detect ROs in Firestore but absent from the current CCC scan ──────────────
function renderPossiblyDelivered() {
  // Remove previous section if any
  const prev = $('possibly-delivered')
  if (prev) prev.remove()

  const scannedSet = new Set(scannedROs.map(r => r.roNumber))
  const missing    = []
  for (const [roNum, info] of existingROs) {
    if (!scannedSet.has(roNum) && info.status !== 'delivered') {
      missing.push({ roNum, ...info })
    }
  }

  if (!missing.length) return

  const section = document.createElement('div')
  section.id = 'possibly-delivered'
  section.style.cssText = 'margin-top:12px;'

  section.innerHTML = `
    <div style="font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
      🚗 Not on CCC Board — Possibly Delivered (${missing.length})
    </div>
    <div style="font-size:11px;color:#78350f;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;margin-bottom:6px;">
      These ROs are in your board but absent from CCC — car may have been delivered or RO closed.
    </div>
    <div id="possibly-delivered-list"></div>
  `

  const list = section.querySelector('#possibly-delivered-list')
  for (const info of missing) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:#fff;border:1px solid #fde68a;border-radius:6px;margin-bottom:4px;'
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <span style="font-weight:700;color:#1d4ed8">#${info.roNum}</span>
        <span style="color:#475569;font-size:11px;margin-left:6px;">${info.vehicle || ''} ${info.customerName ? '· ' + info.customerName : ''}</span>
      </div>
      <button class="mark-delivered-btn" data-ronum="${info.roNum}" data-docname="${info.docName}"
        style="padding:3px 8px;background:#f59e0b;color:white;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">
        Mark Delivered
      </button>
    `
    list.appendChild(row)
  }

  // Wire up buttons
  section.querySelectorAll('.mark-delivered-btn').forEach(btn => {
    btn.addEventListener('click', () => handleMarkDelivered(btn.dataset.ronum, btn.dataset.docname, btn))
  })

  // Insert after sync-results
  const anchor = $('sync-results')
  anchor.parentNode.insertBefore(section, anchor.nextSibling)
}

// ── Mark an RO as delivered ───────────────────────────────────────────────────
function getMissingDeliveredCandidates() {
  const scannedSet = new Set(scannedROs.map(r => r.roNumber))
  const missing = []
  for (const [roNum, info] of existingROs) {
    if (!scannedSet.has(roNum) && info.status !== 'delivered') {
      missing.push({ roNum, ...info })
    }
  }
  return missing
}

async function markDeliveredDoc(roNum, docName, timestamp = new Date().toISOString()) {
  const write = {
    update: {
      name: docName,
      fields: {
        status:    strVal('delivered'),
        updatedAt: strVal(timestamp),
      }
    },
    updateMask: { fieldPaths: ['status', 'updatedAt'] },
    updateTransforms: [{
      fieldPath: 'changeLog',
      appendMissingElements: {
        values: [changeLogEntry('status', 'Delivered', timestamp)]
      }
    }]
  }

  const res = await authFetch(COMMIT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ writes: [write] }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error?.message || `HTTP ${res.status}`)
  }

  if (existingROs.has(roNum)) existingROs.get(roNum).status = 'delivered'
}

async function autoMarkMissingDelivered(timestamp) {
  const results = []
  for (const info of getMissingDeliveredCandidates()) {
    try {
      await markDeliveredDoc(info.roNum, info.docName, timestamp)
      results.push({ roNumber: info.roNum, ok: true })
    } catch (err) {
      results.push({ roNumber: info.roNum, ok: false, msg: err.message })
    }
  }
  return results
}

async function handleMarkDelivered(roNum, docName, btn) {
  btn.disabled  = true
  btn.textContent = '…'
  const timestamp = new Date().toISOString()

  try {
    const write = {
      update: {
        name: docName,
        fields: {
          status:    strVal('delivered'),
          updatedAt: strVal(timestamp),
        }
      },
      updateMask: { fieldPaths: ['status', 'updatedAt'] },
      updateTransforms: [{
        fieldPath: 'changeLog',
        appendMissingElements: {
          values: [changeLogEntry('status', 'Delivered', timestamp)]
        }
      }]
    }

    const res = await authFetch(COMMIT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ writes: [write] }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }

    // Update local cache & remove the row
    if (existingROs.has(roNum)) existingROs.get(roNum).status = 'delivered'
    btn.closest('div[style]').remove()

    // If the list is now empty, remove the whole section
    const listEl = $('possibly-delivered-list')
    if (listEl && !listEl.children.length) {
      const section = $('possibly-delivered')
      if (section) section.remove()
    }
  } catch (err) {
    btn.disabled    = false
    btn.textContent = 'Mark Delivered'
    alert('Failed to mark as delivered: ' + err.message)
  }
}

// ── Load existing ROs from Firestore ─────────────────────────────────────────
async function loadExistingROs() {
  existingROs = new Map()
  try {
    const fields = ['roNumber','totalAmount','cccColumn','status','vehicle','customerName']
    const mask   = fields.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&')
    const url    = `${FIRESTORE_URL}/ros?pageSize=500&${mask}`
    const res    = await authFetch(url)
    if (!res.ok) return
    const data = await res.json()
    for (const doc of (data.documents || [])) {
      const roNum = doc.fields?.roNumber?.stringValue
      if (!roNum) continue
      existingROs.set(roNum, {
        docName:      doc.name,
        totalAmount:  doc.fields?.totalAmount?.stringValue  || '',
        cccColumn:    doc.fields?.cccColumn?.stringValue    || '',
        status:       doc.fields?.status?.stringValue       || '',
        vehicle:      doc.fields?.vehicle?.stringValue      || '',
        customerName: doc.fields?.customerName?.stringValue || '',
      })
    }
  } catch (e) {
    console.warn('[AutoBody] Could not load existing ROs:', e)
  }
}

function normalizeName(value = '') {
  return value.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function findUserByName(rawName = '', roles = []) {
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  const candidates = users.filter(u => !roles.length || roles.includes(u.role))
  return candidates.find(u => {
    const name = normalizeName(u.name)
    if (!name) return false
    if (name === target) return true
    const nameParts = name.split(' ').filter(Boolean)
    return targetParts.every(part =>
      nameParts.some(namePart => namePart === part || namePart.startsWith(part) || part.startsWith(namePart))
    )
  }) || null
}

async function loadUsers() {
  users = []
  try {
    const fields = ['name','email','role']
    const mask   = fields.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&')
    const res    = await authFetch(`${FIRESTORE_URL}/users?pageSize=200&${mask}`)
    if (!res.ok) return
    const data = await res.json()
    users = (data.documents || []).map(doc => ({
      uid:  doc.name.split('/').pop(),
      name: doc.fields?.name?.stringValue || doc.fields?.email?.stringValue || '',
      role: doc.fields?.role?.stringValue || '',
    }))
  } catch (e) {
    console.warn('[AutoBody] Could not load users:', e)
  }
}

// ── Render RO list ────────────────────────────────────────────────────────────
function renderROList() {
  const list = $('ro-list')
  list.innerHTML = ''

  scannedROs.forEach((ro, idx) => {
    const exists = existingROs.has(ro.roNumber)
    const div    = document.createElement('div')
    // All ROs are selectable — exists = data update, new = first import
    div.className = `ro-item selected`
    div.dataset.idx = idx

    // Detect what will change on PATCH so we can show it in the card
    const prev    = existingROs.get(ro.roNumber)
    const changes = exists ? detectFieldChanges(prev, ro) : []

    div.innerHTML = `
      <input type="checkbox" class="ro-checkbox" data-idx="${idx}" checked>
      <div class="ro-body">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="ro-num">#${ro.roNumber}</span>
          <span class="ro-badge badge-col">${ro.cccColumn || 'Unknown'}</span>
          ${exists
            ? '<span class="ro-badge" style="background:#dbeafe;color:#1d4ed8">🔄 Update</span>'
            : '<span class="ro-badge" style="background:#dcfce7;color:#166534">✨ New</span>'}
        </div>
        <div class="ro-info">
          ${ro.vehicle || '—'}${ro.vehicleColor ? ' · ' + ro.vehicleColor : ''}<br>
          ${ro.customerName || '—'} · ${ro.insuranceCompany || '—'}<br>
          ${ro.claimNumber ? 'Claim: ' + ro.claimNumber : ''}
          ${ro.totalAmount ? ' · Est: $' + Number(ro.totalAmount).toLocaleString() : ''}
        </div>
        ${exists && changes.length ? `<div style="font-size:10px;color:#b45309;margin-top:2px">📝 ${changes.join(' · ')}</div>` : ''}
        ${exists && !changes.length ? '<div style="font-size:10px;color:#94a3b8;margin-top:2px">⚡ No changes detected — sync will refresh timestamps</div>' : ''}
      </div>`

    div.querySelector('.ro-checkbox').addEventListener('change', e => {
      div.classList.toggle('selected', e.target.checked)
      updateSyncBtn()
    })
    div.addEventListener('click', e => {
      if (e.target.type !== 'checkbox') {
        const cb = div.querySelector('.ro-checkbox')
        cb.checked = !cb.checked
        div.classList.toggle('selected', cb.checked)
        updateSyncBtn()
      }
    })

    list.appendChild(div)
  })

  updateSyncBtn()
}

function setAllChecked(checked) {
  document.querySelectorAll('.ro-checkbox:not(:disabled)').forEach(cb => {
    cb.checked = checked
    cb.closest('.ro-item').classList.toggle('selected', checked)
  })
  updateSyncBtn()
}

function updateSyncBtn() {
  const count = document.querySelectorAll('.ro-checkbox:checked').length
  $('sync-btn').disabled = count === 0
  $('sync-btn').textContent = count > 0
    ? `⬆ Sync ${count} RO${count > 1 ? 's' : ''} to Board`
    : '⬆ Sync Selected to Board'
}

// ── Sync to Firebase ──────────────────────────────────────────────────────────
async function handleSync() {
  const selected = []
  document.querySelectorAll('.ro-checkbox:checked').forEach(cb => {
    selected.push(scannedROs[parseInt(cb.dataset.idx)])
  })
  if (!selected.length) return

  setBtn('sync-btn', '<span class="spinner"></span> Syncing…', true)

  const results   = []
  const timestamp = new Date().toISOString()
  await loadUsers()

  for (const ro of selected) {
    try {
      const existing       = existingROs.get(ro.roNumber) || null
      const existingDocName = existing?.docName || null
      await writeRO(ro, timestamp, existingDocName, existing)
      results.push({ roNumber: ro.roNumber, ok: true, updated: !!existingDocName })
      if (!existingDocName) existingROs.set(ro.roNumber, { docName: '__synced__', totalAmount: ro.totalAmount || '', cccColumn: ro.cccColumn || '', status: 'checked_in', vehicle: ro.vehicle || '', customerName: ro.customerName || '' })
    } catch (err) {
      results.push({ roNumber: ro.roNumber, ok: false, msg: err.message })
    }
  }

  const deliveredResults = await autoMarkMissingDelivered(timestamp)
  renderPossiblyDelivered()

  // Re-render list to show updated "In system" badges
  renderROList()

  // Show results
  const ok   = results.filter(r => r.ok).length
  const fail = results.filter(r => !r.ok).length
  const div  = $('sync-results')
  div.style.display = 'block'
  div.innerHTML = `
    <div class="alert ${fail === 0 ? 'alert-success' : fail === results.length ? 'alert-error' : 'alert-warn'}" style="margin-bottom:8px">
      ${fail === 0 ? `✅ ${ok} RO${ok>1?'s':''} synced!`
                   : `⚠ ${ok} synced, ${fail} failed`}
    </div>
    ${results.map(r => `
      <div class="result-item">
        <span class="icon">${r.ok ? '✓' : '✗'}</span>
        <span><strong>#${r.roNumber}</strong>${r.ok ? (r.updated ? ' — data updated' : ' — imported') : ' — ' + r.msg}</span>
      </div>`).join('')}
  `

  setBtn('sync-btn', `⬆ Sync Selected to Board`, false)
  updateSyncBtn()
}

// ── Detect changed fields between stored Firestore snapshot and new CCC data ───
function detectFieldChanges(prev, ro) {
  const changes = []
  const newAmt  = String(ro.totalAmount   || '')
  const newCol  = String(ro.cccColumn     || '')
  if (prev.totalAmount && newAmt && prev.totalAmount !== newAmt)
    changes.push(`Amount $${Number(prev.totalAmount).toLocaleString()} → $${Number(newAmt).toLocaleString()}`)
  if (prev.cccColumn && newCol && prev.cccColumn !== newCol)
    changes.push(`Column ${prev.cccColumn} → ${newCol}`)
  return changes
}

// ── Build a Firestore mapValue for a changeLog entry ─────────────────────────
function changeLogEntry(type, value, timestamp) {
  return {
    mapValue: {
      fields: {
        type:   { stringValue: type },
        value:  { stringValue: value },
        by:     { stringValue: 'CCC Sync' },
        at:     { stringValue: timestamp },
        source: { stringValue: 'ccc_sync' },
      }
    }
  }
}

// ── Write single RO to Firestore REST API ─────────────────────────────────────
// existingDocName: full Firestore path if RO exists → commit (update + changeLog)
//                  null if new RO → POST (create with neutral status)
// oldData: previous snapshot from existingROs map (for change detection)
async function writeRO(ro, timestamp, existingDocName, oldData) {
  const estimatorUser = findUserByName(ro.estimatorName, ['estimator', 'shop_manager', 'production_manager'])

  if (existingDocName) {
    // ── COMMIT: update CCC data fields + append changeLog entries atomically ──
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

    // Build changeLog entries for detected field changes
    const logEntries = []
    if (oldData) {
      const newAmt = String(ro.totalAmount || '')
      const newCol = String(ro.cccColumn   || '')
      if (oldData.totalAmount && newAmt && oldData.totalAmount !== newAmt)
        logEntries.push(changeLogEntry('amount', `$${Number(oldData.totalAmount).toLocaleString()} → $${Number(newAmt).toLocaleString()}`, timestamp))
      if (oldData.cccColumn && newCol && oldData.cccColumn !== newCol)
        logEntries.push(changeLogEntry('cccColumn', `${oldData.cccColumn} → ${newCol}`, timestamp))
    }

    // Use commit API: update + optional changeLog transform in one atomic write
    const write = {
      update: {
        name:   existingDocName,
        fields: updateFields,
      },
      updateMask: { fieldPaths: Object.keys(updateFields) },
    }

    if (logEntries.length > 0) {
      write.updateTransforms = [{
        fieldPath: 'changeLog',
        appendMissingElements: { values: logEntries },
      }]
    }

    const res = await authFetch(COMMIT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ writes: [write] }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }
    return res.json()

  } else {
    // ── POST: first import — no CCC status, neutral state ──
    const body = {
      fields: {
        roNumber:         strVal(ro.roNumber),
        customerName:     strVal(ro.customerName),
        vehicle:          strVal(ro.vehicle),
        vehicleColor:     strVal(ro.vehicleColor),
        vin:              strVal(ro.vin),
        insuranceCompany: strVal(ro.insuranceCompany),
        claimNumber:      strVal(ro.claimNumber),
        estimatorName:    strVal(ro.estimatorName),
        // Store CCC dates separately (locked in UI — never modified by GIB or manual edit)
        cccDateIn:        strVal(ro.dateIn),
        cccDateOut:       strVal(ro.promisedDate),
        cccImported:      { booleanValue: true },
        cccColumn:        strVal(ro.cccColumn || ''),
        cccLastSync:      strVal(timestamp),
        // Shop ETA — initialized from CCC date-out, but freely editable by GIB/manually
        eta:              strVal(ro.promisedDate),
        // Editable fields — start blank, set manually
        dropOffDate:      strVal(''),
        carStatus:        strVal('pending_dropoff'),
        // Status managed by web app — NOT from CCC
        status:           strVal('checked_in'),
        partsStatus:      strVal('not_ordered'),
        totalAmount:      strVal(ro.totalAmount),
        laborHrs:         strVal(ro.laborHrs),
        paintHrs:         strVal(ro.paintHrs),
        paintCode:        strVal(ro.paintCode),
        notes:            strVal(''),
        assignedEstimator:    strVal(estimatorUser?.uid || ''),
        assignedBodyMan:      strVal(''),
        assignedPainter:      strVal(''),
        assignedPartsManager: strVal(''),
        createdAt:        strVal(timestamp),
        updatedAt:        strVal(timestamp),
        source:           strVal('ccc_import'),
      }
    }

    const res = await authFetch(`${FIRESTORE_URL}/ros`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }
    return res.json()
  }
}

function strVal(v) {
  return { stringValue: String(v ?? '') }
}

// ── DingTalk Import ───────────────────────────────────────────────────────────
async function handleDingTalkImport() {
  $('dt-btn').innerHTML = '<span class="spinner"></span> Extracting…'
  $('dt-btn').disabled  = true
  $('dt-result').style.display = 'none'

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

    // Inject content script if needed
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['dingtalk_content.js'],
    }).catch(() => {})

    $('dt-btn').innerHTML = '<span class="spinner"></span> Reading content…'

    // Run extraction (text + image URLs)
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => window.__dingtalkScanner?.extract(),
    })

    const data = results?.[0]?.result
    if (!data)       throw new Error('Could not read DingTalk page. Try refreshing it first.')
    if (data.error)  throw new Error(data.error)
    if (!data.text)  throw new Error('No meeting content found.')

    // Fetch images as base64 from popup context (extension can bypass CORS)
    let images = []
    if (data.imageUrls?.length > 0) {
      $('dt-btn').innerHTML = `<span class="spinner"></span> Loading ${data.imageUrls.length} image(s)…`
      images = await fetchImagesAsBase64(data.imageUrls)
    }

    const appUrl     = (await chromeGet('appUrl')) || 'http://localhost:5173'
    const meetingUrl = appUrl.replace(/\/$/, '') + '/meeting'

    // Save data to chrome.storage FIRST — meeting_bridge.js will pick it up
    await chromeSet('pendingMeetingImport', { text: data.text, images })

    // Open the Meeting Import page (meeting_bridge.js will fire the data in)
    await chrome.tabs.create({ url: meetingUrl })

    const imgMsg = images.length > 0
      ? `<br><span style="color:#4338ca">📷 ${images.length} image(s) loaded — Claude will read them too</span>`
      : data.imageUrls?.length > 0
      ? `<br><span style="color:#f59e0b">⚠ ${data.imageUrls.length} image(s) found but couldn't load — text only</span>`
      : ''

    $('dt-result').style.display = 'block'
    $('dt-result').innerHTML = `
      <div class="dt-success">
        ✅ Meeting notes extracted!<br>
        <span style="font-size:11px;color:#166534">
          ${data.length} chars of text${imgMsg}<br>
          Meeting Import page opened — text auto-filled.
        </span>
      </div>`

  } catch (err) {
    $('dt-result').style.display = 'block'
    $('dt-result').innerHTML = `<div class="alert alert-error">❌ ${err.message}</div>`
  } finally {
    $('dt-btn').innerHTML = '📋 Import Meeting Notes from DingTalk'
    $('dt-btn').disabled  = false
  }
}

// ── Fetch images as base64 from extension popup context ───────────────────────
async function fetchImagesAsBase64(urls) {
  const result = []
  for (const url of urls.slice(0, 8)) {  // max 8 images to avoid overload
    try {
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok) continue
      const blob     = await res.blob()
      const mimeType = blob.type || 'image/jpeg'
      // Only process actual images
      if (!mimeType.startsWith('image/')) continue
      const base64 = await blobToBase64(blob)
      result.push({ base64, mimeType, url })
    } catch (e) {
      console.warn('[AutoBody] Could not fetch image:', url, e.message)
    }
  }
  return result
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      // Remove the data:image/xxx;base64, prefix — just keep raw base64
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function handleSaveUrl() {
  const url = $('app-url').value.trim()
  if (!url) return
  await chromeSet('appUrl', url)
  $('url-saved').style.display = 'block'
  setTimeout(() => { $('url-saved').style.display = 'none' }, 2000)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── UI helpers ────────────────────────────────────────────────────────────────
function showLogin() {
  $('view-login').classList.add('active')
  $('view-main').classList.remove('active')
  $('header-user').style.display = 'none'
  $('login-email').focus()
}

function showMain(displayName) {
  $('view-login').classList.remove('active')
  $('view-main').classList.add('active')
  $('header-user').style.display = 'flex'
  $('header-name').textContent   = displayName || 'Signed In'
  checkCurrentPage()
}

async function checkCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url   = tab?.url || ''
  const onCCC      = url.includes('cccone.com')
  const onDingTalk = url.includes('shanji.dingtalk.com')

  $('page-status').innerHTML = onCCC
    ? `<span class="on-ccc">✓ On CCC Board</span> – Ready to scan`
    : onDingTalk
    ? `<span class="on-ccc">✓ On DingTalk Meeting</span> – Ready to import`
    : `<span class="off-ccc">✗ Not on CCC or DingTalk</span><br>
       <span class="url">${url.slice(0, 55)}${url.length > 55 ? '…' : ''}</span>`

  $('scan-btn').disabled = !onCCC

  // DingTalk button
  if (onDingTalk) {
    $('dt-btn').disabled = false
    $('dt-status').innerHTML = `<span style="color:#4338ca">✓ DingTalk meeting detected — click below to import</span>`
  } else {
    $('dt-btn').disabled = true
    $('dt-status').innerHTML = `Navigate to a DingTalk AI summary page to import notes.`
  }
}

function showMsg(id, cls, html) {
  const el = $(id)
  el.className    = `alert ${cls}`
  el.innerHTML    = html
  el.style.display = 'block'
}

function showError(id, msg) {
  const el = $(id)
  el.textContent   = msg
  el.style.display = 'block'
}

function setBtn(id, html, disabled) {
  const btn = $(id)
  btn.innerHTML = html
  btn.disabled  = disabled
}

function friendlyAuthError(msg) {
  if (!msg) return 'Login failed'
  if (msg.includes('INVALID_LOGIN_CREDENTIALS') || msg.includes('INVALID_PASSWORD') || msg.includes('EMAIL_NOT_FOUND'))
    return 'Wrong email or password.'
  if (msg.includes('TOO_MANY_ATTEMPTS'))
    return 'Too many attempts. Please wait a few minutes.'
  if (msg.includes('api-key-not-valid'))
    return 'Configuration error. Contact your manager.'
  return msg
}

// ── Chrome storage helpers ────────────────────────────────────────────────────
function chromeGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])))
}
function chromeSet(key, val) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: val }, resolve))
}
function chromeRemove(key) {
  return new Promise(resolve => chrome.storage.local.remove(key, resolve))
}
