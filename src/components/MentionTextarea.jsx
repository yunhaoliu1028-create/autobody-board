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
  const match = before.match(/@([a-zA-Z0-9 ._-]{0,32})$/)
  if (!match) return null
  const at = before.lastIndexOf('@')
  return { start: at, query: match[1] ?? '' }
}

function getCaretPoint(textarea, index) {
  if (!textarea) return { left: 12, top: 44 }
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const props = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth',
    'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop',
    'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant',
    'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight',
    'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'textDecoration',
    'letterSpacing', 'wordSpacing', 'tabSize',
  ]
  props.forEach(prop => { mirror.style[prop] = style[prop] })
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.left = '-9999px'
  mirror.style.top = '0'
  mirror.textContent = textarea.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = textarea.value.slice(index) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const point = {
    left: marker.offsetLeft - textarea.scrollLeft,
    top: marker.offsetTop - textarea.scrollTop + parseFloat(style.lineHeight || style.fontSize || 16) + 6,
  }
  document.body.removeChild(mirror)
  return point
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
  const [menuPos,     setMenuPos]     = useState({ left: 12, top: 44 })

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
    if (nextMention) setMenuPos(getCaretPoint(ref.current, caret))
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
          style={dropdownPlacement === 'inside' ? {
            left: `${Math.max(8, Math.min(menuPos.left, 280))}px`,
            top: `${Math.max(38, menuPos.top)}px`,
          } : undefined}
          className={`absolute w-48 max-w-[min(12rem,calc(100vw-2rem))] max-h-48 overflow-y-auto rounded-xl border border-gray-200/80 dark:border-zinc-700/80 bg-white/95 dark:bg-zinc-900/95 shadow-2xl shadow-black/10 dark:shadow-black/40 z-50 p-1 backdrop-blur ${
            dropdownPlacement === 'inside'
              ? ''
              : dropdownPlacement === 'top' ? 'left-0 bottom-full mb-1.5' : 'left-0 top-full mt-1.5'
          }`}
        >
          {matches.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); selectMention(item) }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                idx === activeIndex
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'hover:bg-gray-50 dark:hover:bg-zinc-800/70'
              }`}
            >
              <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold ${
                idx === activeIndex
                  ? 'bg-white/20 text-white'
                  : item.type === 'employee' ? 'bg-blue-600 text-white' : 'bg-zinc-700 dark:bg-zinc-500 text-white'
              }`}>
                {item.name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className={`block text-xs font-semibold truncate ${idx === activeIndex ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>@{item.name}</span>
                <span className={`block text-[10px] leading-tight truncate ${idx === activeIndex ? 'text-blue-100' : 'text-gray-400 dark:text-zinc-500'}`}>{item.meta}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
