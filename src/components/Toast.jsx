// ─── Toast notification system ────────────────────────────────────────────────
// Usage:  const toast = useToast()
//         toast.success('3 photos uploaded to RO #9448')
//         toast.info('RO #9448 · Status → In Paint')
//         toast.warn('Parts not yet ordered')
//         toast.error('Upload failed')

import { createContext, useContext, useState, useCallback, useRef } from 'react'

const ToastCtx = createContext(null)
export const useToast = () => useContext(ToastCtx)

let _seq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const remove = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((message, type = 'info', duration = 5000) => {
    const id = ++_seq
    setToasts(prev => [...prev.slice(-4), { id, message, type }]) // cap at 5 visible
    setTimeout(() => remove(id), duration)
    return id
  }, [remove])

  const api = {
    info:    (msg, dur) => push(msg, 'info',    dur),
    success: (msg, dur) => push(msg, 'success', dur),
    warn:    (msg, dur) => push(msg, 'warning', dur),
    error:   (msg, dur) => push(msg, 'error',   dur),
  }

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastContainer toasts={toasts} onRemove={remove} />
    </ToastCtx.Provider>
  )
}

// ── Styles per type ───────────────────────────────────────────────────────────
const STYLES = {
  info:    { bar: 'bg-blue-600',  icon: '💬' },
  success: { bar: 'bg-green-600', icon: '✅' },
  warning: { bar: 'bg-amber-500', icon: '⚠️' },
  error:   { bar: 'bg-red-600',   icon: '❌' },
}

function ToastContainer({ toasts, onRemove }) {
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-5 right-4 z-[200] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map(t => {
        const s = STYLES[t.type] ?? STYLES.info
        return (
          <div
            key={t.id}
            className="flex items-start gap-3 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-xl shadow-xl px-3.5 py-3 animate-slide-in overflow-hidden"
          >
            {/* left accent bar */}
            <div className={`w-1 self-stretch rounded-full shrink-0 ${s.bar}`} />
            <span className="text-base leading-none shrink-0 mt-0.5">{s.icon}</span>
            <p className="flex-1 text-sm text-gray-800 dark:text-gray-100 leading-snug">{t.message}</p>
            <button
              onClick={() => onRemove(t.id)}
              className="shrink-0 text-gray-300 dark:text-zinc-600 hover:text-gray-600 dark:hover:text-zinc-300 text-lg leading-none mt-0.5"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
