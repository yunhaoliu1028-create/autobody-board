import { useEffect, useRef } from 'react'
import DailyNotesLog from './DailyNotesLog'
import AttachmentGallery from './AttachmentGallery'
import { STATUS_MAP } from '../constants/roles'
import { statusLabel, t } from '../utils/mobileI18n'

function vehicleLine(ro) {
  return ro?.vehicle || ro?.vehicleInfo || ''
}

function useSwipeClose(onClose) {
  const startY = useRef(null)
  return {
    onTouchStart: (event) => {
      startY.current = event.touches[0]?.clientY ?? null
    },
    onTouchEnd: (event) => {
      if (startY.current == null) return
      const endY = event.changedTouches[0]?.clientY ?? startY.current
      if (endY - startY.current > 80) onClose()
      startY.current = null
    },
  }
}

export default function MobileROSheet({ ro, language = 'english', onClose }) {
  const swipeHandlers = useSwipeClose(onClose)
  const attachments = Array.isArray(ro?.attachments) ? ro.attachments : []
  const status = ro?.status ? statusLabel(language, ro.status, STATUS_MAP[ro.status]?.label ?? ro.status) : ''

  useEffect(() => {
    if (!ro) return
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ro, onClose])

  if (!ro) return null

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/45 px-3 pb-3 backdrop-blur-sm" onClick={onClose}>
      <section
        className="max-h-[82vh] w-full max-w-md overflow-hidden rounded-[1.6rem] border border-zinc-200/80 bg-white shadow-2xl shadow-black/30 dark:border-white/10 dark:bg-zinc-950"
        onClick={event => event.stopPropagation()}
        {...swipeHandlers}
      >
        <div className="flex justify-center px-4 pt-3">
          <button type="button" onClick={onClose} aria-label={t(language, 'close', 'Close')} className="h-1.5 w-12 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t(language, 'quickView', 'Quick view')}</p>
            <h2 className="mt-1 font-mono text-lg font-semibold text-blue-500">#{ro.roNumber}</h2>
            <p className="mt-0.5 truncate text-base font-semibold text-zinc-950 dark:text-zinc-50">{vehicleLine(ro)}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">
            x
          </button>
        </div>

        <div className="max-h-[64vh] overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            {status && (
              <div className="rounded-2xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <p className="text-[11px] font-medium text-zinc-500">{t(language, 'status', 'Status')}</p>
                <p className="mt-0.5 font-semibold text-zinc-900 dark:text-zinc-100">{status}</p>
              </div>
            )}
            {ro.insuranceCompany && (
              <div className="rounded-2xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <p className="text-[11px] font-medium text-zinc-500">{t(language, 'insurance', 'Insurance')}</p>
                <p className="mt-0.5 truncate font-semibold text-zinc-900 dark:text-zinc-100">{ro.insuranceCompany}</p>
              </div>
            )}
            {ro.customerName && (
              <div className="rounded-2xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <p className="text-[11px] font-medium text-zinc-500">{t(language, 'customer', 'Customer')}</p>
                <p className="mt-0.5 truncate font-semibold text-zinc-900 dark:text-zinc-100">{ro.customerName}</p>
              </div>
            )}
            {ro.vin && (
              <div className="rounded-2xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <p className="text-[11px] font-medium text-zinc-500">VIN</p>
                <p className="mt-0.5 truncate font-mono text-xs text-zinc-900 dark:text-zinc-100">{ro.vin}</p>
              </div>
            )}
          </div>

          <section className="mt-5">
            <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">{t(language, 'notes', 'Notes')}</h3>
            <div className="mt-2">
              <DailyNotesLog
                noteString={ro.notes ?? ''}
                noteSummaries={ro.noteSummaries}
              />
            </div>
          </section>

          <section className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-100">{t(language, 'photos', 'Photos')}</h3>
            <AttachmentGallery
              attachments={attachments}
              roNumber={ro.roNumber}
              columns="grid-cols-3"
              showToolbar={false}
              emptyText={t(language, 'noPhotos', 'No attached photos.')}
            />
          </section>
        </div>
      </section>
    </div>
  )
}
