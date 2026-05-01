// ─── AutoBody Board – CCC Page Scanner ───────────────────────────────────────
// Runs on estimate.cccone.com pages.
// NOTE: We do NOT import CCC repair status. Our web app manages status
// independently via daily meetings and manual updates.

;(function () {
  window.__autobodyScanner = { scan }

  // ── Main scan function ─────────────────────────────────────────────────────
  function scan() {
    const ros  = []
    const seen = new Set()

    // Find all RO number elements across the entire DOM
    const roElements = findROElements()
    if (roElements.length === 0) {
      return { error: 'No RO cards found. Make sure the CCC Production Board is loaded and all filters are cleared.', ros: [] }
    }

    for (const el of roElements) {
      try {
        const rawNum = el.textContent.trim().replace(/^#/, '')
        if (!rawNum || seen.has(rawNum)) continue
        seen.add(rawNum)

        const card       = findCardContainer(el)
        if (!card) continue

        const columnName = getColumnName(card)
        const fields     = extractFields(card)

        ros.push({
          roNumber:         rawNum,
          cccColumn:        columnName,   // kept for reference only — NOT used for status
          vehicle:          fields.vehicle      || '',
          customerName:     fields.owner        || '',
          insuranceCompany: fields.insurance    || '',
          laborHrs:         fields.laborHrs     || '',
          dateIn:           parseDate(fields.vehicleIn),
          promisedDate:     parseDate(fields.vehicleOut),
          claimNumber:      fields.claim        || '',
          estimatorName:    fields.estimator    || '',
          vehicleColor:     fields.extColor     || '',
          vin:              fields.vin          || '',
          paintHrs:         fields.paintHrs     || '',
          paintCode:        fields.paintCode    || '',
          totalAmount:      parseMoney(fields.estimate),
        })
      } catch (e) {
        console.warn('[AutoBody] Error parsing card:', e)
      }
    }

    return { ros, total: ros.length }
  }

  // ── Find all RO number elements in the DOM ─────────────────────────────────
  function findROElements() {
    const found = []
    const seen  = new Set()

    // Method 1: TreeWalker for text nodes matching #XXXX
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    )
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim()
      if (/^#\d{3,6}$/.test(text) && !seen.has(text)) {
        seen.add(text)
        found.push(walker.currentNode.parentElement)
      }
    }

    // Method 2: Try common CCC selectors as fallback
    if (found.length === 0) {
      document.querySelectorAll('[class*="card"], [class*="Card"], [class*="job"], [class*="ro-"]').forEach(el => {
        const text = el.textContent
        const m    = text.match(/#(\d{3,6})/)
        if (m && !seen.has(m[1])) {
          seen.add(m[1])
          found.push(el)
        }
      })
    }

    return found
  }

  // ── Find the card container wrapping an RO number element ─────────────────
  function findCardContainer(el) {
    let current = el
    for (let i = 0; i < 15; i++) {
      if (!current || current === document.body) break
      const rect     = current.getBoundingClientRect()
      const children = current.querySelectorAll('*').length
      // Card: reasonably tall, not too wide, has multiple children
      if (rect.height > 100 && rect.height < 800 && rect.width > 100 && rect.width < 600 && children > 4) {
        return current
      }
      current = current.parentElement
    }
    // Fallback: walk up 6 levels
    let c = el
    for (let i = 0; i < 6; i++) { if (c.parentElement) c = c.parentElement }
    return c
  }

  // ── Determine which CCC column the card is in (for reference) ─────────────
  function getColumnName(cardEl) {
    let current = cardEl
    for (let i = 0; i < 20; i++) {
      if (!current || current === document.body) break
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children)
        const idx      = siblings.indexOf(current)
        for (let j = 0; j < idx; j++) {
          const txt = (siblings[j].textContent || '').trim()
          if (txt.length > 0 && txt.length < 50 && !/^#\d/.test(txt) && !/^\$/.test(txt)) {
            const firstLine = txt.split('\n')[0].trim()
            if (firstLine.length > 0 && firstLine.length < 40) return firstLine
          }
        }
      }
      current = current.parentElement
    }
    return 'Unknown'
  }

  // ── Extract all fields from a card's text ─────────────────────────────────
  function extractFields(card) {
    const fields = {}
    const lines  = (card.innerText || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const next = lines[i + 1] || ''

      if (/^#\d{3,6}$/.test(line)) continue  // RO number — skip

      // Vehicle: CCC shows "YY Make Model..." — convert 2-digit year
      if (!fields.vehicle && /^\d{2}\s+\w/.test(line)) {
        const yr       = parseInt(line.slice(0, 2))
        const fullYear = yr >= 0 && yr <= 35 ? `20${String(yr).padStart(2,'0')}` : `19${String(yr).padStart(2,'0')}`
        fields.vehicle = fullYear + ' ' + line.slice(3).replace(/\s*w\/.*$/, '').trim()
        continue
      }

      // Field-value pairs (label on one line, value on next)
      if (line === 'Owner'       && next) { fields.owner      = next; i++; continue }
      if (line === 'Labor Hrs'   && next) { fields.laborHrs   = next; i++; continue }
      if (line === 'Vehicle In'  && next) { fields.vehicleIn  = next; i++; continue }
      if (line === 'Vehicle Out' && next) { fields.vehicleOut = next; i++; continue }
      if (line === 'Claim'       && next) { fields.claim      = next; i++; continue }
      if (line === 'Estimator'   && next) { fields.estimator  = next; i++; continue }
      if (line === 'Ext. Color'  && next) { fields.extColor   = next; i++; continue }
      if (line === 'VIN'         && next) { fields.vin        = next.replace(/^\.\.\./, ''); i++; continue }
      if (line === 'Paint Hrs'   && next) { fields.paintHrs   = next; i++; continue }
      if (line === 'Paint Code'  && next) { fields.paintCode  = next; i++; continue }
      if (line === 'Estimate'    && next) { fields.estimate   = next; i++; continue }

      // Insurance: look for common carrier names
      if (!fields.insurance &&
          /(insurance|farmers|state farm|geico|allstate|progressive|safeco|tesla|aaa|mercury|21st|infinity|nationwide|usaa|liberty|travelers)/i.test(line)) {
        fields.insurance = line
        continue
      }
    }

    return fields
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function parseDate(str) {
    if (!str || str === '--' || str === '—') return ''
    const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (m) {
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3]
      return `${yr}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`
    }
    return ''
  }

  function parseMoney(str) {
    if (!str) return ''
    return str.replace(/[$,]/g, '').trim()
  }

})()
