import { useMemo, useState } from 'react'

function safeFilename(value) {
  return String(value || 'photo')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'photo'
}

async function downloadUrl(url, filename) {
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(objUrl), 1500)
    return true
  } catch {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return false
  }
}

export default function AttachmentGallery({
  attachments = [],
  roNumber,
  columns = 'grid-cols-2 sm:grid-cols-3 md:grid-cols-6',
  showToolbar = true,
  emptyText = 'No attached photos yet.',
}) {
  const photos = useMemo(() => attachments.filter(att => att?.url), [attachments])
  const [selected, setSelected] = useState(new Set())
  const [previewIndex, setPreviewIndex] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState('')
  const [downloadNotice, setDownloadNotice] = useState('')

  const allSelected = photos.length > 0 && selected.size === photos.length

  const toggleSelectAll = () => {
    setDownloadNotice('')
    setSelected(allSelected ? new Set() : new Set(photos.map((_, i) => i)))
  }

  const toggleOne = (index) => {
    setDownloadNotice('')
    setSelected(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const handleDownload = async () => {
    const targets = photos.filter((_, i) => selected.has(i))
    if (!targets.length || downloading) return

    setDownloading(true)
    setDownloadNotice('')
    let fallbackCount = 0
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const att = targets[i]
        setDownloadProgress(`Downloading ${i + 1}/${targets.length}...`)
        const label = att.label || att.name || `photo_${i + 1}`
        const filename = `RO${roNumber || ''}_${safeFilename(label)}_${i + 1}.jpg`
        const saved = await downloadUrl(att.url, filename)
        if (!saved) fallbackCount += 1
        if (i < targets.length - 1) await new Promise(resolve => setTimeout(resolve, 250))
      }
      setDownloadNotice(fallbackCount ? `${fallbackCount} photo link opened because direct download was blocked.` : '')
    } finally {
      setDownloading(false)
      setDownloadProgress('')
    }
  }

  if (!photos.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-gray-500 dark:text-zinc-400">{emptyText}</p>
      </div>
    )
  }

  const preview = previewIndex == null ? null : photos[previewIndex]
  const previewLabel = preview ? (preview.label || preview.name || `Photo ${previewIndex + 1}`) : ''

  return (
    <div className="space-y-2.5">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-gray-400 dark:text-zinc-600">
            {photos.length} photo{photos.length !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={toggleSelectAll}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 transition-colors hover:text-emerald-800 disabled:opacity-50 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12M8 12l4 4 4-4" />
              </svg>
              {downloading ? downloadProgress : `Download ${selected.size} selected`}
            </button>
          )}
        </div>
      )}

      {downloadNotice && (
        <p className="text-xs text-amber-600 dark:text-amber-300">{downloadNotice}</p>
      )}

      <div className={`grid ${columns} gap-2`}>
        {photos.map((att, index) => {
          const label = att.label || att.name || `Photo ${index + 1}`
          return (
            <div
              key={`${att.url}-${index}`}
              className={`group relative overflow-hidden rounded-xl border bg-gray-50 transition-colors dark:bg-zinc-950 ${
                selected.has(index)
                  ? 'border-blue-500 ring-2 ring-blue-400/40'
                  : 'border-gray-200 hover:border-blue-300 dark:border-zinc-800 dark:hover:border-blue-800'
              }`}
            >
              <button
                type="button"
                onClick={() => setPreviewIndex(index)}
                className="block w-full text-left"
                title={`Preview ${label}`}
              >
                <div className="aspect-square overflow-hidden bg-gray-100 dark:bg-zinc-900">
                  <img
                    src={att.url}
                    alt={label}
                    className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
                <div className="px-2 py-1.5">
                  <p className="truncate text-xs font-medium text-gray-700 dark:text-zinc-300">{label}</p>
                </div>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleOne(index)
                }}
                className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-all ${
                  selected.has(index)
                    ? 'border-blue-500 bg-blue-500'
                    : 'border-white/80 bg-black/30 opacity-0 group-hover:opacity-100'
                }`}
                aria-label={selected.has(index) ? 'Deselect photo' : 'Select photo'}
              >
                {selected.has(index) && (
                  <svg className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            </div>
          )
        })}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewIndex(null)}
        >
          <div className="max-h-full max-w-5xl" onClick={e => e.stopPropagation()}>
            <img
              src={preview.url}
              alt={previewLabel}
              className="max-h-[82vh] max-w-full rounded-xl object-contain shadow-2xl"
            />
            <div className="mt-2 flex items-center justify-between gap-3 text-white">
              <p className="truncate text-sm font-medium">{previewLabel}</p>
              <button
                type="button"
                onClick={() => setPreviewIndex(null)}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/20"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
