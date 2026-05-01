// ─── Chat ─────────────────────────────────────────────────────────────────────
// Three-panel Apple-style chat: icon nav | list panel | message area
// Message types: text · image (Firebase Storage) · voice (MediaRecorder)

import { useState, useEffect, useRef, useMemo, useCallback, } from 'react'
import {
  collection, doc, onSnapshot, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp, getDocs,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { format, isToday, isYesterday } from 'date-fns'

// ── Icons ─────────────────────────────────────────────────────────────────────
const I = {
  Chat:     () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>,
  Contacts: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path strokeLinecap="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
  Compose:  () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>,
  Send:     () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  Mic:      () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="11" rx="3"/><path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/></svg>,
  Photo:    () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 19"/></svg>,
  Back:     () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>,
  Close:    () => <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg>,
  Check:    () => <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>,
  Group:    () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path strokeLinecap="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
  Search:   () => <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>,
  Play:     () => <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function dmKey(a, b) { return [a, b].sort().join('_') }

function fmtTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (isToday(d))     return format(d, 'HH:mm')
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'M/d')
}
function fmtFull(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return format(d, 'HH:mm')
}
function getInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

const HUE = ['bg-blue-500','bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-cyan-500','bg-indigo-500','bg-teal-500']
function hue(uid = '') {
  let n = 0; for (let i = 0; i < uid.length; i++) n += uid.charCodeAt(i)
  return HUE[n % HUE.length]
}

// ── Avatar ────────────────────────────────────────────────────────────────────
function Avatar({ uid, name, size = 8 }) {
  const sz = `w-${size} h-${size}`
  const ts = size <= 8 ? 'text-xs' : 'text-sm'
  return (
    <div className={`${sz} ${ts} rounded-full ${hue(uid)} text-white font-semibold flex items-center justify-center shrink-0 select-none`}>
      {getInitials(name)}
    </div>
  )
}

// ── Search box ────────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="relative mx-3 my-2">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500 pointer-events-none">
        <I.Search />
      </span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-7 pr-3 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 border-none focus:outline-none focus:ring-2 focus:ring-blue-500/40"
      />
    </div>
  )
}

// ── New Chat Modal ────────────────────────────────────────────────────────────
function NewChatModal({ myUid, allUsers, onClose, onOpen }) {
  const [q,          setQ]          = useState('')
  const [selected,   setSelected]   = useState([])
  const [groupMode,  setGroupMode]  = useState(false)
  const [groupName,  setGroupName]  = useState('')
  const [busy,       setBusy]       = useState(false)

  const filtered = allUsers.filter(u => u.uid !== myUid && u.name.toLowerCase().includes(q.toLowerCase()))

  const toggle = u => setSelected(p => p.find(s => s.uid === u.uid) ? p.filter(s => s.uid !== u.uid) : [...p, u])

  const start = async () => {
    if (!selected.length) return
    setBusy(true)
    try {
      if (!groupMode && selected.length === 1) {
        const key  = dmKey(myUid, selected[0].uid)
        const snap = await getDocs(query(collection(db, 'conversations'), where('dmKey', '==', key)))
        if (!snap.empty) { onOpen({ id: snap.docs[0].id, ...snap.docs[0].data() }); onClose(); return }
        const ref = await addDoc(collection(db, 'conversations'), {
          type: 'dm', members: [myUid, selected[0].uid], dmKey: key,
          name: null, lastMessage: '', lastAt: serverTimestamp(), createdAt: serverTimestamp(),
        })
        onOpen({ id: ref.id, type: 'dm', members: [myUid, selected[0].uid] })
      } else {
        const members = [myUid, ...selected.map(u => u.uid)]
        const name    = groupName.trim() || selected.map(u => u.name.split(' ')[0]).join(', ')
        const ref = await addDoc(collection(db, 'conversations'), {
          type: 'group', members, dmKey: null, name,
          lastMessage: '', lastAt: serverTimestamp(), createdAt: serverTimestamp(),
        })
        onOpen({ id: ref.id, type: 'group', members, name })
      }
    } finally { setBusy(false); onClose() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm px-4 pb-4 sm:pb-0" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm border border-gray-200 dark:border-zinc-800 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">New Conversation</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg"><I.Close /></button>
        </div>
        <div className="flex gap-1.5 px-4 pt-3">
          {['Direct Message','Group Chat'].map((label, i) => (
            <button key={i} onClick={() => { setGroupMode(!!i); if (!i) setSelected(p => p.slice(0,1)) }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors
                ${groupMode === !!i ? 'bg-blue-600 text-white border-transparent' : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}>
              {label}
            </button>
          ))}
        </div>
        {groupMode && (
          <div className="px-4 pt-3">
            <input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="Group name (optional)"
              className="w-full border border-gray-200 dark:border-zinc-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Search people…" />
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-1">
            {selected.map(u => (
              <span key={u.uid} onClick={() => toggle(u)}
                className="flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full cursor-pointer">
                {u.name.split(' ')[0]} <I.Close />
              </span>
            ))}
          </div>
        )}
        <div className="max-h-48 overflow-y-auto px-2 py-1 space-y-0.5">
          {filtered.map(u => {
            const sel = !!selected.find(s => s.uid === u.uid)
            return (
              <button key={u.uid} onClick={() => groupMode ? toggle(u) : setSelected([u])}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${sel ? 'bg-blue-50 dark:bg-blue-950/50' : 'hover:bg-gray-50 dark:hover:bg-zinc-800'}`}>
                <Avatar uid={u.uid} name={u.name} size={8} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{u.name}</p>
                  <p className="text-xs text-gray-400 dark:text-zinc-500">{u.role}</p>
                </div>
                {sel && <span className="text-blue-500 dark:text-blue-400 shrink-0"><I.Check /></span>}
              </button>
            )
          })}
          {!filtered.length && <p className="text-xs text-gray-300 dark:text-zinc-700 text-center py-4">No users found</p>}
        </div>
        <div className="px-4 py-3 border-t border-gray-100 dark:border-zinc-800">
          <button onClick={start} disabled={!selected.length || busy}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold rounded-xl transition-colors">
            {busy ? 'Starting…' : groupMode ? `Create Group (${selected.length})` : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Message Bubble ────────────────────────────────────────────────────────────
function Bubble({ msg, isOwn, showName }) {
  const isImage = msg.type === 'image'
  const isAudio = msg.type === 'audio'

  return (
    <div className={`flex gap-2 items-end ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && <Avatar uid={msg.senderId} name={msg.senderName} size={7} />}
      <div className={`max-w-[68%] flex flex-col gap-0.5 ${isOwn ? 'items-end' : 'items-start'}`}>
        {showName && !isOwn && (
          <p className="text-[11px] text-gray-400 dark:text-zinc-500 px-1 font-medium">{msg.senderName}</p>
        )}
        {isImage ? (
          <img
            src={msg.imageUrl}
            alt="shared"
            className="max-w-[220px] max-h-[220px] rounded-2xl object-cover shadow-sm cursor-pointer"
            onClick={() => window.open(msg.imageUrl, '_blank')}
          />
        ) : isAudio ? (
          <div className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl
            ${isOwn ? 'bg-blue-600 rounded-br-sm' : 'bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 rounded-bl-sm shadow-sm'}`}>
            <span className={isOwn ? 'text-white/80' : 'text-blue-500 dark:text-blue-400'}><I.Play /></span>
            <audio src={msg.audioUrl} controls className="h-6 max-w-[140px] opacity-90"
              style={{ filter: isOwn ? 'brightness(10)' : 'none' }} />
          </div>
        ) : (
          <div className={`px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-relaxed break-words shadow-sm
            ${isOwn
              ? 'bg-blue-600 text-white rounded-br-sm'
              : 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 border border-gray-100 dark:border-zinc-700 rounded-bl-sm'}`}>
            {msg.text}
          </div>
        )}
        <p className={`text-[10px] px-1 ${isOwn ? 'text-gray-400 dark:text-zinc-600' : 'text-gray-300 dark:text-zinc-600'}`}>
          {fmtFull(msg.createdAt)}
        </p>
      </div>
    </div>
  )
}

// ── Conversation Panel (right) ────────────────────────────────────────────────
function ConvoPanel({ convo, myUid, allUsers, onBack }) {
  const [messages,    setMessages]    = useState([])
  const [text,        setText]        = useState('')
  const [sending,     setSending]     = useState(false)
  const [recording,   setRecording]   = useState(false)
  const [recSecs,     setRecSecs]     = useState(0)
  const [imgPreview,  setImgPreview]  = useState(null) // { file, url }
  const bottomRef  = useRef(null)
  const fileRef    = useRef(null)
  const mrRef      = useRef(null)
  const chunksRef  = useRef([])
  const timerRef   = useRef(null)
  const myName = allUsers.find(u => u.uid === myUid)?.name ?? 'Me'

  const convoName = useMemo(() => {
    if (convo.type === 'group') return convo.name || 'Group'
    const other = convo.members.find(u => u !== myUid)
    return allUsers.find(u => u.uid === other)?.name ?? 'Unknown'
  }, [convo, myUid, allUsers])

  const otherUserId = convo.type === 'dm' ? convo.members.find(u => u !== myUid) : null

  const subtitle = useMemo(() => {
    if (convo.type === 'group')
      return (convo.members || []).map(uid => uid === myUid ? 'You' : allUsers.find(u => u.uid === uid)?.name ?? '?').join(', ')
    return allUsers.find(u => u.uid === otherUserId)?.role ?? 'Direct Message'
  }, [convo, myUid, allUsers, otherUserId])

  useEffect(() => {
    const q = query(collection(db, 'conversations', convo.id, 'messages'), orderBy('createdAt', 'asc'))
    return onSnapshot(q, snap => setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [convo.id])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // ── Send helpers ────────────────────────────────────────────────────────────
  const postMessage = async (fields, preview = null) => {
    setSending(true)
    if (preview) setImgPreview(null)
    try {
      await addDoc(collection(db, 'conversations', convo.id, 'messages'), {
        senderId: myUid, senderName: myName,
        createdAt: serverTimestamp(),
        ...fields,
      })
      const lastMessage = fields.text || (fields.type === 'image' ? '[Image]' : '[Voice]')
      await updateDoc(doc(db, 'conversations', convo.id), {
        lastMessage, lastAt: serverTimestamp(),
        lastSenderName: myName,
        lastSenderId: myUid,
        [`readBy.${myUid}`]: serverTimestamp(),
      })
    } finally { setSending(false) }
  }

  const sendText = async (e) => {
    e?.preventDefault()
    if (imgPreview) { await sendImage(); return }
    if (!text.trim() || sending) return
    const t = text.trim(); setText('')
    await postMessage({ type: 'text', text: t })
  }

  const sendImage = async () => {
    if (!imgPreview || sending) return
    setSending(true)
    try {
      const path = `chatImages/${convo.id}/${Date.now()}_${imgPreview.file.name}`
      const snap = await uploadBytes(storageRef(storage, path), imgPreview.file)
      const url  = await getDownloadURL(snap.ref)
      await postMessage({ type: 'image', imageUrl: url, text: '' }, imgPreview)
    } catch { setSending(false) }
  }

  const onFileChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setImgPreview({ file, url })
    e.target.value = ''
  }

  // ── Voice recording ─────────────────────────────────────────────────────────
  const toggleRecording = async () => {
    if (recording) {
      // Stop
      setRecording(false)
      clearInterval(timerRef.current)
      setRecSecs(0)
      mrRef.current?.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const mr = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: mimeType })
        if (blob.size < 500) return
        setSending(true)
        try {
          const path = `chatAudio/${convo.id}/${Date.now()}.webm`
          const snap = await uploadBytes(storageRef(storage, path), blob)
          const url  = await getDownloadURL(snap.ref)
          await postMessage({ type: 'audio', audioUrl: url, text: '' })
        } finally { setSending(false) }
      }
      mr.start(200)
      mrRef.current = mr
      setRecSecs(0)
      timerRef.current = setInterval(() => setRecSecs(s => s + 1), 1000)
      setRecording(true)
    } catch { alert('Microphone access denied') }
  }

  const handleKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(e) } }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm shrink-0">
        <button onClick={onBack} className="md:hidden p-1.5 -ml-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg">
          <I.Back />
        </button>
        {convo.type === 'group'
          ? <div className="w-9 h-9 rounded-full bg-violet-500 text-white flex items-center justify-center shrink-0"><I.Group /></div>
          : <Avatar uid={otherUserId} name={convoName} size={9} />
        }
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{convoName}</p>
          <p className="text-xs text-gray-400 dark:text-zinc-500 truncate">{subtitle}</p>
        </div>
      </div>

      {/* ── Messages ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3"
        style={{ background: 'inherit' }}>
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-300 dark:text-zinc-700">
            <svg className="w-12 h-12 opacity-30" fill="none" stroke="currentColor" strokeWidth={0.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
            </svg>
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-xs opacity-60">Say something 👋</p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isOwn   = msg.senderId === myUid
          const prev    = messages[i - 1]
          const showName = convo.type === 'group' && !isOwn && msg.senderId !== prev?.senderId
          // Show date separator
          const showDate = i === 0 || (() => {
            const a = msg.createdAt?.toDate?.() ?? new Date()
            const b = messages[i-1]?.createdAt?.toDate?.() ?? new Date()
            return a.toDateString() !== b.toDateString()
          })()
          return (
            <div key={msg.id}>
              {showDate && msg.createdAt && (
                <div className="flex items-center gap-2 my-3">
                  <div className="flex-1 h-px bg-gray-100 dark:bg-zinc-800" />
                  <span className="text-[11px] text-gray-400 dark:text-zinc-600 font-medium px-1">
                    {isToday(msg.createdAt.toDate?.() ?? new Date())
                      ? 'Today'
                      : isYesterday(msg.createdAt.toDate?.() ?? new Date())
                      ? 'Yesterday'
                      : format(msg.createdAt.toDate?.() ?? new Date(), 'MMM d')}
                  </span>
                  <div className="flex-1 h-px bg-gray-100 dark:bg-zinc-800" />
                </div>
              )}
              <Bubble msg={msg} isOwn={isOwn} showName={showName} />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* ── Image preview strip ──────────────────────────────────────────── */}
      {imgPreview && (
        <div className="px-4 py-2 border-t border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center gap-3">
          <div className="relative">
            <img src={imgPreview.url} alt="preview" className="h-14 w-14 rounded-xl object-cover shadow-sm" />
            <button
              onClick={() => setImgPreview(null)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-gray-700 text-white rounded-full flex items-center justify-center"
            >
              <I.Close />
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-zinc-400">Press send to share this image</p>
        </div>
      )}

      {/* ── Input bar ───────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-white dark:bg-zinc-900 border-t border-gray-100 dark:border-zinc-800 px-3 py-2.5">
        {/* Recording indicator */}
        {recording && (
          <div className="flex items-center gap-2 px-3 py-1.5 mb-2 bg-red-50 dark:bg-red-950/40 rounded-xl border border-red-200 dark:border-red-900">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              Recording {String(Math.floor(recSecs/60)).padStart(2,'0')}:{String(recSecs%60).padStart(2,'0')}
            </span>
            <span className="text-xs text-red-400 ml-auto">Tap mic to send</span>
          </div>
        )}
        <form onSubmit={sendText} className="flex items-end gap-2">
          {/* Photo button */}
          <button type="button" onClick={() => fileRef.current?.click()}
            className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 dark:text-zinc-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors">
            <I.Photo />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

          {/* Text input */}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={recording ? 'Recording…' : 'Message'}
            disabled={recording}
            rows={1}
            className="flex-1 resize-none px-3 py-2 text-[13.5px] rounded-2xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-50"
            style={{ maxHeight: 120, overflowY: 'auto' }}
            onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
          />

          {/* Mic button */}
          <button type="button" onClick={toggleRecording}
            className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all
              ${recording
                ? 'bg-red-500 text-white shadow-lg shadow-red-500/30 scale-105'
                : 'text-gray-400 dark:text-zinc-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40'}`}>
            <I.Mic />
          </button>

          {/* Send button — appears when there's content */}
          {(text.trim() || imgPreview) && (
            <button type="submit" disabled={sending}
              className="shrink-0 w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white flex items-center justify-center transition-all active:scale-95 shadow-sm">
              <I.Send />
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

// ── Conversation List Item ────────────────────────────────────────────────────
function ConvoItem({ convo, myUid, allUsers, isActive, onClick }) {
  const name = useMemo(() => {
    if (convo.type === 'group') return convo.name || 'Group'
    const other = convo.members.find(u => u !== myUid)
    return allUsers.find(u => u.uid === other)?.name ?? 'Unknown'
  }, [convo, myUid, allUsers])

  const otherId = convo.type === 'dm' ? convo.members.find(u => u !== myUid) : null

  // Unread: lastAt is newer than readBy[myUid]
  const isUnread = useMemo(() => {
    if (!convo.lastAt || !convo.lastMessage) return false
    const readAt = convo.readBy?.[myUid]
    if (!readAt) return true
    return convo.lastAt.toMillis?.() > readAt.toMillis?.()
  }, [convo, myUid])

  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left group
        ${isActive ? 'bg-blue-600 shadow-sm' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
      {/* Avatar with unread dot overlay */}
      <div className="relative shrink-0">
        {convo.type === 'group'
          ? <div className="w-9 h-9 rounded-full bg-violet-500 text-white flex items-center justify-center"><I.Group /></div>
          : <Avatar uid={otherId} name={name} size={9} />
        }
        {isUnread && !isActive && (
          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-blue-500 rounded-full border-2 border-white dark:border-zinc-900 shadow-sm" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-1">
          <p className={`text-sm truncate ${isUnread && !isActive ? 'font-bold text-gray-900 dark:text-gray-100' : `font-semibold ${isActive ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}`}>
            {name}
          </p>
          {convo.lastAt && (
            <span className={`text-[10px] shrink-0 ${isActive ? 'text-blue-200' : isUnread ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-400 dark:text-zinc-600'}`}>
              {fmtTime(convo.lastAt)}
            </span>
          )}
        </div>
        {convo.lastMessage && (
          <p className={`text-xs truncate mt-0.5 ${isActive ? 'text-blue-100' : isUnread ? 'text-gray-700 dark:text-gray-300 font-medium' : 'text-gray-400 dark:text-zinc-500'}`}>
            {convo.lastMessage}
          </p>
        )}
      </div>
    </button>
  )
}

// ── Contacts List Item ────────────────────────────────────────────────────────
function ContactItem({ user, myUid, onClick }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors text-left">
      <Avatar uid={user.uid} name={user.name} size={9} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{user.name}</p>
        <p className="text-xs text-gray-400 dark:text-zinc-500 capitalize truncate">{user.role?.replace(/_/g, ' ')}</p>
      </div>
      <span className="text-xs text-blue-500 dark:text-blue-400 shrink-0 opacity-0 group-hover:opacity-100 font-medium">Chat →</span>
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Chat() {
  const { user }                   = useAuth()
  const [tab,           setTab]    = useState('chats')
  const [conversations, setConvos] = useState([])
  const [allUsers,      setUsers]  = useState([])
  const [activeConvo,   setActive] = useState(null)
  const [showNew,       setNew]    = useState(false)
  const [showSidebar,   setSidebar]= useState(true)
  const [search,        setSearch] = useState('')
  const prevConvosRef              = useRef(null)   // for detecting new messages
  const activeConvoRef             = useRef(null)   // keep ref in sync for notification logic
  const convosRef                  = useRef([])     // stable ref for event handlers
  activeConvoRef.current = activeConvo
  convosRef.current      = conversations

  // Request browser notification permission once
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => onSnapshot(collection(db, 'users'), snap => {
    setUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
  }), [])

  useEffect(() => {
    if (!user?.uid) return
    return onSnapshot(
      query(collection(db, 'conversations'), where('members', 'array-contains', user.uid), orderBy('lastAt', 'desc')),
      snap => {
        const updated = snap.docs.map(d => ({ id: d.id, ...d.data() }))

        // Detect new messages → browser notification
        if (prevConvosRef.current !== null) {
          for (const convo of updated) {
            const prev = prevConvosRef.current.find(c => c.id === convo.id)
            const isActive = activeConvoRef.current?.id === convo.id
            const hasNewMsg = prev && convo.lastAt && prev.lastAt &&
              convo.lastAt.toMillis?.() > prev.lastAt.toMillis?.()
            // Only notify if there's a new message and we're not in the conversation
            if (hasNewMsg && !isActive && convo.lastMessage &&
                'Notification' in window && Notification.permission === 'granted') {
              const sender = convo.type === 'group' ? convo.name : (convo.lastSenderName || 'Someone')
              new Notification(sender, {
                body: convo.lastMessage.startsWith('[') ? convo.lastMessage : convo.lastMessage.slice(0, 80),
                icon: '/favicon.ico',
                tag:  convo.id,
              })
            }
          }
        }
        prevConvosRef.current = updated
        setConvos(updated)
      }
    )
  }, [user?.uid])

  useEffect(() => {
    if (activeConvo) {
      const updated = conversations.find(c => c.id === activeConvo.id)
      if (updated) setActive(updated)
    }
  }, [conversations])  // eslint-disable-line

  // Mark conversation as read when opened
  const openConvo = useCallback((convo) => {
    setActive(convo)
    setSidebar(false)
    // Tell Layout which convo is open (so it suppresses popups for this convo)
    window.dispatchEvent(new CustomEvent('chatConvoChanged', { detail: { convoId: convo.id } }))
    // Record readAt for this user
    if (user?.uid) {
      updateDoc(doc(db, 'conversations', convo.id), {
        [`readBy.${user.uid}`]: serverTimestamp(),
      }).catch(() => {})
    }
  }, [user?.uid]) // eslint-disable-line

  // Handle popup click → jump to that conversation (must be after openConvo is defined)
  useEffect(() => {
    const handler = (e) => {
      const convo = convosRef.current.find(c => c.id === e.detail.convoId)
      if (convo) openConvo(convo)
      setTab('chats')
    }
    window.addEventListener('chatOpenConvo', handler)
    return () => window.removeEventListener('chatOpenConvo', handler)
  }, [openConvo])

  // Start DM from contacts tab
  const openDM = async (otherUser) => {
    const key  = dmKey(user.uid, otherUser.uid)
    const snap = await getDocs(query(collection(db, 'conversations'), where('dmKey', '==', key)))
    if (!snap.empty) { openConvo({ id: snap.docs[0].id, ...snap.docs[0].data() }); setTab('chats'); return }
    const ref = await addDoc(collection(db, 'conversations'), {
      type: 'dm', members: [user.uid, otherUser.uid], dmKey: key,
      name: null, lastMessage: '', lastAt: serverTimestamp(), createdAt: serverTimestamp(),
    })
    openConvo({ id: ref.id, type: 'dm', members: [user.uid, otherUser.uid] })
    setTab('chats')
  }

  // Total unread count for badge on icon nav
  const unreadCount = useMemo(() =>
    conversations.filter(c => {
      if (!c.lastAt || !c.lastMessage) return false
      const readAt = c.readBy?.[user?.uid]
      if (!readAt) return true
      return c.lastAt.toMillis?.() > readAt.toMillis?.()
    }).length
  , [conversations, user?.uid])

  const filteredConvos = useMemo(() => {
    if (!search) return conversations
    return conversations.filter(c => {
      const name = c.type === 'group' ? c.name
        : allUsers.find(u => u.uid === c.members.find(m => m !== user.uid))?.name ?? ''
      return name.toLowerCase().includes(search.toLowerCase())
        || c.lastMessage?.toLowerCase().includes(search.toLowerCase())
    })
  }, [conversations, search, allUsers, user?.uid])

  const filteredContacts = useMemo(() =>
    allUsers.filter(u => u.uid !== user?.uid && u.name.toLowerCase().includes(search.toLowerCase()))
  , [allUsers, search, user?.uid])

  return (
    <div className="flex h-[calc(100vh-56px)] -my-6 -mx-4 overflow-hidden bg-gray-50 dark:bg-zinc-950">

      {/* ── Far-left icon nav ──────────────────────────────────────────── */}
      <div className="hidden md:flex flex-col items-center w-14 shrink-0 border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 py-3 gap-1">
        {/* New chat */}
        <button onClick={() => setNew(true)} title="New chat"
          className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-2">
          <I.Compose />
        </button>
        {/* Tab buttons */}
        {[
          { key: 'chats',    icon: <I.Chat />,     label: 'Chats',    badge: unreadCount },
          { key: 'contacts', icon: <I.Contacts />, label: 'Contacts', badge: 0 },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} title={t.label}
            className={`relative w-9 h-9 rounded-xl flex items-center justify-center transition-colors
              ${tab === t.key
                ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/30'
                : 'text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t.icon}
            {t.badge > 0 && tab !== t.key && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
                {t.badge > 9 ? '9+' : t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── List panel ────────────────────────────────────────────────── */}
      <div className={`${showSidebar ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-64 lg:w-72 shrink-0
        border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900`}>

        {/* Panel header */}
        <div className="px-4 pt-4 pb-1 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              {tab === 'chats' ? 'Messages' : 'Contacts'}
            </h2>
            <button onClick={() => setNew(true)}
              className="md:hidden p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800">
              <I.Compose />
            </button>
          </div>
          <SearchBox value={search} onChange={setSearch} placeholder={tab === 'chats' ? 'Search messages…' : 'Search contacts…'} />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {tab === 'chats' && (
            <>
              {filteredConvos.length === 0 && (
                <div className="text-center py-16">
                  <p className="text-sm text-gray-300 dark:text-zinc-700 font-medium">No conversations yet</p>
                  <button onClick={() => setNew(true)} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    Start one →
                  </button>
                </div>
              )}
              {filteredConvos.map(c => (
                <ConvoItem key={c.id} convo={c} myUid={user.uid} allUsers={allUsers}
                  isActive={activeConvo?.id === c.id} onClick={() => openConvo(c)} />
              ))}
            </>
          )}
          {tab === 'contacts' && (
            <>
              {filteredContacts.length === 0 && (
                <p className="text-center text-sm text-gray-300 dark:text-zinc-700 py-16">No contacts</p>
              )}
              {filteredContacts.map(u => (
                <ContactItem key={u.uid} user={u} myUid={user.uid} onClick={() => openDM(u)} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── Chat area ─────────────────────────────────────────────────── */}
      <div className={`${!showSidebar || activeConvo ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 bg-gray-50 dark:bg-zinc-950`}>
        {activeConvo ? (
          <ConvoPanel
            key={activeConvo.id}
            convo={activeConvo}
            myUid={user.uid}
            allUsers={allUsers}
            onBack={() => { setActive(null); setSidebar(true) }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-300 dark:text-zinc-600">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
            </div>
            <p className="text-sm font-semibold text-gray-400 dark:text-zinc-500">Select a conversation</p>
            <button onClick={() => setNew(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
              or start a new one
            </button>
          </div>
        )}
      </div>

      {showNew && (
        <NewChatModal myUid={user.uid} allUsers={allUsers}
          onClose={() => setNew(false)}
          onOpen={c => { setActive(c); setSidebar(false); setNew(false) }} />
      )}
    </div>
  )
}
