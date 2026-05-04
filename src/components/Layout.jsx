import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { ROLE_LABELS, MANAGER_ROLES } from '../constants/roles'
import FloatingAssistant from './FloatingAssistant'

// ── SVG Icons ─────────────────────────────────────────────────────────────────
function IconBoard()    { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/><rect x="14" y="17" width="7" height="4" rx="1.5"/></svg> }
function IconTasks()    { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg> }
function IconMeeting()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg> }
function IconSettings() { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg> }
function IconTeam()     { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg> }
function IconSun()      { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg> }
function IconMoon()     { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg> }
function IconMenu()     { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg> }
function IconClose()    { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg> }
function IconSignOut()  { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg> }
function IconCar()      { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16 6l-1.5-3h-5L8 6M3 10l1-4h16l1 4M5 10v7a1 1 0 001 1h1a1 1 0 001-1v-1h8v1a1 1 0 001 1h1a1 1 0 001-1v-7"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="16.5" cy="11.5" r="1"/></svg> }
function IconChat()     { return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg> }

export { IconBoard, IconTasks, IconMeeting, IconSettings, IconTeam, IconSun, IconMoon, IconCar, IconChat }

// ── Incoming message popup ─────────────────────────────────────────────────────
const POPUP_COLORS = [
  'bg-blue-500','bg-purple-500','bg-green-500','bg-amber-500',
  'bg-rose-500','bg-cyan-500','bg-indigo-500','bg-teal-500',
]
function popupColor(uid = '') {
  let n = 0; for (let i = 0; i < uid.length; i++) n += uid.charCodeAt(i)
  return POPUP_COLORS[n % POPUP_COLORS.length]
}
function popupInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function IncomingMessagePopup({ notification, onClose, onClickPopup }) {
  const [visible,  setVisible]  = useState(false)
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    // Slide in after a tick
    const t = setTimeout(() => setVisible(true), 15)
    // Progress bar countdown
    const duration = 9000
    const start    = Date.now()
    let raf
    const tick = () => {
      const pct = Math.max(0, 100 - ((Date.now() - start) / duration) * 100)
      setProgress(pct)
      if (pct > 0) raf = requestAnimationFrame(tick)
      else onClose()
    }
    raf = requestAnimationFrame(tick)
    return () => { clearTimeout(t); cancelAnimationFrame(raf) }
  }, [])

  return (
    <div
      style={{
        transform:  visible ? 'translateX(0)' : 'translateX(-115%)',
        opacity:    visible ? 1 : 0,
        transition: 'transform 0.38s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease',
      }}
      className="w-72 bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden cursor-pointer"
      onClick={onClickPopup}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        {/* Avatar */}
        <div className={`w-9 h-9 rounded-full ${popupColor(notification.senderId)} text-white font-bold flex items-center justify-center shrink-0 text-xs`}>
          {popupInitials(notification.senderName)}
        </div>
        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium uppercase tracking-wide leading-none mb-1">New Message</p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">{notification.senderName}</p>
          <p className="text-xs text-gray-500 dark:text-zinc-400 truncate mt-0.5">{notification.text}</p>
        </div>
        {/* Dismiss */}
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          className="shrink-0 mt-0.5 text-gray-300 dark:text-zinc-600 hover:text-gray-600 dark:hover:text-zinc-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      {/* Progress bar */}
      <div className="h-[3px] bg-gray-100 dark:bg-zinc-800">
        <div
          className="h-full bg-blue-500 rounded-full"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}

// ── Nav items ──────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { path: '/',         label: 'RO Board', icon: <IconBoard />,    roles: null },
  { path: '/tasks',    label: 'Tasks',    icon: <IconTasks />,    roles: null },
  { path: '/chat',     label: 'Chat',     icon: <IconChat />,     roles: null },
  { path: '/meeting',  label: 'Meeting',  icon: <IconMeeting />,  roles: MANAGER_ROLES },
  { path: '/settings', label: 'Settings', icon: <IconSettings />, roles: null },
  { path: '/admin',    label: 'Team',     icon: <IconTeam />,     roles: MANAGER_ROLES },
]

export default function Layout({ children }) {
  const { displayName, role, logout, user } = useAuth()
  const { dark, toggle }                    = useTheme()
  const location  = useLocation()
  const navigate  = useNavigate()

  const [menuOpen,       setMenuOpen]       = useState(false)
  const [notifications,  setNotifications]  = useState([])
  const [chatUnread,     setChatUnread]      = useState(0)

  const prevConvosRef        = useRef({})   // convoId -> lastAt millis
  const initializedRef       = useRef(false)
  const activeChatConvoIdRef = useRef(null)

  // Track which convo is open in Chat page
  useEffect(() => {
    const handler = (e) => { activeChatConvoIdRef.current = e.detail?.convoId ?? null }
    window.addEventListener('chatConvoChanged', handler)
    return () => window.removeEventListener('chatConvoChanged', handler)
  }, [])

  // Clear active convo when leaving /chat
  useEffect(() => {
    if (location.pathname !== '/chat') activeChatConvoIdRef.current = null
  }, [location.pathname])

  // Global subscription: conversations → unread count + popup notifications
  useEffect(() => {
    if (!user?.uid) return
    const q = query(
      collection(db, 'conversations'),
      where('members', 'array-contains', user.uid),
      orderBy('lastAt', 'desc'),
    )
    return onSnapshot(q, snap => {
      const newPrev = {}
      let unread = 0

      snap.docs.forEach(d => {
        const data    = d.data()
        const convoId = d.id
        const lastAt  = data.lastAt?.toMillis?.() ?? 0
        const readAt  = data.readBy?.[user.uid]?.toMillis?.() ?? 0
        const prevAt  = prevConvosRef.current[convoId] ?? 0

        // Count unread conversations (last message not from me, not read yet)
        if (data.lastSenderId && data.lastSenderId !== user.uid && lastAt > readAt) {
          unread++
        }

        // Show popup for new messages (only after initial load)
        if (
          initializedRef.current &&
          lastAt > prevAt &&
          data.lastSenderId &&
          data.lastSenderId !== user.uid &&
          activeChatConvoIdRef.current !== convoId
        ) {
          const notifId = `${convoId}-${lastAt}`
          setNotifications(ns => {
            if (ns.find(n => n.id === notifId)) return ns
            return [
              ...ns.slice(-2),   // keep at most 3
              {
                id:         notifId,
                senderId:   data.lastSenderId,
                senderName: data.lastSenderName ?? 'Someone',
                text:       data.lastMessage   ?? '',
                convoId,
              },
            ]
          })
        }

        newPrev[convoId] = lastAt
      })

      prevConvosRef.current = newPrev
      initializedRef.current = true
      setChatUnread(unread)
    })
  }, [user?.uid])

  const dismissNotif = (id) => setNotifications(ns => ns.filter(n => n.id !== id))
  const clickNotif   = (notif) => { dismissNotif(notif.id); navigate('/chat', { state: { convoId: notif.convoId } }) }

  const handleLogout = async () => { await logout(); navigate('/login') }
  const visibleNav   = NAV_ITEMS.filter(item => !item.roles || item.roles.includes(role))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 flex flex-col font-sans">

      {/* ── Top nav ───────────────────────────────────────────────────────── */}
      <header className="bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 sticky top-0 z-40">
        <div className="max-w-[1440px] mx-auto px-4 h-14 flex items-center justify-between gap-4">

          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 bg-zinc-900 dark:bg-white rounded-lg flex items-center justify-center">
              <IconCar />
            </div>
            <span className="hidden sm:block font-bold text-sm tracking-tight text-gray-900 dark:text-gray-100">
              CS SCA Collision
            </span>
            <span className="sm:hidden font-bold text-sm tracking-tight text-gray-900 dark:text-gray-100">
              AutoBody
            </span>
          </div>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5 flex-1 justify-center">
            {visibleNav.map(item => {
              const active = location.pathname === item.path
              const badge  = item.path === '/chat' && chatUnread > 0 ? chatUnread : 0
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                    ${active
                      ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-gray-100'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800/50 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                >
                  <span className="relative">
                    {item.icon}
                    {badge > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-3.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </span>
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Right side: dark toggle + user + sign out */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={toggle}
              className="p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {dark ? <IconSun /> : <IconMoon />}
            </button>

            <div className="hidden md:block text-right">
              <p className="text-xs font-semibold text-gray-800 dark:text-gray-200 leading-none">{displayName}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{ROLE_LABELS[role] ?? role}</p>
            </div>

            <button
              onClick={handleLogout}
              className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <IconSignOut />
              Sign Out
            </button>

            <button
              className="md:hidden p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
              onClick={() => setMenuOpen(v => !v)}
            >
              {menuOpen ? <IconClose /> : <IconMenu />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="md:hidden border-t border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex flex-col gap-1">
            {visibleNav.map(item => {
              const badge = item.path === '/chat' && chatUnread > 0 ? chatUnread : 0
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMenuOpen(false)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors
                    ${location.pathname === item.path
                      ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-gray-100'
                      : 'text-gray-600 dark:text-gray-400'}`}
                >
                  <span className="relative">
                    {item.icon}
                    {badge > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-3.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </span>
                  {item.label}
                </Link>
              )
            })}
            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{displayName}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{ROLE_LABELS[role]}</p>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-red-500 transition-colors"
              >
                <IconSignOut /> Sign Out
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ── Page content ──────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-[1440px] mx-auto w-full px-4 py-6">
        {children}
      </main>

      {/* ── Floating AI Assistant ─────────────────────────────────────────── */}
      <FloatingAssistant />

      {/* ── Incoming message popups (bottom-left stack) ───────────────────── */}
      <div className="fixed bottom-6 left-6 z-[100] flex flex-col-reverse gap-3 pointer-events-none">
        {notifications.map(notif => (
          <div key={notif.id} className="pointer-events-auto">
            <IncomingMessagePopup
              notification={notif}
              onClose={() => dismissNotif(notif.id)}
              onClickPopup={() => clickNotif(notif)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
