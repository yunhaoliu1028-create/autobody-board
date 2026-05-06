// ─── Chat ─────────────────────────────────────────────────────────────────────
// 1-on-1 DMs and group chats between shop employees.
// Firestore layout:
//   conversations/{id}          — type, members[], dmKey, name, lastMessage, lastAt
//   conversations/{id}/messages — senderId, senderName, text, attachments[], createdAt

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import FloatingAssistant from '../components/FloatingAssistant'
import {
  collection, doc, onSnapshot, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp, getDocs,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db } from '../firebase/config'
import { storage } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useLocation } from 'react-router-dom'
import { format, isToday, isYesterday, parseISO } from 'date-fns'

// ── Icons ─────────────────────────────────────────────────────────────────────
function IconEdit()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> }
function IconSend()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/></svg> }
function IconClose()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg> }
function IconBack()   { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg> }
function IconUsers()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path strokeLinecap="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg> }
function IconCheck()  { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg> }
function IconMic()    { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="11" rx="3"/><path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/></svg> }
function IconImage()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path strokeLinecap="round" d="m21 15-5-5L5 21"/></svg> }
function IconFile()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6M8 13h8M8 17h5"/></svg> }
function IconPlay()   { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg> }
function IconPause()  { return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg> }

// ── Helpers ───────────────────────────────────────────────────────────────────
function dmKey(uid1, uid2) {
  return [uid1, uid2].sort().join('_')
}

function fmtMsgTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (isToday(d))     return format(d, 'HH:mm')
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'M/d')
}

function fmtFullTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return format(d, 'MM/dd HH:mm')
}

function getInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

// ── Avatar chip ───────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
]
function avatarColor(uid = '') {
  let n = 0
  for (let i = 0; i < uid.length; i++) n += uid.charCodeAt(i)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function Avatar({ uid, name, size = 'sm' }) {
  const sz = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm'
  return (
    <div className={`${sz} rounded-full ${avatarColor(uid)} text-white font-bold flex items-center justify-center shrink-0`}>
      {getInitials(name)}
    </div>
  )
}

// ── New Chat Modal ─────────────────────────────────────────────────────────────
function userDisplayName(user) {
  return user?.name || user?.email || user?.phone || 'Unnamed'
}

function isUnreadConvo(convo, myUid) {
  const lastAt = convo.lastAt?.toMillis?.() ?? 0
  const readAt = convo.readBy?.[myUid]?.toMillis?.() ?? 0
  return !!convo.lastSenderId && convo.lastSenderId !== myUid && lastAt > readAt
}

function convoDisplayName(convo, myUid, allUsers) {
  if (convo.type === 'group') return convo.name || 'Group'
  const other = convo.members?.find(uid => uid !== myUid)
  return allUsers.find(u => u.uid === other)?.name ?? 'Unknown'
}

function NewChatModal({ myUid, allUsers, onClose, onOpenConvo }) {
  const [search,     setSearch]     = useState('')
  const [selected,   setSelected]   = useState([]) // array of {uid, name}
  const [groupMode,  setGroupMode]  = useState(false)
  const [groupName,  setGroupName]  = useState('')
  const [creating,   setCreating]   = useState(false)

  const filtered = allUsers.filter(u =>
    u.uid !== myUid &&
    userDisplayName(u).toLowerCase().includes(search.toLowerCase())
  )

  const toggleUser = (u) => {
    setSelected(prev =>
      prev.find(s => s.uid === u.uid)
        ? prev.filter(s => s.uid !== u.uid)
        : [...prev, u]
    )
  }

  const handleStart = async () => {
    if (!selected.length) return
    setCreating(true)
    try {
      if (!groupMode && selected.length === 1) {
        // DM — find or create
        const key = dmKey(myUid, selected[0].uid)
        const q   = query(collection(db, 'conversations'), where('members', 'array-contains', myUid))
        const snap = await getDocs(q)
        const existing = snap.docs.find(d => d.data().dmKey === key)
        if (existing) {
          onOpenConvo({ id: existing.id, ...existing.data() })
          onClose()
          return
        }
        const ref = await addDoc(collection(db, 'conversations'), {
          type:        'dm',
          members:     [myUid, selected[0].uid],
          dmKey:       key,
          name:        null,
          lastMessage: '',
          lastAt:      serverTimestamp(),
          createdAt:   serverTimestamp(),
        })
        onOpenConvo({ id: ref.id, type: 'dm', members: [myUid, selected[0].uid], dmKey: key })
      } else {
        // Group
        const members = [myUid, ...selected.map(u => u.uid)]
        const name    = groupName.trim() || selected.map(u => userDisplayName(u).split(' ')[0]).join(', ')
        const ref = await addDoc(collection(db, 'conversations'), {
          type:        'group',
          members,
          dmKey:       null,
          name,
          lastMessage: '',
          lastAt:      serverTimestamp(),
          createdAt:   serverTimestamp(),
        })
        onOpenConvo({ id: ref.id, type: 'group', members, name })
      }
    } finally {
      setCreating(false)
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm border border-gray-200 dark:border-zinc-800 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100 dark:border-zinc-800">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">New Conversation</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <IconClose />
          </button>
        </div>

        {/* Group toggle */}
        <div className="flex gap-2 px-4 pt-3">
          <button
            onClick={() => { setGroupMode(false); setSelected(prev => prev.slice(0, 1)) }}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors
              ${!groupMode ? 'bg-blue-600 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
          >
            Direct Message
          </button>
          <button
            onClick={() => setGroupMode(true)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors
              ${groupMode ? 'bg-blue-600 text-white border-transparent' : 'border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400'}`}
          >
            Group Chat
          </button>
        </div>

        {/* Group name input */}
        {groupMode && (
          <div className="px-4 pt-3">
            <input
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
              placeholder="Group name (optional)"
              className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}

        {/* Search */}
        <div className="px-4 pt-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search people…"
            className="w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Selected chips */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-2">
            {selected.map(u => (
              <span
                key={u.uid}
                onClick={() => toggleUser(u)}
                className="flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-900"
              >
                {userDisplayName(u).split(' ')[0]}
                <IconClose />
              </span>
            ))}
          </div>
        )}

        {/* User list */}
        <div className="max-h-52 overflow-y-auto px-4 py-2 space-y-0.5">
          {filtered.map(u => {
            const sel = !!selected.find(s => s.uid === u.uid)
            return (
              <button
                key={u.uid}
                onClick={() => {
                  if (!groupMode) setSelected([u])
                  else toggleUser(u)
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors
                  ${sel ? 'bg-blue-50 dark:bg-blue-950/50' : 'hover:bg-gray-50 dark:hover:bg-zinc-800'}`}
              >
                <Avatar uid={u.uid} name={userDisplayName(u)} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{userDisplayName(u)}</p>
                  <p className="text-xs text-gray-400 dark:text-zinc-500 truncate">{u.role}</p>
                </div>
                {sel && <span className="text-blue-600 dark:text-blue-400 shrink-0"><IconCheck /></span>}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-zinc-600 italic text-center py-4">No users found</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-100 dark:border-zinc-800">
          <button
            onClick={handleStart}
            disabled={!selected.length || creating}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
          >
            {creating ? 'Starting…' : groupMode ? `Create Group (${selected.length} people)` : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Message bubble ─────────────────────────────────────────────────────────────
function VoiceAttachment({ src, isOwn }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState('')

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) audio.play()
    else audio.pause()
  }

  const setAudioDuration = () => {
    const seconds = audioRef.current?.duration
    if (!Number.isFinite(seconds)) return
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60).toString().padStart(2, '0')
    setDuration(`${mins}:${secs}`)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`flex min-w-44 items-center gap-3 rounded-full px-3 py-2 shadow-sm transition-colors ${
        isOwn
          ? 'bg-green-500 text-white hover:bg-green-600'
          : 'bg-white text-gray-800 hover:bg-gray-50 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700'
      }`}
      title="Voice message"
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={setAudioDuration}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
        isOwn ? 'bg-white/20' : 'bg-green-500 text-white'
      }`}>
        {playing ? <IconPause /> : <IconPlay />}
      </span>
      <span className={`h-1 flex-1 rounded-full ${isOwn ? 'bg-white/35' : 'bg-green-200 dark:bg-green-900'}`}>
        <span className={`block h-full w-1/2 rounded-full ${isOwn ? 'bg-white' : 'bg-green-500'}`} />
      </span>
      <span className={`text-xs font-medium ${isOwn ? 'text-white/90' : 'text-gray-500 dark:text-zinc-400'}`}>
        {duration || '0:00'}
      </span>
    </button>
  )
}

function MessageBubble({ msg, isOwn, showName }) {
  const attachments = msg.attachments || []
  const audioOnly = !msg.text && attachments.length > 0 && attachments.every(att => att.type === 'audio')
  return (
    <div className={`flex gap-2 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && (
        <Avatar uid={msg.senderId} name={msg.senderName} size="sm" />
      )}
      <div className={`max-w-[72%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
        {showName && !isOwn && (
          <p className="text-xs text-gray-400 dark:text-zinc-500 px-1">{msg.senderName}</p>
        )}
        <div
          className={audioOnly
            ? 'text-sm leading-relaxed'
            : `px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words
              ${isOwn
                ? 'bg-green-500 text-white rounded-tr-sm'
                : 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-gray-100 rounded-tl-sm'}`
          }
        >
          {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
          {attachments.length > 0 && (
            <div className={`space-y-2 ${msg.text ? 'mt-2' : ''}`}>
              {attachments.map((att, idx) => (
                att.type === 'image' ? (
                  <a key={idx} href={att.url} target="_blank" rel="noreferrer" className="block">
                    <img src={att.url} alt={att.name || 'image'} className="max-w-56 rounded-xl border border-black/5 object-cover" />
                  </a>
                ) : att.type === 'audio' ? (
                  <VoiceAttachment key={idx} src={att.url} isOwn={isOwn} />
                ) : (
                  <a
                    key={idx}
                    href={att.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex items-center gap-2 rounded-xl px-3 py-2 border ${
                      isOwn ? 'border-white/30 bg-white/10 text-white' : 'border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-gray-700 dark:text-zinc-200'
                    }`}
                  >
                    <IconFile />
                    <span className="truncate max-w-44 text-xs font-medium">{att.name || 'File'}</span>
                  </a>
                )
              ))}
            </div>
          )}
        </div>
        <p className={`text-xs text-gray-300 dark:text-zinc-600 px-1 ${isOwn ? 'text-right' : 'text-left'}`}>
          {fmtFullTime(msg.createdAt)}
        </p>
      </div>
    </div>
  )
}

// ── Conversation panel (right side) ───────────────────────────────────────────
function ConversationPanel({ convo, myUid, allUsers, onBack }) {
  const [messages, setMessages] = useState([])
  const [text,     setText]     = useState('')
  const [sending,  setSending]  = useState(false)
  const [recording, setRecording] = useState(false)
  const bottomRef = useRef(null)
  const imageRef = useRef(null)
  const fileRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])

  const myName = allUsers.find(u => u.uid === myUid)?.name ?? 'Me'

  // Conversation display name
  const convoName = useMemo(() => {
    if (convo.type === 'group') return convo.name || 'Group'
    const other = convo.members.find(uid => uid !== myUid)
    return allUsers.find(u => u.uid === other)?.name ?? 'Unknown'
  }, [convo, myUid, allUsers])

  const convoSubtitle = useMemo(() => {
    if (convo.type === 'group') {
      const names = (convo.members || [])
        .map(uid => uid === myUid ? 'You' : allUsers.find(u => u.uid === uid)?.name ?? '?')
      return names.join(', ')
    }
    return 'Direct Message'
  }, [convo, myUid, allUsers])

  // Real-time messages
  useEffect(() => {
    const q = query(
      collection(db, 'conversations', convo.id, 'messages'),
      orderBy('createdAt', 'asc'),
    )
    return onSnapshot(q, snap => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [convo.id])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const uploadAttachment = async (file, typeOverride = null) => {
    const type = typeOverride || (file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'file')
    const safeName = file.name?.replace(/[^\w.\-]+/g, '_') || `${type}_${Date.now()}`
    const path = `chat/${convo.id}/${Date.now()}_${safeName}`
    const ref = storageRef(storage, path)
    await uploadBytes(ref, file, { contentType: file.type || 'application/octet-stream' })
    const url = await getDownloadURL(ref)
    return { type, name: file.name || safeName, url, contentType: file.type || '', size: file.size || 0 }
  }

  const sendMessage = async ({ textValue = text, attachments = [] } = {}) => {
    if ((!textValue.trim() && attachments.length === 0) || sending) return
    setSending(true)
    const msgText = textValue.trim()
    setText('')
    try {
      await addDoc(collection(db, 'conversations', convo.id, 'messages'), {
        senderId:   myUid,
        senderName: myName,
        text:       msgText,
        attachments,
        createdAt:  serverTimestamp(),
      })
      await updateDoc(doc(db, 'conversations', convo.id), {
        lastMessage:    msgText || (attachments[0]?.type === 'image' ? '[Image]' : attachments[0]?.type === 'audio' ? '[Voice]' : '[File]'),
        lastAt:         serverTimestamp(),
        lastSenderId:   myUid,
        lastSenderName: myName,
      }).catch(err => {
        console.error('[Chat] Failed to update conversation summary:', err)
      })
      await updateDoc(doc(db, 'conversations', convo.id), {
        [`readBy.${myUid}`]: serverTimestamp(),
      }).catch(() => {})
    } finally {
      setSending(false)
    }
  }

  const send = async (e) => {
    e.preventDefault()
    await sendMessage()
  }

  const handleFiles = async (files, typeOverride = null) => {
    const list = Array.from(files || [])
    if (!list.length || sending) return
    try {
      const attachments = []
      for (const file of list) attachments.push(await uploadAttachment(file, typeOverride))
      await sendMessage({ textValue: text, attachments })
    } finally {
      if (imageRef.current) imageRef.current.value = ''
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const toggleRecording = async () => {
    if (recording) {
      const mr = mediaRecorderRef.current
      if (!mr) return
      setRecording(false)
      const blob = await new Promise(resolve => {
        mr.onstop = () => resolve(new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' }))
        mr.stop()
        mr.stream.getTracks().forEach(t => t.stop())
      })
      const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type || 'audio/webm' })
      await handleFiles([file], 'audio')
      return
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const mr = new MediaRecorder(stream, { mimeType })
    audioChunksRef.current = []
    mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.start(250)
    mediaRecorderRef.current = mr
    setRecording(true)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <button
          onClick={onBack}
          className="md:hidden p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800"
        >
          <IconBack />
        </button>
        {convo.type === 'group' ? (
          <div className="w-8 h-8 rounded-full bg-purple-500 text-white flex items-center justify-center shrink-0">
            <IconUsers />
          </div>
        ) : (
          <Avatar uid={convo.members.find(u => u !== myUid)} name={convoName} size="sm" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{convoName}</p>
          <p className="text-xs text-gray-400 dark:text-zinc-500 truncate">{convoSubtitle}</p>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 dark:text-zinc-700 gap-2">
            <svg className="w-10 h-10 opacity-40" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
            </svg>
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-xs opacity-60">Start the conversation below</p>
          </div>
        )}
        {messages.map((msg, idx) => {
          const isOwn   = msg.senderId === myUid
          const prev    = messages[idx - 1]
          const showName = convo.type === 'group' && !isOwn && msg.senderId !== prev?.senderId
          return (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isOwn={isOwn}
              showName={showName}
            />
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={send}
        className="sticky bottom-0 shrink-0 border-t border-gray-200 bg-[#f6f6f6] px-2.5 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] dark:border-zinc-800 dark:bg-[#1c1c1e]"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleRecording}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
              recording
                ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950/40'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
            title={recording ? 'Stop recording' : 'Voice'}
          >
            <IconMic />
          </button>

          <div className="flex min-h-10 flex-1 items-center rounded-lg border border-gray-200 bg-white px-3 dark:border-zinc-700 dark:bg-zinc-800">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              enterKeyHint="newline"
              placeholder={recording ? 'Recording...' : 'Message...'}
              rows={1}
              className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-6 text-gray-900 placeholder-gray-400 focus:outline-none dark:text-gray-100 dark:placeholder-zinc-500"
            />
            <span className="ml-2 text-gray-400 dark:text-zinc-500">
              <IconMic />
            </span>
          </div>

          <button
            type="button"
            onClick={() => imageRef.current?.click()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="Image"
          >
            <IconImage />
          </button>
          <button
            type={text.trim() ? 'submit' : 'button'}
            onClick={() => { if (!text.trim()) fileRef.current?.click() }}
            disabled={sending}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
              text.trim()
                ? 'border-green-500 bg-green-600 text-white hover:bg-green-700 disabled:opacity-40'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
            title={text.trim() ? 'Send' : 'File'}
          >
            {text.trim() ? <IconSend /> : <IconFile />}
          </button>
        </div>
        <input ref={imageRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handleFiles(e.target.files, 'image')} />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />
      </form>
    </div>
  )
}

// ── Conversation list item ─────────────────────────────────────────────────────
function ConvoItem({ convo, myUid, allUsers, isActive, unread, onClick }) {
  const name = useMemo(() => {
    if (convo.type === 'group') return convo.name || 'Group'
    const other = convo.members.find(uid => uid !== myUid)
    return allUsers.find(u => u.uid === other)?.name ?? 'Unknown'
  }, [convo, myUid, allUsers])

  const otherId = convo.type === 'dm' ? convo.members.find(u => u !== myUid) : null

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left
        ${isActive
          ? 'bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900'
          : unread
          ? 'bg-green-50 dark:bg-green-950/25 hover:bg-green-100 dark:hover:bg-green-950/35'
          : 'hover:bg-gray-50 dark:hover:bg-zinc-800'}`}
    >
      {convo.type === 'group' ? (
        <div className="w-9 h-9 rounded-full bg-purple-500 text-white flex items-center justify-center shrink-0 text-xs font-bold">
          <IconUsers />
        </div>
      ) : (
        <Avatar uid={otherId} name={name} size="sm" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-1">
          <p className={`text-sm font-semibold truncate ${isActive ? 'text-blue-700 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>
            {name}
          </p>
          {convo.lastAt && (
            <span className={`text-xs shrink-0 ${unread ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-400 dark:text-zinc-600'}`}>
              {fmtMsgTime(convo.lastAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {convo.lastMessage && (
            <p className={`text-xs truncate ${unread ? 'text-gray-700 dark:text-zinc-200 font-medium' : 'text-gray-400 dark:text-zinc-500'}`}>{convo.lastMessage}</p>
          )}
          {unread && (
            <span className="ml-auto shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
              1
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function Chat() {
  const { user } = useAuth()
  const location = useLocation()
  const panelHistoryRef = useRef(false)
  const [conversations, setConversations] = useState([])
  const [allUsers,      setAllUsers]      = useState([])  // { uid, name, role }
  const [activeConvo,   setActiveConvo]   = useState(null)
  const [showNewChat,   setShowNewChat]   = useState(false)
  const [showSidebar,   setShowSidebar]   = useState(true)  // mobile toggle
  const [showAI,        setShowAI]        = useState(false) // inline AI panel
  const [sidebarTab,    setSidebarTab]    = useState('chats')
  const [contactSearch, setContactSearch] = useState('')
  const unreadTotal = conversations.filter(c => isUnreadConvo(c, user.uid)).length
  const latestUnread = conversations.find(c => isUnreadConvo(c, user.uid))

  // Load all employees
  useEffect(() => {
    return onSnapshot(collection(db, 'users'), snap => {
      setAllUsers(snap.docs.map(d => {
        const data = d.data()
        return { uid: d.id, name: data.name, email: data.email, phone: data.phone, role: data.role }
      }))
    })
  }, [])

  // Load my conversations, ordered by last message
  useEffect(() => {
    if (!user?.uid) return
    const q = query(
      collection(db, 'conversations'),
      where('members', 'array-contains', user.uid),
    )
    return onSnapshot(q, snap => {
      const rows = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.lastAt?.toMillis?.() ?? 0) - (a.lastAt?.toMillis?.() ?? 0))
      setConversations(rows)
    })
  }, [user?.uid])

  // Update activeConvo when conversations list refreshes (keep live data)
  useEffect(() => {
    if (activeConvo) {
      const updated = conversations.find(c => c.id === activeConvo.id)
      if (updated) setActiveConvo(updated)
    }
  }, [conversations])

  useEffect(() => {
    const targetId = location.state?.convoId
    if (!targetId || activeConvo?.id === targetId) return
    const convo = conversations.find(c => c.id === targetId)
    if (convo) openConvo(convo)
  }, [location.state, conversations])

  const closePanel = useCallback(() => {
    setActiveConvo(null)
    setShowAI(false)
    setShowSidebar(true)
    window.dispatchEvent(new CustomEvent('chatConvoChanged', { detail: { convoId: null, panelOpen: false } }))
  }, [])

  useEffect(() => {
    const onPopState = () => {
      if (activeConvo || showAI) {
        panelHistoryRef.current = false
        closePanel()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [activeConvo, showAI, closePanel])

  const pushPanelHistory = () => {
    if (window.innerWidth >= 768 || panelHistoryRef.current) return
    window.history.pushState({ chatPanel: true }, '', window.location.href)
    panelHistoryRef.current = true
  }

  const backToChatList = () => {
    if (panelHistoryRef.current) {
      window.history.back()
      return
    }
    closePanel()
  }

  const openConvo = async (convo) => {
    pushPanelHistory()
    setActiveConvo(convo)
    setShowAI(false)
    setShowSidebar(false)
    // Tell Layout which convo is open (suppress popup for this convo)
    window.dispatchEvent(new CustomEvent('chatConvoChanged', { detail: { convoId: convo.id } }))
    // Mark as read
    try {
      await updateDoc(doc(db, 'conversations', convo.id), {
        [`readBy.${user.uid}`]: serverTimestamp(),
      })
    } catch (_) {}
  }

  const openDirectMessage = async (person) => {
    const key = dmKey(user.uid, person.uid)
    const existing = conversations.find(c => c.dmKey === key)
    if (existing) {
      await openConvo(existing)
      return
    }
    const q = query(collection(db, 'conversations'), where('members', 'array-contains', user.uid))
    const snap = await getDocs(q)
    const found = snap.docs.find(d => d.data().dmKey === key)
    if (found) {
      await openConvo({ id: found.id, ...found.data() })
      return
    }
    const ref = await addDoc(collection(db, 'conversations'), {
      type:        'dm',
      members:     [user.uid, person.uid],
      dmKey:       key,
      name:        null,
      lastMessage: '',
      lastAt:      serverTimestamp(),
      createdAt:   serverTimestamp(),
    })
    await openConvo({ id: ref.id, type: 'dm', members: [user.uid, person.uid], dmKey: key })
  }

  const filteredContacts = allUsers.filter(u =>
    u.uid !== user.uid &&
    (!contactSearch.trim() || userDisplayName(u).toLowerCase().includes(contactSearch.toLowerCase()))
  )

  const messageConversations = conversations.filter(c => c.lastSenderId || c.lastMessage)

  const openAssistantPanel = () => {
    pushPanelHistory()
    setShowAI(true)
    setActiveConvo(null)
    setShowSidebar(false)
    window.dispatchEvent(new CustomEvent('chatConvoChanged', { detail: { convoId: null, panelOpen: true } }))
  }

  return (
    <div className={`flex md:h-[calc(100vh-56px)] md:-my-6 -mx-4 overflow-hidden ${
      activeConvo || showAI ? 'h-[calc(100dvh-3.5rem)] -my-4' : 'h-[calc(100dvh-8rem)] -my-4'
    }`}>

      {/* ── Left sidebar: conversation list ─────────────────────────────── */}
      <div className={`
        ${showSidebar ? 'flex' : 'hidden'} md:flex
        flex-col w-full md:w-72 lg:w-80 shrink-0
        border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900
      `}>
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100 dark:border-zinc-800 shrink-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Chat</h2>
          <button
            onClick={() => setShowNewChat(true)}
            title="New conversation"
            className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <IconEdit />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1 p-2 border-b border-gray-100 dark:border-zinc-800">
          {[
            ['chats', 'Messages'],
            ['contacts', 'Contacts'],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSidebarTab(key)}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                sidebarTab === key
                  ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                  : 'text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
              }`}
            >
              {label}
              {key === 'chats' && unreadTotal > 0 && (
                <span className="ml-1 inline-flex min-w-[17px] h-[17px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white align-middle">
                  {unreadTotal > 9 ? '9+' : unreadTotal}
                </span>
              )}
            </button>
          ))}
        </div>

        {sidebarTab === 'chats' && latestUnread && (
          <button
            onClick={() => openConvo(latestUnread)}
            className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-left shadow-sm hover:bg-green-100 dark:border-green-900 dark:bg-green-950/30 dark:hover:bg-green-950/45"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.12)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold text-gray-900 dark:text-gray-100">
                {convoDisplayName(latestUnread, user.uid, allUsers)}
              </span>
              <span className="block truncate text-xs text-gray-500 dark:text-zinc-400">
                {latestUnread.lastMessage || 'New message'}
              </span>
            </span>
            <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {unreadTotal > 9 ? '9+' : unreadTotal}
            </span>
          </button>
        )}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sidebarTab === 'chats' && (
            <div className="space-y-1">
              {/* ── Pinned: Shop Assistant AI ─────────────────────────── */}
              <button
                onClick={openAssistantPanel}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left
                  ${showAI
                    ? 'bg-zinc-900 dark:bg-zinc-100'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
              >
                <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0
                  ${showAI ? 'bg-zinc-100 dark:bg-zinc-900' : 'bg-zinc-900 dark:bg-zinc-100'}`}>
                  <svg className={`w-4 h-4 ${showAI ? 'text-zinc-900 dark:text-zinc-100' : 'text-white dark:text-zinc-900'}`} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C12 2 13.2 8.4 16.2 11.8C19.2 15.2 22 12 22 12C22 12 18.8 8.8 16.2 12.2C13.6 15.6 12 22 12 22C12 22 10.4 15.6 7.8 12.2C5.2 8.8 2 12 2 12C2 12 4.8 15.2 7.8 11.8C10.8 8.4 12 2 12 2Z"/>
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${showAI ? 'text-white dark:text-zinc-900' : 'text-gray-900 dark:text-gray-100'}`}>
                      Shop Assistant
                    </span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-300">AI</span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${showAI ? 'text-gray-300 dark:text-zinc-600' : 'text-gray-400 dark:text-zinc-500'}`}>
                    Ask anything about the shop…
                  </p>
                </div>
              </button>

              {messageConversations.map(convo => (
                <ConvoItem
                  key={convo.id}
                  convo={convo}
                  myUid={user.uid}
                  allUsers={allUsers}
                  isActive={activeConvo?.id === convo.id}
                  unread={isUnreadConvo(convo, user.uid)}
                  onClick={() => openConvo(convo)}
                />
              ))}
              {messageConversations.length === 0 && (
                <div className="text-center py-16 text-gray-300 dark:text-zinc-700">
                  <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                    <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                  </svg>
                  <p className="text-sm font-medium">No messages yet</p>
                  <p className="mt-1 text-xs opacity-70">Start from Contacts</p>
                </div>
              )}
            </div>
          )}
          {sidebarTab === 'contacts' && (
            <div className="space-y-1">
              <input
                value={contactSearch}
                onChange={e => setContactSearch(e.target.value)}
                placeholder="Search contacts"
                className="w-full mb-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900/20"
              />
              {filteredContacts.map(person => (
                <button
                  key={person.uid}
                  onClick={() => openDirectMessage(person)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  <Avatar uid={person.uid} name={userDisplayName(person)} size="sm" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{userDisplayName(person)}</span>
                    <span className="block text-xs text-gray-400 dark:text-zinc-500 truncate">{person.role}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel: AI / messages / empty state ─────────────────────── */}
      <div className={`
        ${!showSidebar || activeConvo || showAI ? 'flex' : 'hidden'} md:flex
        flex-1 flex-col bg-gray-50 dark:bg-zinc-950 min-w-0 overflow-hidden
      `}>
        {showAI ? (
          <FloatingAssistant
            inline
            onBack={backToChatList}
          />
        ) : activeConvo ? (
          <ConversationPanel
            key={activeConvo.id}
            convo={activeConvo}
            myUid={user.uid}
            allUsers={allUsers}
            onBack={backToChatList}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 dark:text-zinc-700 gap-3">
            <svg className="w-14 h-14 opacity-30" fill="none" stroke="currentColor" strokeWidth={0.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
            </svg>
            <p className="text-base font-semibold opacity-60">Select a conversation</p>
            <button
              onClick={() => setShowNewChat(true)}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline opacity-80"
            >
              or start a new one
            </button>
          </div>
        )}
      </div>

      {/* New chat modal */}
      {showNewChat && (
        <NewChatModal
          myUid={user.uid}
          allUsers={allUsers}
          onClose={() => setShowNewChat(false)}
          onOpenConvo={(convo) => { setActiveConvo(convo); setShowSidebar(false) }}
        />
      )}
    </div>
  )
}
