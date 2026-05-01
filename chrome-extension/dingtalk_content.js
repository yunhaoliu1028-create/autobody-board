// ─── AutoBody Board – DingTalk Meeting Notes Extractor ────────────────────────
// Runs on shanji.dingtalk.com pages.
// Extracts the AI summary (AI纪要) content from the meeting notes page.

;(function () {
  window.__dingtalkScanner = { extract }

  async function extract() {
    // Give React time to finish rendering (SPA)
    await sleep(1000)

    const summaryContainer = findSummaryContainer()
    const summary    = summaryContainer ? summaryContainer.innerText?.trim() : extractAISummary()
    const transcript = extractTranscript()

    if (!summary && !transcript) {
      return { error: 'Could not find meeting content. Make sure the AI summary is loaded.', text: '' }
    }

    const text = summary || transcript

    // Extract image URLs from the summary container
    const imageUrls = extractImageUrls(summaryContainer)

    return {
      text,
      imageUrls,
      imageCount: imageUrls.length,
      length: text.length,
      source: summary ? 'ai_summary' : 'transcript',
    }
  }

  // ── Find the AI summary container element ─────────────────────────────────
  function findSummaryContainer() {
    // Strategy 1: visible tabpanel
    const panels = document.querySelectorAll('[role="tabpanel"]')
    for (const panel of panels) {
      if (isVisible(panel) && panel.innerText?.length > 100) return panel
    }

    // Strategy 2: class name hints
    const selectors = [
      '[class*="summary"]', '[class*="minutes"]', '[class*="aiNote"]',
      '[class*="ai-note"]', '[class*="noteContent"]', '[class*="rightPanel"]',
    ]
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el && isVisible(el) && el.innerText?.length > 100) return el
      } catch (e) {}
    }

    // Strategy 3: right-half layout panel with meeting-like content
    const pageWidth  = window.innerWidth
    const halfWidth  = pageWidth * 0.4
    const candidates = [...document.querySelectorAll('div')].filter(div => {
      const rect = div.getBoundingClientRect()
      return rect.left > halfWidth && rect.width > 150 && rect.height > 200
        && div.innerText?.length > 200 && isVisible(div)
    })
    candidates.sort((a, b) => meetingScore(b.innerText) - meetingScore(a.innerText))
    return candidates[0] || null
  }

  // ── Extract image URLs from a container ───────────────────────────────────
  function extractImageUrls(container) {
    const root = container || document.body
    const urls = []
    const seen = new Set()

    root.querySelectorAll('img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original')
      if (!src || seen.has(src)) return
      // Skip tiny icons (avatars, bullets, etc.)
      if (img.naturalWidth < 60 || img.naturalHeight < 60) return
      // Skip SVG / data URIs
      if (src.startsWith('data:image/svg') || src.startsWith('blob:')) return
      seen.add(src)
      urls.push(src)
    })

    return urls
  }

  // ── Extract AI纪要 text as fallback ──────────────────────────────────────
  function extractAISummary() {
    const container = findSummaryContainer()
    return container ? container.innerText.trim() : null
  }

  // ── Extract raw transcript as fallback ─────────────────────────────────────
  function extractTranscript() {
    // Transcript elements typically have timestamp patterns (00:13, 01:49, etc.)
    const allText = document.body.innerText
    if (allText.length > 200) {
      // Remove timestamp-heavy lines if possible, return clean text
      const lines = allText.split('\n').filter(l => {
        const trimmed = l.trim()
        // Skip pure timestamp lines
        return trimmed.length > 3 && !/^\d{2}:\d{2}$/.test(trimmed)
      })
      return lines.join('\n').trim()
    }
    return null
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function meetingScore(text) {
    if (!text) return 0
    let score = 0
    if (/vehicle|RO#|repair|paint|parts|status/i.test(text)) score += 3
    if (/\d{4,5}/.test(text)) score += 2   // RO numbers
    if (/insurance|claim|estimate/i.test(text)) score += 2
    if (text.length > 300) score += 1
    return score
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && el.offsetParent !== null
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

})()
