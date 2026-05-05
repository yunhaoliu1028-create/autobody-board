import { useEffect, useMemo, useRef, useState } from 'react'

export const DEFAULT_SUBLET_VENDORS = [
  'AC Auto Glass',
  'Valley Frame & Alignment',
  'Premium Auto Upholstery',
  'Safelite',
  'LKQ',
  'Parts Trader',
  'Calibration Vendor',
  'Wheel Repair Vendor',
]

function normalize(value = '') {
  return value.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function getMentionQuery(text, caret) {
  const before = text.slice(0, caret)
  const match = before.match(/(^|\s)@([a-zA-Z0-9 ._-]{0,32})$/)
  if (!match) return null
  const at = before.lastIndexOf('@')
  return { start: at, query: match[2] ?? '' }
}

export function buildMentionCandidates(employees = [], vendors = DEFAULT_SUBLET_VENDORS) {
  const employeeItems = employees
    .filter(e => e?.name)
    .map(e => ({ id: e.uid || e.name, name: e.name, meta: e.role || 'employee', type: 'employee' }))
  const vendorItems = vendors
    .filter(Boolean)
    .map(name => ({ id: `vendor:${name}`, name, meta: 'sublet vendor', type: 'vendor' }))

  const seen = new Set()
  return [...employeeItems, ...vendorItems].filter(item => {
    const key = normalize(item.name)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export default function MentionTextarea({
  value,
  onChange,
  candidates = [],
  className = '',
  dropdownPlacement = 'bottom',
  onKeyDown,
  onInput,
  disabled,
  rows = 1,
  placeholder,
  inputRef,
  ...props
}) {
  const ownRef    = useRef(null)
  const ref       = inputRef || ownRef
  const listRef   = useRef(null)
  const [mention,     setMention]     = useState(null)
  const [activeIndex, setActiveIndex] = useState(0)

  // Scroll active item into view whenever selection changes
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[activeIndex]
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex])

  const matches = useMemo(() => {
    if (!mention) return []
    const q = normalize(mention.query)
    return candidates
      .filter(item => {
        const name = normalize(item.name)
        return !q || name.startsWith(q) || name.split(' ').some(part => part.startsWith(q))
      })
  }, [candidates, mention])

  const updateMention = (nextValue, caret) => {
    const nextMention = getMentionQuery(nextValue, caret)
    setMention(nextMention)
    setActiveIndex(0)
  }

  const handleChange = (e) => {
    onChange?.(e)
    updateMention(e.target.value, e.target.selectionStart)
  }

  const selectMention = (item) => {
    if (!mention) return
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const nextValue = `${value.slice(0, mention.start)}@${item.name} ${value.slice(caret)}`
    onChange?.({ target: { value: nextValue } })
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.start + item.name.length + 2
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const handleKeyDown = (e) => {
    if (mention && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(i => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(i => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(matches[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setMention(null)
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <div className="relative flex-1">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onInput={onInput}
        onClick={e => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
        onKeyUp={e => {
          if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
          updateMention(e.currentTarget.value, e.currentTarget.selectionStart)
        }}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
        {...props}
      />
      {mention && matches.length > 0 && (
        <div
          ref={listRef}
          className={`absolute w-44 max-w-[min(11rem,calc(100vw-2rem))] max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl z-50 p-0.5 ${
            dropdownPlacement === 'inside'
              ? 'left-3 top-10'
              : dropdownPlacement === 'top' ? 'left-0 bottom-full mb-1.5' : 'left-0 top-full mt-1.5'
          }`}
        >
          {matches.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); selectMention(item) }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                idx === activeIndex
                  ? 'bg-blue-50 dark:bg-blue-950/50 ring-1 ring-blue-200 dark:ring-blue-800'
                  : 'hover:bg-gray-50 dark:hover:bg-zinc-800/70'
              }`}
            >
              <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold ${
                item.type === 'employee' ? 'bg-blue-600 text-white' : 'bg-zinc-700 dark:bg-zinc-500 text-white'
              }`}>
                {item.name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">@{item.name}</span>
                <span className="block text-[10px] leading-tight text-gray-400 dark:text-zinc-500 truncate">{item.meta}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
