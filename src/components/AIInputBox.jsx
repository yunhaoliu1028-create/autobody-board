import { useState, useEffect, useMemo, useRef } from 'react'
import { doc, updateDoc, addDoc, collection, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'
import { parseShopInput, getApiKey, transcribeWithWhisper } from '../hooks/useAI'
import { STATUS_MAP, RO_STATUSES, PARTS_STATUSES, CAR_STATUSES, CAR_STATUS_MAP } from '../constants/roles'
import MentionTextarea, { buildMentionCandidates } from './MentionTextarea'
import { format, differenceInCalendarDays, parseISO, isValid } from 'date-fns'

function dueDateToPriority(ro) {
  const dateStr = ro?.cccDateOut || ro?.promisedDate
  if (!dateStr) return 'medium'
  try {
    const due  = parseISO(dateStr)
    if (!isValid(due)) return 'medium'
    const days = differenceInCalendarDays(due, new Date())
    if (days <= 2)  return 'high'
    if (days <= 7)  return 'medium'
    return 'low'
  } catch { return 'medium' }
}

function normalizeName(value = '') {
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function findEmployeeByName(employees, rawName = '') {
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  return employees.find(emp => {
    const name = normalizeName(emp.name)
    if (!name) return false
    const nameParts = name.split(' ').filter(Boolean)
    if (name === target) return true
    if (targetParts.length === 1) {
      return nameParts.some(part => part === target || part.startsWith(target))
    }
    return targetParts.every(part =>
      nameParts.some(namePart => namePart === part || namePart.startsWith(part))
    )
  }) ?? null
}

// ── Photo-type keyword detection (no AI needed) ───────────────────────────────
const PHOTO_TYPES = [
  { keys: ['check in','checkin','check-in',' ci ','c/i','ci photo','check in photo'], label: 'Check-In',   slug: 'check_in'   },
  { keys: ['in progress','inprogress','in-progress',' ip ','i/p','ip photo'],         label: 'In Progress', slug: 'in_progress' },
  { keys: ['paint'],                                                                   label: 'Paint',       slug: 'paint'       },
  { keys: ['repair'],                                                                  label: 'Repair',      slug: 'repair'      },
  { keys: ['complete','finished','done','final'],                                      label: 'Complete',    slug: 'complete'    },
  { keys: ['damage','dmg'],                                                            label: 'Damage',      slug: 'damage'      },
  { keys: ['deliver','delivery','pickup','pick up','pick-up'],                         label: 'Delivery',    slug: 'delivery'    },
  { keys: ['supplement','supp'],                                                       label: 'Supplement',  slug: 'supplement'  },
  { keys: ['part','parts'],                                                            label: 'Parts',       slug: 'parts'       },
]

function detectPhotoType(text) {
  const t = text.toLowerCase()
  for (const pt of PHOTO_TYPES) {
    if (pt.keys.some(k => t.includes(k))) return pt
  }
  return { label: 'Photo', slug: 'photo' }
}

function extractRoNumber(text, ros) {
  // Matches: 9556 / RO9556 / RO#9556 / #9556 — 4–6 digits
  const matches = [...text.matchAll(/(?:ro#?|#)?(\d{4,6})/gi)]
  for (const m of matches) {
    if (ros.find(r => r.roNumber === m[1])) return m[1]
  }
  return null
}

const ACTION_LABELS = {
  add_note:            { label: 'Add Note',        color: 'bg-blue-50   border-blue-200   dark:bg-blue-950/35   dark:border-blue-800/80' },
  update_status:       { label: 'Update Status',   color: 'bg-purple-50 border-purple-200 dark:bg-purple-950/35 dark:border-purple-800/80' },
  update_parts_status: { label: 'Parts Status',    color: 'bg-amber-50  border-amber-200  dark:bg-amber-950/35  dark:border-amber-800/80' },
  assign_task:         { label: 'Assign Task',     color: 'bg-green-50  border-green-200  dark:bg-green-950/35  dark:border-green-800/80' },
  assign_body_man:     { label: 'Set Body Tech',  color: 'bg-blue-50   border-blue-200   dark:bg-blue-950/35   dark:border-blue-800/80' },
  update_car_status:   { label: 'Car Status',      color: 'bg-orange-50 border-orange-200 dark:bg-orange-950/35 dark:border-orange-800/80' },
  update_dropoff_date: { label: 'Drop-Off Date',   color: 'bg-cyan-50   border-cyan-200   dark:bg-cyan-950/35   dark:border-cyan-800/80' },
  update_due_date:     { label: 'Target Date',     color: 'bg-rose-50   border-rose-200   dark:bg-rose-950/35   dark:border-rose-800/80' },
  update_rental:       { label: 'Rental Status',   color: 'bg-gray-50   border-gray-200   dark:bg-zinc-800/95   dark:border-zinc-600' },
}

const ACTION_FIELD = 'border border-gray-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600'
const GIB_HISTORY_KEY = 'autobody.gib.history.v1'

// ── Inline-editable action card ───────────────────────────────────────────────
function EditableActionCard({ action, onChange, onDelete, employees, ros }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(action)

  // Keep draft in sync with parent action whenever not actively editing
  useEffect(() => { if (!editing) setDraft(action) }, [action])  // eslint-disable-line react-hooks/exhaustive-deps

  const meta = ACTION_LABELS[draft.type] ?? { icon: '•', label: draft.type, color: 'bg-gray-50 border-gray-200' }

  const save = () => { onChange(draft); setEditing(false) }
  const set  = (patch) => setDraft(prev => ({ ...prev, ...patch }))

  // ── Edit form ──────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="border-2 border-blue-400 rounded-xl p-3 bg-white dark:bg-zinc-900 space-y-2 text-sm">
        <div className="flex items-center gap-2 mb-1">
          <span>{meta.icon}</span>
          <span className="font-semibold text-blue-700 dark:text-blue-300">RO#{draft.roNumber}</span>
          <span className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide">{meta.label}</span>
        </div>

        {/* RO number */}
        <label className="block text-xs text-gray-500 dark:text-zinc-400">RO #
          <input
            className={`ml-2 px-2 py-0.5 text-xs w-24 font-mono ${ACTION_FIELD}`}
            value={draft.roNumber ?? ''}
            onChange={e => set({ roNumber: e.target.value })}
          />
        </label>

        {/* Per-type fields */}
        {draft.type === 'add_note' && (
          <textarea
            className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`}
            rows={3}
            value={draft.note ?? ''}
            onChange={e => set({ note: e.target.value })}
          />
        )}

        {draft.type === 'update_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.status ?? ''}
            onChange={e => set({ status: e.target.value })}
          >
            {RO_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_parts_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.partsStatus ?? ''}
            onChange={e => set({ partsStatus: e.target.value })}
          >
            {PARTS_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_car_status' && (
          <select
            className={`px-2 py-1.5 text-sm w-full ${ACTION_FIELD}`}
            value={draft.carStatus ?? ''}
            onChange={e => set({ carStatus: e.target.value })}
          >
            {CAR_STATUSES.map(s => <option key={s.key} value={s.key}>{s.icon} {s.label}</option>)}
          </select>
        )}

        {draft.type === 'update_dropoff_date' && (
          <input
            type="date"
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.dropOffDate ?? ''}
            onChange={e => set({ dropOffDate: e.target.value })}
          />
        )}

        {draft.type === 'update_due_date' && (
          <input
            type="date"
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.dueDate ?? ''}
            onChange={e => set({ dueDate: e.target.value })}
          />
        )}

        {draft.type === 'update_rental' && (
          <select
            className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
            value={draft.hasRental === true ? 'yes' : draft.hasRental === false ? 'no' : ''}
            onChange={e => set({ hasRental: e.target.value === 'yes' ? true : false })}
          >
            <option value="no">No rental</option>
            <option value="yes">Customer has rental</option>
          </select>
        )}

        {draft.type === 'assign_task' && (
          <div className="space-y-1.5">
            <input
              className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              placeholder="Assignee name"
              value={draft.assigneeName ?? ''}
              onChange={e => set({ assigneeName: e.target.value })}
            />
            <input
              className={`w-full px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              placeholder="Task title"
              value={draft.title ?? ''}
              onChange={e => set({ title: e.target.value })}
            />
            <textarea
              className={`w-full px-2 py-1.5 text-sm resize-y ${ACTION_FIELD}`}
              rows={2}
              placeholder="Description (optional)"
              value={draft.description ?? ''}
              onChange={e => set({ description: e.target.value })}
            />
            <select
              className={`px-2 py-1.5 text-sm ${ACTION_FIELD}`}
              value={draft.priority ?? 'medium'}
              onChange={e => set({ priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={save}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg"
          >Done</button>
          <button
            onClick={() => { setDraft(action); setEditing(false) }}
            className="px-3 py-1 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-xs rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
          >Cancel</button>
        </div>
      </div>
    )
  }

  // ── Preview (read mode) ────────────────────────────────────────────────────
  const detail = () => {
    switch (draft.type) {
      case 'add_note':            return <span className="text-gray-700 dark:text-zinc-200">"{draft.note}"</span>
      case 'update_status':       return <span className="text-purple-700 dark:text-purple-300 font-medium">{STATUS_MAP[draft.status]?.label ?? draft.status}</span>
      case 'update_parts_status': return <span className="text-yellow-700 dark:text-amber-300 font-medium">{PARTS_STATUSES.find(p => p.key === draft.partsStatus)?.label ?? draft.partsStatus}</span>
      case 'update_car_status':   return <span className="text-gray-800 dark:text-zinc-100"><strong>{CAR_STATUS_MAP[draft.carStatus]?.label ?? draft.carStatus}</strong></span>
      case 'update_dropoff_date': return <span className="text-gray-700 dark:text-zinc-200">Drop Off: <strong className="text-gray-900 dark:text-white">{draft.dropOffDate}</strong></span>
      case 'update_due_date':     return <span className="text-gray-700 dark:text-zinc-200">Target Completion: <strong className="text-gray-900 dark:text-white">{draft.dueDate}</strong></span>
      case 'update_rental':       return <span className="text-gray-800 dark:text-zinc-100">{draft.hasRental ? 'Customer has rental' : 'No rental'}</span>
      case 'assign_task':
        return (
          <span>
            <span className="text-gray-700 dark:text-zinc-200">→ <strong className="text-gray-900 dark:text-white">{draft.assigneeName}</strong>: "{draft.title}"</span>
            <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded font-medium ${
              draft.priority === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
              : draft.priority === 'low' ? 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300'
              : 'bg-yellow-100 text-yellow-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>{draft.priority}</span>
          </span>
        )
      default: return null
    }
  }

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm shadow-sm dark:shadow-none ${meta.color}`}>
      <span className="shrink-0 mt-0.5">{meta.icon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-gray-800 dark:text-zinc-100">RO#{draft.roNumber}</span>
        <span className="text-gray-400 dark:text-zinc-500 mx-1.5">·</span>
        <span className="text-xs font-semibold text-gray-600 dark:text-zinc-300 uppercase tracking-wide">{meta.label}</span>
        <div className="text-sm mt-0.5">{detail()}</div>
      </div>
      {draft.confidence === 'low' && (
        <span className="text-xs text-orange-500 shrink-0 mt-0.5" title="Low confidence – please verify">⚠</span>
      )}
      {/* Edit / Delete buttons */}
      <div className="flex items-center gap-1 shrink-0 ml-1">
        <button
          onClick={() => setEditing(true)}
          className="text-gray-500 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-300 text-xs px-1.5 py-0.5 rounded hover:bg-white/70 dark:hover:bg-zinc-700 transition-colors"
          title="Edit"
        >✏️</button>
        <button
          onClick={onDelete}
          className="text-gray-500 dark:text-zinc-300 hover:text-red-500 dark:hover:text-red-300 text-xs px-1.5 py-0.5 rounded hover:bg-white/70 dark:hover:bg-zinc-700 transition-colors"
          title="Remove"
        >×</button>
      </div>
    </div>
  )
}

// ── Photo source picker (2 options only) ─────────────────────────────────────
function PhotoSheet({ onCamera, onLibrary, onClose }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9000] flex flex-col justify-end"
      style={{ background: 'rgba(0,0,0,0.45)' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-zinc-900 rounded-t-2xl overflow-hidden pb-safe"
      >
        {/* Title bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-zinc-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Photo</span>
          <button onClick={onClose} className="text-blue-500 text-sm font-medium">Cancel</button>
        </div>
        {/* Camera option */}
        <button
          onClick={onCamera}
          className="w-full flex items-center gap-4 px-5 py-4 border-b border-gray-100 dark:border-zinc-800 active:bg-gray-50 dark:active:bg-zinc-800 transition-colors"
        >
          <span className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-700 dark:text-gray-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
              <circle cx="12" cy="13" r="3"/>
            </svg>
          </span>
          <div className="text-left">
            <p className="text-[15px] font-medium text-gray-900 dark:text-gray-100">Take Photo</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Open camera</p>
          </div>
        </button>
        {/* Library option */}
        <button
          onClick={onLibrary}
          className="w-full flex items-center gap-4 px-5 py-4 active:bg-gray-50 dark:active:bg-zinc-800 transition-colors"
        >
          <span className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-700 dark:text-gray-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <path strokeLinecap="round" d="m21 15-5-5L5 21"/>
            </svg>
          </span>
          <div className="text-left">
            <p className="text-[15px] font-medium text-gray-900 dark:text-gray-100">Photo Library</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Choose existing photos</p>
          </div>
        </button>
      </div>
    </div>
  )
}

// ── Continuous Camera (getUserMedia) ──────────────────────────────────────────
// Uses visualViewport height to avoid iOS Safari nav bar covering controls
function CameraModal({ onDone, onClose }) {
  const videoRef  = useRef(null)
  const streamRef = useRef(null)
  const libRef    = useRef(null)
  const [shots, setShots] = useState([])
  const [ready, setReady] = useState(false)
  const [err,   setErr]   = useState('')
  // Real visible height — avoids Safari bottom bar overlap
  const [vh, setVh] = useState(() => window.visualViewport?.height ?? window.innerHeight)

  useEffect(() => {
    const onResize = () => setVh(window.visualViewport?.height ?? window.innerHeight)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => window.visualViewport?.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => { streamRef.current = stream; if (videoRef.current) videoRef.current.srcObject = stream; setReady(true) })
      .catch(() => setErr('无法访问相机，请检查权限'))
    return () => streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  const snap = () => {
    const v = videoRef.current; if (!v || !ready) return
    const MAX = 1280; let w = v.videoWidth, h = v.videoHeight
    if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h*MAX/w); w = MAX } else { w = Math.round(w*MAX/h); h = MAX } }
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d').drawImage(v, 0, 0, w, h)
    c.toBlob(blob => { const preview = URL.createObjectURL(blob); setShots(p => [...p, { blob, preview, name:`cam_${Date.now()}.jpg` }]) }, 'image/jpeg', 0.65)
  }

  const remove = (idx) => setShots(prev => { URL.revokeObjectURL(prev[idx].preview); return prev.filter((_,i) => i!==idx) })
  const done   = () => { streamRef.current?.getTracks().forEach(t => t.stop()); onDone(shots) }
  const cancel = () => { streamRef.current?.getTracks().forEach(t => t.stop()); shots.forEach(s => URL.revokeObjectURL(s.preview)); onClose() }

  const STRIP_H  = shots.length > 0 ? 80 : 0
  const CTRL_H   = 120
  const VIDEO_H  = Math.max(100, vh - STRIP_H - CTRL_H)

  return (
    <div style={{ position:'fixed', top:0, left:0, width:'100%', height: vh+'px', zIndex:9999, background:'#000', overflow:'hidden' }}>

      {/* Thumbnail strip */}
      {shots.length > 0 && (
        <div style={{ height:STRIP_H+'px', display:'flex', gap:6, padding:'8px', overflowX:'auto', background:'#111', alignItems:'center' }}>
          {shots.map((s,i) => (
            <div key={i} style={{ position:'relative', flexShrink:0, width:64, height:64, borderRadius:10, overflow:'hidden', border:'2px solid rgba(255,255,255,0.35)' }}>
              <img src={s.preview} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              <button onClick={() => remove(i)} style={{ position:'absolute', top:2, right:2, width:18, height:18, borderRadius:'50%', background:'rgba(0,0,0,0.8)', color:'#fff', border:'none', fontSize:13, cursor:'pointer' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Viewfinder */}
      {err ? (
        <div style={{ height:VIDEO_H+'px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'#fff', gap:16, padding:24 }}>
          <p style={{ textAlign:'center', fontSize:15 }}>{err}</p>
          <button onClick={() => libRef.current?.click()} style={{ padding:'10px 24px', background:'#2563eb', borderRadius:12, color:'#fff', border:'none', fontSize:15, fontWeight:600 }}>从相册选择</button>
        </div>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted style={{ width:'100%', height:VIDEO_H+'px', objectFit:'cover', display:'block' }} />
      )}

      {/* Controls */}
      <div style={{ height:CTRL_H+'px', background:'#000', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 32px' }}>
        <button onClick={cancel} style={{ color:'#fff', background:'none', border:'none', fontSize:17, cursor:'pointer', minWidth:56 }}>取消</button>
        <button onPointerDown={snap} disabled={!ready && !err} style={{ width:72, height:72, borderRadius:'50%', border:'4px solid #fff', background:'transparent', opacity: ready||err ? 1 : 0.4, cursor:'pointer', WebkitTapHighlightColor:'transparent', flexShrink:0 }}>
          <div style={{ width:'100%', height:'100%', borderRadius:'50%', background:'rgba(255,255,255,0.12)' }} />
        </button>
        <button onClick={done} style={{ background:'none', border:'none', fontSize:17, fontWeight:700, color: shots.length>0 ? '#60a5fa' : 'rgba(255,255,255,0.3)', cursor:'pointer', minWidth:56, textAlign:'right' }}>
          {shots.length>0 ? `完成(${shots.length})` : '完成'}
        </button>
      </div>

      <input ref={libRef} type="file" accept="image/*" multiple style={{ display:'none' }} onChange={e => { Array.from(e.target.files).forEach(f => { const img=new Image(), u=URL.createObjectURL(f); img.onload=()=>{ URL.revokeObjectURL(u); const MAX=1280; let w=img.width,h=img.height; if(w>MAX||h>MAX){if(w>h){h=Math.round(h*MAX/w);w=MAX}else{w=Math.round(w*MAX/h);h=MAX}} const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);c.toBlob(blob=>setShots(p=>[...p,{blob,preview:URL.createObjectURL(blob),name:f.name}]),'image/jpeg',0.65)}; img.src=u }); e.target.value='' }} />
    </div>
  )
}

// ── Icon buttons ─────────────────────────────────────────────────────────────
function IconMic({ active, cls = 'w-4 h-4' }) {
  return (
    <svg className={cls} fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="9" y="2" width="6" height="11" rx="3"/>
      <path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>
    </svg>
  )
}
function IconImage({ cls = 'w-4 h-4' }) {
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <path strokeLinecap="round" d="m21 15-5-5L5 21"/>
    </svg>
  )
}
function IconX2() {
  return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg>
}
function IconHistory() {
  return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5M12 7v5l3 2"/></svg>
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AIInputBox({ ros = [], employees = [] }) {
  const { user } = useAuth()
  const toast    = useToast()

  const [text,        setText]        = useState('')
  const [loading,     setLoading]     = useState(false)
  const [reparsing,   setReparse]     = useState(false) // silent background re-parse
  const [result,      setResult]      = useState(null)
  const [actions,     setActions]     = useState([])
  const [error,       setError]       = useState('')
  const [applying,    setApplying]    = useState(false)
  const [applied,     setApplied]     = useState(false)
  const [noKey,       setNoKey]       = useState(false)
  const [listening,   setListening]   = useState(false)
  const [images,          setImages]          = useState([])
  const [showPhotoSheet,  setShowPhotoSheet]  = useState(false)
  const [showCamera,      setShowCamera]      = useState(false)
  const [uploadProgress,  setUploadProgress]  = useState({ done: 0, total: 0 })
  const [isTranscribing,  setIsTranscribing]  = useState(false)  // Whisper processing
  const [recordSecs,      setRecordSecs]      = useState(0)      // elapsed recording seconds
  const [audioLevel,      setAudioLevel]      = useState(0)      // 0-1 for bar heights
  const [showHistory,     setShowHistory]     = useState(false)
  const [history,         setHistory]         = useState([])

  const fileInputRef      = useRef(null)   // gallery picker
  const cameraRef         = useRef(null)   // camera capture
  const submittedText     = useRef('')     // text that produced the current AI result
  const reparseTimer      = useRef(null)
  // Whisper voice refs
  const mediaRecorderRef  = useRef(null)
  const audioChunksRef    = useRef([])
  const audioContextRef   = useRef(null)
  const analyserRef       = useRef(null)
  const levelAnimRef      = useRef(null)
  const recordTimerRef    = useRef(null)

  // Sync actions from result whenever result changes
  useEffect(() => {
    if (result?.actions) setActions(result.actions)
  }, [result])

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(GIB_HISTORY_KEY) || '[]')
      setHistory(Array.isArray(saved) ? saved : [])
    } catch {
      setHistory([])
    }
  }, [])

  const rememberHistory = (value) => {
    const entry = value.trim()
    if (!entry) return
    setHistory(prev => {
      const next = [entry, ...prev.filter(item => item !== entry)].slice(0, 12)
      localStorage.setItem(GIB_HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }

  const useHistoryItem = (value) => {
    setText(value)
    setResult(null)
    setActions([])
    setApplied(false)
    setShowHistory(false)
  }

  // ── Auto re-parse when textarea changes after AI result is shown ─────────
  // Debounce 1.2s — silently refresh action cards without full spinner
  useEffect(() => {
    if (!result || images.length > 0 || loading || applying) return
    if (text.trim() === submittedText.current.trim()) return
    if (text.trim().length < 6) return

    clearTimeout(reparseTimer.current)
    reparseTimer.current = setTimeout(async () => {
      try {
        setReparse(true)
        const key = await getApiKey()
        if (!key) return
        const parsed = await parseShopInput({ text, ros, employees, images: [] })
        if (!parsed.raw) {
          setResult(parsed)
          submittedText.current = text
        }
      } catch { /* silent — user can re-submit manually */ }
      finally { setReparse(false) }
    }, 1200)

    return () => clearTimeout(reparseTimer.current)
  }, [text])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Voice input — Whisper (OpenAI) ───────────────────────────────────────
  // Records audio via MediaRecorder, sends to Whisper on stop.
  // Whisper auto-detects language — Chinese / English / Spanish mixed works perfectly.
  const toggleVoice = async () => {
    // ── STOP recording → send to Whisper ──────────────────────────────────
    if (listening) {
      setListening(false)

      // Stop timers & audio analysis
      clearInterval(recordTimerRef.current)
      cancelAnimationFrame(levelAnimRef.current)
      audioContextRef.current?.close().catch(() => {})
      setAudioLevel(0); setRecordSecs(0)

      const mr = mediaRecorderRef.current
      if (!mr) return

      // Wait for MediaRecorder to flush remaining data
      const blob = await new Promise(resolve => {
        mr.onstop = () => resolve(new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' }))
        mr.stop()
        mr.stream.getTracks().forEach(t => t.stop())
      })

      if (!blob || blob.size < 1000) return  // too short / empty

      setIsTranscribing(true)
      try {
        const transcript = await transcribeWithWhisper(blob)
        if (transcript.trim()) {
          setText(prev => prev.trimEnd() ? prev.trimEnd() + ' ' + transcript.trim() : transcript.trim())
        }
      } catch (err) {
        if (err.message === 'NO_OPENAI_KEY') {
          setError('Add your OpenAI API key in Settings to use voice input.')
        } else {
          setError('Transcription failed: ' + err.message)
        }
      } finally {
        setIsTranscribing(false)
      }
      return
    }

    // ── START recording ────────────────────────────────────────────────────
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

      // Audio level analyzer (drives the animated bars)
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = audioCtx
      analyserRef.current     = analyser
      const levelBuf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(levelBuf)
        const avg = levelBuf.reduce((a, b) => a + b, 0) / levelBuf.length
        setAudioLevel(avg / 255)
        levelAnimRef.current = requestAnimationFrame(tick)
      }
      tick()

      // Recording timer
      setRecordSecs(0)
      recordTimerRef.current = setInterval(() => setRecordSecs(s => s + 1), 1000)

      // MediaRecorder — prefer webm, fallback to mp4 for Safari
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                     : MediaRecorder.isTypeSupported('audio/webm')              ? 'audio/webm'
                     : 'audio/mp4'
      const mr = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start(250)  // collect chunks every 250ms so onstop gets everything
      mediaRecorderRef.current = mr

      setListening(true)
    } catch (err) {
      setError('Microphone access denied — please allow microphone in browser settings.')
    }
  }

  // ── Image handling ────────────────────────────────────────────────────────
  // Compress to max 1920px JPEG 0.82 quality — dramatically reduces upload size/time
  const compressImage = (file) => new Promise((resolve) => {
    const img = new Image()
    const objUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objUrl)
      const MAX = 1280
      let { width, height } = img
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round(height * MAX / width); width = MAX }
        else                { width = Math.round(width  * MAX / height); height = MAX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      canvas.toBlob(resolve, 'image/jpeg', 0.65)
    }
    img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(file) } // fallback: use original
    img.src = objUrl
  })

  const readImageFile = (file) => {
    if (!file.type.startsWith('image/')) return
    compressImage(file).then(blob => {
      const preview = URL.createObjectURL(blob)
      setImages(prev => [...prev, { blob, preview, name: file.name }])
    })
  }

  const handleFileChange = (e) => {
    Array.from(e.target.files).forEach(readImageFile)
    e.target.value = ''  // reset so same file can be re-selected
  }

  const removeImage = (idx) => setImages(prev => {
    URL.revokeObjectURL(prev[idx]?.preview)  // free memory
    return prev.filter((_, i) => i !== idx)
  })

  // ── Upload one blob via uploadBytesResumable with stall detection ────────────
  // If no bytes transfer for STALL_MS, we cancel and reject.
  // This is far more reliable than uploadBytes on iOS Safari.
  const uploadOneBlob = (sRef, blob) => new Promise((resolve, reject) => {
    const STALL_MS = 15000   // 15s with zero progress = stall → fail
    let stallTimer = null

    const resetStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        task.cancel()
        reject(new Error('Upload stalled — check network connection'))
      }, STALL_MS)
    }

    const task = uploadBytesResumable(sRef, blob, { contentType: 'image/jpeg' })
    resetStall()

    task.on('state_changed',
      (snap) => {
        // Any bytes transferred means connection is alive — reset stall clock
        if (snap.bytesTransferred > 0) resetStall()
      },
      (err) => { clearTimeout(stallTimer); reject(err) },
      ()    => { clearTimeout(stallTimer); resolve(task.snapshot) }
    )
  })

  // ── Submit ────────────────────────────────────────────────────────────────
  // ── Direct image upload — no AI, just regex RO# + keyword label ─────────────
  const handleDirectImageUpload = async () => {
    setLoading(true); setError('')
    setUploadProgress({ done: 0, total: images.length })
    const roNumber = extractRoNumber(text, ros)
    if (!roNumber) {
      setError('Include an RO number, e.g. "9556 check-in photos"')
      setLoading(false); return
    }
    const roDoc = ros.find(r => r.roNumber === roNumber)
    if (!roDoc) {
      setError(`RO #${roNumber} not found`)
      setLoading(false); return
    }
    const { label: typeLabel, slug: typeSlug } = detectPhotoType(text)
    const author = employees.find(e => e.uid === user.uid)?.name ?? user.email
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const now    = new Date().toISOString()
    const ts     = Date.now()

    try {
      // Upload sequentially — avoids overwhelming mobile radio with concurrent streams
      const attachments = []
      for (let idx = 0; idx < images.length; idx++) {
        const img    = images[idx]
        const padded = String(idx + 1).padStart(2, '0')
        const filename = `${ts}_${typeSlug}_${padded}.jpg`
        const sRef = storageRef(storage, `ros/${roDoc.id}/attachments/${filename}`)

        await uploadOneBlob(sRef, img.blob)
        const url = await getDownloadURL(sRef)

        attachments.push({ url, name: `${typeSlug}_${padded}`, label: typeLabel, uploadedAt: now })
        setUploadProgress({ done: idx + 1, total: images.length })
      }

      // Write attachments + auto-note in one updateDoc
      const n         = images.length
      const noteEntry = `[${stamp} - ${author}] Uploaded ${n} ${typeLabel} photo${n !== 1 ? 's' : ''}`
      await updateDoc(doc(db, 'ros', roDoc.id), {
        attachments: arrayUnion(...attachments),
        notes:       `${noteEntry}\n${roDoc.notes ?? ''}`,
        updatedAt:   serverTimestamp(),
      })

      toast.success(`${n} ${typeLabel} photo${n !== 1 ? 's' : ''} → RO #${roNumber}`)
      rememberHistory(text)
      setText(''); setImages([])
    } catch (err) {
      console.error('[AIInputBox] Direct upload failed:', err)
      setError('Upload failed: ' + err.message)
    } finally {
      setLoading(false)
      setUploadProgress({ done: 0, total: 0 })
    }
  }

  // ── Submit: images → direct upload; text-only → AI parse ─────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim() && images.length === 0) return

    // Images present → bypass AI entirely: regex RO# + auto-label + upload
    if (images.length > 0) {
      await handleDirectImageUpload()
      return
    }

    // Text-only → Claude AI parsing
    setLoading(true); setError(''); setResult(null); setApplied(false)
    try {
      const key = await getApiKey()
      if (!key) { setNoKey(true); setLoading(false); return }
      const parsed = await parseShopInput({ text, ros, employees, images: [] })
      if (parsed.raw) throw new Error('AI returned unexpected format. Please rephrase.')
      setResult(parsed)
      rememberHistory(text)
      submittedText.current = text
    } catch (err) {
      if (err.message === 'NO_API_KEY')  { setNoKey(true); return }
      if (err.message === 'INVALID_KEY') { setError('API key is invalid. Please update it in Settings.'); return }
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Apply actions + upload images ─────────────────────────────────────────
  const handleApply = async () => {
    if (!actions.length && images.length === 0) return
    setApplying(true)

    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees.find(e => e.uid === user.uid)?.name ?? user.email
    const now    = new Date().toISOString()

    // ── Step 1: bucket all actions by RO, building one merged update per doc ──
    // This cuts N sequential Firestore writes down to 1 per RO.
    const roMap = new Map() // roId → { roDoc, fields, changeLogEntries }

    const getEntry = (roDoc) => {
      if (!roMap.has(roDoc.id)) {
        roMap.set(roDoc.id, { roDoc, fields: { updatedAt: serverTimestamp() }, changeLogEntries: [], taskPromises: [] })
      }
      return roMap.get(roDoc.id)
    }

    for (const action of actions) {
      const roDoc = ros.find(r => r.roNumber === action.roNumber)
      if (!roDoc) continue
      const entry = getEntry(roDoc)

      switch (action.type) {
        case 'add_note': {
          const prev = roDoc.notes ?? ''
          const line = `[${stamp} - ${author}] ${action.note}`
          // Merge multiple notes if >1 action on same RO
          entry.fields.notes = entry.fields.notes
            ? `${line}\n${entry.fields.notes}`
            : `${line}\n${prev}`
          break
        }
        case 'update_status':
          entry.fields.status = action.status
          entry.changeLogEntries.push({ type: 'update_status', value: action.status, by: author, at: now, source: 'gib' })
          break
        case 'update_parts_status':
          entry.fields.partsStatus = action.partsStatus
          entry.changeLogEntries.push({ type: 'update_parts_status', value: action.partsStatus, by: author, at: now, source: 'gib' })
          break
        case 'update_car_status':
          entry.fields.carStatus = action.carStatus
          entry.changeLogEntries.push({ type: 'update_car_status', value: action.carStatus, by: author, at: now, source: 'gib' })
          break
        case 'update_dropoff_date':
          entry.fields.dropOffDate = action.dropOffDate
          entry.changeLogEntries.push({ type: 'update_dropoff_date', value: action.dropOffDate, by: author, at: now, source: 'gib' })
          break
        case 'update_due_date':
          entry.fields.promisedDate = action.dueDate
          entry.changeLogEntries.push({ type: 'update_due_date', value: action.dueDate, by: author, at: now, source: 'gib' })
          break
        case 'update_rental':
          entry.fields.hasRental = action.hasRental
          entry.changeLogEntries.push({ type: 'update_rental', value: String(action.hasRental), by: author, at: now, source: 'gib' })
          break
        case 'assign_body_man': {
          const assignee = findEmployeeByName(employees, action.assigneeName)
          if (assignee) {
            entry.fields.assignedBodyMan = assignee.uid
            entry.changeLogEntries.push({ type: 'assign_body_man', value: assignee.uid, label: assignee.name, by: author, at: now, source: 'gib' })
          }
          break
        }
        case 'assign_task': {
          const assignee = findEmployeeByName(employees, action.assigneeName)
          if (!assignee) {
            throw new Error(`Could not match task assignee "${action.assigneeName}". Edit the suggested action and choose a valid employee name.`)
          }
          const roDueDate  = roDoc.cccDateOut || roDoc.promisedDate || null
          const isBodyTask = /body\s*(man|tech|work)/i.test(action.title ?? '')
          if (isBodyTask) entry.fields.assignedBodyMan = assignee.uid
          entry.taskPromises.push(addDoc(collection(db, 'tasks'), {
            roId: roDoc.id, roNumber: roDoc.roNumber, vehicleInfo: roDoc.vehicle,
            assignedTo: assignee.uid, assignedBy: user.uid,
            assignedToName: assignee.name ?? '',
            title: action.title, description: action.description ?? '',
            priority: dueDateToPriority(roDoc),
            dueDate: roDueDate,
            status: 'pending',
            createdAt: serverTimestamp(),
          }))
          break
        }
      }
    }

    // ── Step 2: fire all Firestore doc writes + task creates in parallel ───────
    // (Images are now handled in handleDirectImageUpload — never reach here with images)
    const firestorePromises = [...roMap.values()].map(({ roDoc, fields, changeLogEntries, taskPromises }) => {
      const updates = { ...fields }
      if (changeLogEntries.length) updates.changeLog = arrayUnion(...changeLogEntries)
      return Promise.all([
        updateDoc(doc(db, 'ros', roDoc.id), updates).catch(e => console.error(e)),
        ...taskPromises,
      ])
    })

    // ── Step 3: await everything ───────────────────────────────────────────────
    try {
      await Promise.all(firestorePromises)

      // ── Toasts ──────────────────────────────────────────────────────────────
      if (actions.length > 0) {
        const allNums = [...new Set(actions.map(a => a.roNumber).filter(Boolean))].map(n => `#${n}`).join(', ')
        toast.success(`${actions.length} update${actions.length !== 1 ? 's' : ''} applied to RO ${allNums}`)
      }

      setApplied(true)
      setResult(null)
      setActions([])
      setText('')
      setImages([])
      setTimeout(() => setApplied(false), 2500)
    } catch (err) {
      console.error('[handleApply]', err)
      setError('Apply failed: ' + err.message)
    } finally {
      setApplying(false)   // ALWAYS unblock the button, even on error
    }
  }

  const canSubmit = (text.trim() || images.length > 0) && !loading && !applying && !isTranscribing
  const mentionCandidates = useMemo(() => buildMentionCandidates(employees, []), [employees])

  return (
    <>
    {showPhotoSheet && (
      <PhotoSheet
        onCamera={() => { setShowPhotoSheet(false); setTimeout(() => setShowCamera(true), 50) }}
        onLibrary={() => { setShowPhotoSheet(false); setTimeout(() => fileInputRef.current?.click(), 50) }}
        onClose={() => setShowPhotoSheet(false)}
      />
    )}
    {showCamera && (
      <CameraModal
        onDone={(shots) => { setImages(prev => [...prev, ...shots]); setShowCamera(false) }}
        onClose={() => setShowCamera(false)}
      />
    )}
    <div className="bg-white dark:bg-zinc-900 rounded-2xl border-2 border-blue-200 dark:border-blue-800 shadow-sm p-5 mb-5">

      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 leading-tight">Quick Update</h2>
          <p className="text-xs text-gray-400 dark:text-zinc-500">
            {images.length > 0 ? '📷 Photos ready — tap Submit to upload' : 'type or speak — AI will parse & apply'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHistory(v => !v)}
          className={`shrink-0 p-1.5 rounded-lg border text-xs transition-colors ${
            showHistory
              ? 'bg-blue-50 border-blue-300 text-blue-600 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
              : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'
          }`}
          title="GIB history"
        >
          <IconHistory />
        </button>
      </div>

      {showHistory && (
        <div className="mb-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
            <p className="text-xs font-semibold text-gray-700 dark:text-zinc-200">Recent GIB inputs</p>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(GIB_HISTORY_KEY)
                setHistory([])
              }}
              className="text-xs text-gray-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
            >
              Clear
            </button>
          </div>
          {history.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-400 dark:text-zinc-500">No history yet.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto p-1">
              {history.map((item, idx) => (
                <button
                  key={`${idx}-${item}`}
                  type="button"
                  onClick={() => useHistoryItem(item)}
                  className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800"
                >
                  <span className="line-clamp-2">{item}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2.5 mb-4">
          {images.map((img, i) => (
            <div key={i} className="relative group w-20 h-20 rounded-xl overflow-hidden border-2 border-blue-200 dark:border-blue-900 shadow-sm">
              <img src={img.preview} alt={img.name} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute inset-0 bg-black/60 text-white opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity flex items-center justify-center"
              >
                <IconX2 />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* ── Textarea ─────────────────────────────────────────────────── */}
        <MentionTextarea
          value={text}
          onChange={e => setText(e.target.value)}
          candidates={mentionCandidates}
          dropdownPlacement="inside"
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault()
              if (canSubmit) handleSubmit(e)
            }
          }}
          placeholder={images.length > 0
            ? 'RO number + photo type, e.g. "9556 check-in" or "9556 in progress photos"'
            : 'e.g. "RO9448 dropped off 4-25, w/o rental, ordered parts thru PT eta 4-29"'}
          rows={4}
          className="w-full px-4 py-3 mb-3 border border-gray-200 dark:border-zinc-700 rounded-xl text-[15px] sm:text-sm leading-relaxed bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-800 resize-none transition-colors"
          disabled={loading || applying}
        />

        {/* ── Mobile button layout ──────────────────────────────────────── */}
        <div className="sm:hidden space-y-2.5">
          {/* Voice + Photos — 2-col */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* Voice button — Whisper powered */}
            <button
              type="button"
              onClick={toggleVoice}
              disabled={isTranscribing}
              className={`flex flex-col items-center justify-center gap-1 h-14 rounded-xl border-2 text-sm font-semibold transition-all active:scale-95
                ${listening
                  ? 'bg-red-500 border-red-400 text-white'
                  : isTranscribing
                  ? 'bg-purple-100 border-purple-300 dark:bg-purple-950/40 dark:border-purple-800 text-purple-600 dark:text-purple-300'
                  : 'bg-gray-50 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-300'}`}
            >
              {listening ? (
                /* Live audio-level bars driven by AudioContext analyser */
                <>
                  <span className="flex items-end gap-[3px] h-4">
                    {[0,1,2,3,4].map(i => (
                      <span key={i} className="w-[3px] rounded-full bg-white transition-none"
                        style={{ height: `${Math.max(20, Math.min(100, (audioLevel * 100) * [0.6,1,0.8,0.9,0.7][i] + 15))}%` }} />
                    ))}
                  </span>
                  <span className="text-xs font-mono">
                    {String(Math.floor(recordSecs/60)).padStart(2,'0')}:{String(recordSecs%60).padStart(2,'0')}
                  </span>
                </>
              ) : isTranscribing ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  <span className="text-xs">Transcribing</span>
                </>
              ) : (
                <>
                  <IconMic active={false} cls="w-5 h-5" />
                  <span className="text-xs">Voice</span>
                </>
              )}
            </button>

            {/* Photos — opens PhotoSheet: 拍照 / 照片图库 */}
            <button
              type="button"
              onClick={() => setShowPhotoSheet(true)}
              className="relative flex items-center justify-center gap-2.5 h-14 rounded-xl border-2 bg-gray-50 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 text-sm font-semibold transition-all active:scale-95"
            >
              <IconImage cls="w-5 h-5" />
              {images.length > 0 ? `Photos (${images.length})` : 'Photos'}
            </button>
          </div>

          {/* Full-width submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full h-14 bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white text-base font-bold rounded-xl transition-all active:scale-[0.98]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                {uploadProgress.total > 0
                  ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                  : images.length > 0 ? 'Uploading…' : 'Parsing…'}
              </span>
            ) : applying ? 'Applying…' : images.length > 0 ? `Upload ${images.length} Photo${images.length !== 1 ? 's' : ''} →` : 'Submit →'}
          </button>
        </div>

        {/* ── Desktop button layout (inline row) ───────────────────────── */}
        <div className="hidden sm:flex items-center gap-2">
          <button
            type="button"
            onClick={toggleVoice}
            disabled={isTranscribing}
            className={`flex items-center justify-center px-2.5 py-2 rounded-lg border transition-colors shrink-0
              ${listening
                ? 'bg-red-500 border-red-500 text-white'
                : isTranscribing
                ? 'bg-purple-100 border-purple-300 text-purple-600 dark:bg-purple-950/40 dark:border-purple-700'
                : 'border-gray-300 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'}`}
          >
            {isTranscribing
              ? <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
              : <IconMic active={listening} />
            }
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="relative flex items-center justify-center px-2.5 py-2 rounded-lg border border-gray-300 dark:border-zinc-700 text-gray-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800 transition-colors shrink-0"
          >
            <IconImage />
            {images.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {images.length}
              </span>
            )}
          </button>

          {listening      && <span className="text-xs text-red-500 font-medium">🎙 {String(Math.floor(recordSecs/60)).padStart(2,'0')}:{String(recordSecs%60).padStart(2,'0')}</span>}
          {isTranscribing && <span className="text-xs text-purple-600 font-medium animate-pulse">✨ Transcribing…</span>}
          <div className="flex-1" />

          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                {uploadProgress.total > 0
                  ? `${uploadProgress.done}/${uploadProgress.total}…`
                  : images.length > 0 ? 'Uploading…' : 'Parsing…'}
              </span>
            ) : images.length > 0 ? `Upload ${images.length} Photo${images.length !== 1 ? 's' : ''}` : 'Submit'}
          </button>
        </div>

        {/* Gallery picker — multiple select */}
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
        {/* Camera capture — opens native camera directly, reset after each shot for re-use */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
      </form>

      {noKey && (
        <div className="mt-3 flex items-center gap-2 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <span>⚙</span>
          <span>AI not configured. <a href="/settings" className="underline font-medium">Add your Anthropic API key in Settings</a>.</span>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {result?.translation && (
        <div className="mt-3 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 rounded px-3 py-1.5">
          🌐 Translated: "{result.translation}"
        </div>
      )}

      {result?.needsClarification && (
        <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ❓ {result.needsClarification}
        </div>
      )}

      {/* Action cards — editable */}
      {actions.length > 0 && !applied && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wide flex items-center gap-2">
            {actions.length} action{actions.length > 1 ? 's' : ''} — edit or remove, then confirm:
            {reparsing && (
              <span className="flex items-center gap-1 text-blue-400 font-normal normal-case tracking-normal">
                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                updating…
              </span>
            )}
          </p>
          {actions.map((action, i) => (
            <EditableActionCard
              key={i}
              action={action}
              employees={employees}
              ros={ros}
              onChange={(updated) => setActions(prev => prev.map((a, idx) => idx === i ? updated : a))}
              onDelete={() => setActions(prev => prev.filter((_, idx) => idx !== i))}
            />
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleApply}
              disabled={applying || actions.length === 0}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {applying ? 'Applying…' : `✓ Apply ${actions.length} Action${actions.length !== 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => { setResult(null); setActions([]); setImages([]) }}
              className="px-3 py-1.5 border border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied && (
        <div className="mt-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          ✅ All updates applied successfully!
        </div>
      )}
    </div>
    </>
  )
}
