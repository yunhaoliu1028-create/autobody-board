// ─── Chat ─────────────────────────────────────────────────────────────────────
// 1-on-1 DMs and group chats between shop employees.
// Firestore layout:
//   conversations/{id}          — type, members[], dmKey, name, lastMessage, lastAt
//   conversations/{id}/messages — senderId, senderName, text, createdAt

import { useState, useEffect, useRef, useMemo } from 'react'
import {
  collection, doc, onSnapshot, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp, getDocs, limit,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { format, isToday, isYesterday, parseISO } from 'date-fns'

// ── Icons ─────────────────────────────────────────────────────────────────────
function IconEdit()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> }
function IconSend()   { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/></svg> }
function IconClose()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg> }
function IconBack()   { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg> }
function IconUsers()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path strokeLinecap="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg> }
function IconCheck()  { return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg> }

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
function NewChatModal({ myUid, allUsers, onClose, onOpenConvo }) {
  const [search,     setSearch]     = useState('')
  const [selected,   setSelected]   = useState([]) // array of {uid, name}
  const [groupMode,  setGroupMode]  = useState(false)
  const [groupName,  setGroupName]  = useState('')
  const [creating,   setCreating]   = useState(false)

  const filtered = allUsers.filter(u =>
    u.uid !== myUid &&
    u.name.toLowerCase().includes(search.toLowerCase())
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
        const q   = query(collection(db, 'conversations'), where('dmKey', '==', key))
        const snap = await getDocs(q)
        if (!snap.empty) {
          onOpenConvo({ id: snap.docs[0].id, ...snap.docs[0].data() })
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
        const name    = groupName.trim() || selected.map(u => u.name.split(' ')[0]).join(', ')
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
                {u.name.split(' ')[0]}
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
                <Avatar uid={u.uid} name={u.name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{u.name}</p>
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
function MessageBubble({ msg, isOwn, showName }) {
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
          className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words
            ${isOwn
              ? 'bg-blue-600 text-white rounded-tr-sm'
              : 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-gray-100 rounded-tl-sm'}`}
        >
          {msg.text}
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
  const bottomRef = useRef(null)

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

  const send = async (e) => {
    e.preventDefault()
    if (!text.trim() || sending) return
    setSending(true)
    const msgText = text.trim()
    setText('')
    try {
      await addDoc(collection(db, 'conversations', convo.id, 'messages'), {
        senderId:   myUid,
        senderName: myName,
        text:       msgText,
        createdAt:  serverTimestamp(),
      })
      await updateDoc(doc(db, 'conversations', convo.id), {
        lastMessage:    msgText,
        lastAt:         serverTimestamp(),
        lastSenderId:   myUid,
        lastSenderName: myName,
        [`readBy.${myUid}`]: serverTimestamp(),
      })
    } finally {
      setSending(false)
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) }
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
      <form onSubmit={send} className="flex items-end gap-2 px-4 py-3 border-t border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Message…"
          rows={1}
          className="flex-1 border border-gray-300 dark:border-zinc-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none max-h-32 overflow-y-auto"
          style={{ height: 'auto' }}
          onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="p-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl transition-colors shrink-0"
        >
          <IconSend />
        </button>
      </form>
    </div>
  )
}

// ── Conversation list item ─────────────────────────────────────────────────────
function ConvoItem({ convo, myUid, allUsers, isActive, onClick }) {
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
            <span className="text-xs text-gray-400 dark:text-zinc-600 shrink-0">
              {fmtMsgTime(convo.lastAt)}
            </span>
          )}
        </div>
        {convo.lastMessage && (
          <p className="text-xs text-gray-400 dark:text-zinc-500 truncate mt-0.5">{convo.lastMessage}</p>
        )}
      </div>
    </button>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function Chat() {
  const { user } = useAuth()
  const [conversations, setConversations] = useState([])
  const [allUsers,      setAllUsers]      = useState([])  // { uid, name, role }
  const [activeConvo,   setActiveConvo]   = useState(null)
  const [showNewChat,   setShowNewChat]   = useState(false)
  const [showSidebar,   setShowSidebar]   = useState(true)  // mobile toggle

  // Load all employees
  useEffect(() => {
    return onSnapshot(collection(db, 'users'), snap => {
      setAllUsers(snap.docs.map(d => ({ uid: d.id, name: d.data().name, role: d.data().role })))
    })
  }, [])

  // Load my conversations, ordered by last message
  useEffect(() => {
    if (!user?.uid) return
    const q = query(
      collection(db, 'conversations'),
      where('members', 'array-contains', user.uid),
      orderBy('lastAt', 'desc'),
    )
    return onSnapshot(q, snap => {
      setConversations(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [user?.uid])

  // Update activeConvo when conversations list refreshes (keep live data)
  useEffect(() => {
    if (activeConvo) {
      const updated = conversations.find(c => c.id === activeConvo.id)
      if (updated) setActiveConvo(updated)
    }
  }, [conversations])

  const openConvo = async (convo) => {
    setActiveConvo(convo)
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

  return (
    <div className="flex h-[calc(100vh-56px)] -my-6 -mx-4 overflow-hidden">

      {/* ── Left sidebar: conversation list ─────────────────────────────── */}
      <div className={`
        ${showSidebar ? 'flex' : 'hidden'} md:flex
        flex-col w-full md:w-72 lg:w-80 shrink-0
        border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900
      `}>
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100 dark:border-zinc-800 shrink-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Messages</h2>
          <button
            onClick={() => setShowNewChat(true)}
            title="New conversation"
            className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <IconEdit />
          </button>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {conversations.length === 0 && (
            <div className="text-center py-16 text-gray-300 dark:text-zinc-700">
              <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
              <p className="text-sm font-medium">No conversations yet</p>
              <button
                onClick={() => setShowNewChat(true)}
                className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Start a new chat
              </button>
            </div>
          )}
          {conversations.map(convo => (
            <ConvoItem
              key={convo.id}
              convo={convo}
              myUid={user.uid}
              allUsers={allUsers}
              isActive={activeConvo?.id === convo.id}
              onClick={() => openConvo(convo)}
            />
          ))}
        </div>
      </div>

      {/* ── Right panel: messages or empty state ─────────────────────────── */}
      <div className={`
        ${!showSidebar || activeConvo ? 'flex' : 'hidden'} md:flex
        flex-1 flex-col bg-gray-50 dark:bg-zinc-950 min-w-0
      `}>
        {activeConvo ? (
          <ConversationPanel
            key={activeConvo.id}
            convo={activeConvo}
            myUid={user.uid}
            allUsers={allUsers}
            onBack={() => { setActiveConvo(null); setShowSidebar(true) }}
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
