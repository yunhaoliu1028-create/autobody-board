// ─── AutoBody Board – Meeting Import Bridge ───────────────────────────────────
// Runs on the AutoBody Board web app pages (localhost + Firebase hosting).
// Reads pending DingTalk data from chrome.storage and fires it into the page.

;(function () {
  // Only activate on the /meeting route
  if (!location.pathname.includes('/meeting')) return

  function deliverData(data) {
    if (!data?.text) return

    // Dispatch custom event — MeetingImport.jsx listens for this
    window.dispatchEvent(new CustomEvent('dingtalkDataReady', {
      detail: { text: data.text, images: data.images || [] }
    }))

    // Also set window variable as fallback for before React mounts
    window.__dingtalkData = { text: data.text, images: data.images || [] }

    // Clear from storage so it doesn't fire again on refresh
    chrome.storage.local.remove('pendingMeetingImport')

    console.log('[AutoBody Bridge] Delivered meeting data:', data.text.length, 'chars,', (data.images || []).length, 'images')
  }

  // Check immediately (page might already be loaded)
  chrome.storage.local.get('pendingMeetingImport', result => {
    if (result.pendingMeetingImport) {
      // Give React a moment to mount, then fire
      setTimeout(() => deliverData(result.pendingMeetingImport), 800)
    }
  })

  // Also listen for storage changes (data might arrive after script runs)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pendingMeetingImport?.newValue) {
      setTimeout(() => deliverData(changes.pendingMeetingImport.newValue), 400)
    }
  })
})()
