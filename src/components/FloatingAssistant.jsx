import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { collection, getDocs, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from './Toast'
import { askShopAssistant, transcribeWithWhisper, loadAssistantMemory, appendAssistantMemory, deleteAssistantMemory } from '../hooks/useAI'
import MentionTextarea, { buildMentionCandidates } from './MentionTextarea'
import { format, differenceInCalendarDays, parseISO, isValid } from 'date-fns'

// ── Priority based on due date ────────────────────────────────────────────────
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

function findEmployeeByName(employees, rawName = '', preferredRole = null) {
  const target = normalizeName(rawName)
  if (!target) return null
  const targetParts = target.split(' ').filter(Boolean)
  const matches = employees.filter(emp => {
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
  })
  if (preferredRole) {
    const roleMatch = matches.find(emp => emp.role === preferredRole)
    if (roleMatch) return roleMatch
  }
  return matches[0] ?? null
}

function isBodyTaskAction(action) {
  const text = `${action.title ?? ''} ${action.description ?? ''} ${action.assigneeName ?? ''}`
  return /\b(body\s*(man|tech|work)|teardown|repair|process repair|assigned body)\b/i.test(text)
}

function normalizedTaskTitle(action, isBodyTask) {
  return isBodyTask ? 'Teardown & process repair' : (action.title || 'Task')
}

function normalizedTaskDescription(action, isBodyTask) {
  return isBodyTask ? '' : (action.description ?? '')
}

// ── Quick prompt chips ────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  { label: '🌅 Morning Briefing', text: 'Give me a morning briefing: which vehicles need attention today, any issues, and which are expected for delivery?' },
  { label: '🚗 Today\'s Deliveries', text: 'List vehicles expected for delivery today and tomorrow. Are there any outstanding tasks or missing parts?' },
  { label: '⚠️ Needs Follow-up',   text: 'List the vehicles that need the most attention right now — overdue, missing parts, or other issues — sorted by priority.' },
  { label: '📱 SMS Summary',        text: 'Generate a brief SMS summary of all vehicles in the shop today for the owner, under 280 characters.' },
]

// ── Simple markdown renderer (bold, bullet lists) ─────────────────────────────
function MiniMarkdown({ text }) {
  if (!text) return null
  return (
    <div className="space-y-1 leading-relaxed">
      {text.split('\n').map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />
        // bullet
        const isBullet = /^[-*•]\s/.test(line)
        const content  = line.replace(/^[-*•]\s/, '')
        // bold **text**
        const parts = content.split(/(\*\*[^*]+\*\*)/)
        const rendered = parts.map((p, j) =>
          p.startsWith('**') && p.endsWith('**')
            ? <strong key={j}>{p.slice(2, -2)}</strong>
            : p
        )
        return isBullet
          ? <div key={i} className="flex gap-1.5"><span className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-current opacity-50 mt-[7px]" /><span>{rendered}</span></div>
          : <div key={i}>{rendered}</div>
      })}
    </div>
  )
}

function AssistantMark({ className = 'w-6 h-6' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {/* 4-pointed sparkle star — Gemini style */}
      <path d="M12 2C12 2 13.2 8.4 16.2 11.8C19.2 15.2 22 12 22 12C22 12 18.8 8.8 16.2 12.2C13.6 15.6 12 22 12 22C12 22 10.4 15.6 7.8 12.2C5.2 8.8 2 12 2 12C2 12 4.8 15.2 7.8 11.8C10.8 8.4 12 2 12 2Z"/>
    </svg>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FloatingAssistant({ inline = false, onBack }) {
  const { user }  = useAuth()
  const toast     = useToast()

  const [open,           setOpen]           = useState(false)
  const [messages,       setMessages]       = useState([])     // { role, content }
  const [input,          setInput]          = useState('')
  const [loading,        setLoading]        = useState(false)
  const [ros,            setRos]            = useState([])
  const [employees,      setEmployees]      = useState([])
  const [dataLoaded,     setDataLoaded]     = useState(false)
  const [pendingActions, setPendingActions] = useState([])
  const [applying,       setApplying]       = useState(false)
  const [smsDraft,       setSmsDraft]       = useState(null)
  const [copied,         setCopied]         = useState(false)
  const [memory,         setMemory]         = useState([])        // loaded facts
  const [showMemory,     setShowMemory]     = useState(false)     // memory panel toggle
  const [savedFacts,     setSavedFacts]     = useState([])        // facts just saved this session
  const [isFullscreen,   setIsFullscreen]   = useState(false)
  const [showChatHistory, setShowChatHistory] = useState(false)
  const [chatHistory,     setChatHistory]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('autobody.chat.history.v1') || '[]') }
    catch { return [] }
  })

  // Voice
  const [listening,      setListening]      = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [audioLevel,     setAudioLevel]     = useState(0)
  const [recordSecs,     setRecordSecs]     = useState(0)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef   = useRef([])
  const audioContextRef  = useRef(null)
  const levelAnimRef     = useRef(null)
  const recordTimerRef   = useRef(null)
  const bottomRef        = useRef(null)
  const inputRef         = useRef(null)

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Load RO + employee data on first open
  useEffect(() => {
    if (open && !dataLoaded) loadData()
  }, [open]) // eslint-disable-line

  const loadData = async () => {
    try {
      const [roSnap, empSnap, mem] = await Promise.all([
        getDocs(collection(db, 'ros')),
        getDocs(collection(db, 'users')),
        loadAssistantMemory(),
      ])
      setRos(roSnap.docs.map(d => ({ id: d.id, ...d.data() })))
      // users collection: document ID is the uid
      setEmployees(empSnap.docs.map(d => ({ uid: d.id, id: d.id, ...d.data() })))
      setMemory(mem)
      setDataLoaded(true)
    } catch (err) {
      console.error('[FloatingAssistant] data load:', err)
    }
  }

  // ── Send message ─────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    setPendingActions([])
    setSmsDraft(null)

    const userMsg    = { role: 'user', content: msg }
    const nextMsgs   = [...messages, userMsg]
    setMessages(nextMsgs)
    setLoading(true)

    try {
      const result = await askShopAssistant({ messages: nextMsgs, ros, employees })
      setMessages(prev => [...prev, { role: 'assistant', content: result.reply ?? '...' }])
      if (result.actions?.length)     setPendingActions(result.actions)
      if (result.smsText)             setSmsDraft(result.smsText)
      // Save any new memory facts the AI identified
      if (result.memoryFacts?.length) {
        const newFacts = []
        for (const fact of result.memoryFacts) {
          if (fact?.trim()) {
            const updated = await appendAssistantMemory(fact.trim())
            setMemory(updated)
            newFacts.push(fact.trim())
          }
        }
        if (newFacts.length) setSavedFacts(newFacts)
      }
    } catch (err) {
      const errMsg = err.message === 'NO_API_KEY'
        ? '⚙️ Please configure your Anthropic API Key in Settings first.'
        : `❌ ${err.message}`
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, ros, employees])

  // ── Apply AI-suggested actions ────────────────────────────────────────────
  const applyActions = async () => {
    if (!pendingActions.length) return
    setApplying(true)
    const stamp  = format(new Date(), 'MM/dd HH:mm')
    const author = employees.find(e => e.uid === user?.uid)?.name ?? user?.email ?? 'Manager'

    try {
      for (const action of pendingActions) {
        const roDoc = ros.find(r => r.roNumber === action.roNumber)
        if (!roDoc) continue

        if (action.type === 'add_note') {
          const line = `[${stamp} - ${author}] ${action.note}`
          await updateDoc(doc(db, 'ros', roDoc.id), {
            notes: `${line}\n${roDoc.notes ?? ''}`,
            updatedAt: serverTimestamp(),
          })
        } else if (action.type === 'assign_body_man') {
          const assignee = findEmployeeByName(employees, action.assigneeName, 'body_man')
          if (assignee) {
            await updateDoc(doc(db, 'ros', roDoc.id), {
              assignedBodyMan: assignee.uid,
              updatedAt: serverTimestamp(),
            })
            await addDoc(collection(db, 'tasks'), {
              roId: roDoc.id, roNumber: roDoc.roNumber,
              vehicleInfo: roDoc.vehicle,
              assignedTo: assignee.uid,
              assignedBy: user?.uid ?? '',
              assignedToName: assignee.name ?? '',
              title: 'Teardown & process repair',
              description: '',
              category: 'body',
              partsStatus: roDoc.partsStatus ?? '',
              priority: dueDateToPriority(roDoc),
              dueDate: roDoc.cccDateOut || roDoc.promisedDate || null,
              status: 'pending',
              createdAt: serverTimestamp(),
            })
          }
        } else if (action.type === 'assign_task') {
          const isBodyTask = isBodyTaskAction(action)
          const assignee = findEmployeeByName(employees, action.assigneeName, isBodyTask ? 'body_man' : null)
          if (!assignee) throw new Error(`Could not match task assignee "${action.assigneeName}".`)
          const roDueDate  = roDoc.cccDateOut || roDoc.promisedDate || null
          const fields = {
            roId: roDoc.id, roNumber: roDoc.roNumber,
            vehicleInfo: roDoc.vehicle,
            assignedTo: assignee.uid,
            assignedBy: user?.uid ?? '',
            assignedToName: assignee.name ?? '',
            title: normalizedTaskTitle(action, isBodyTask),
            description: normalizedTaskDescription(action, isBodyTask),
            category: isBodyTask ? 'body' : '',
            partsStatus: roDoc.partsStatus ?? '',
            priority: dueDateToPriority(roDoc),
            dueDate: roDueDate,
            status: 'pending',
            createdAt: serverTimestamp(),
          }
          if (isBodyTask) fields.assignedBodyMan = assignee.uid
          await addDoc(collection(db, 'tasks'), fields)
          // Also write assignedBodyMan to RO if it's a body task
          if (isBodyTask) {
            await updateDoc(doc(db, 'ros', roDoc.id), {
              assignedBodyMan: assignee.uid,
              updatedAt: serverTimestamp(),
            })
          }
        }
      }
      toast.success(`Applied ${pendingActions.length} action${pendingActions.length > 1 ? 's' : ''}`)
      setPendingActions([])
      setMessages(prev => [...prev, { role: 'assistant', content: '✅ Actions applied!' }])
    } catch (err) {
      toast.error('Apply failed: ' + err.message)
    } finally {
      setApplying(false)
    }
  }

  // ── Whisper voice recording ───────────────────────────────────────────────
  const toggleVoice = async () => {
    if (listening) {
      setListening(false)
      clearInterval(recordTimerRef.current)
      cancelAnimationFrame(levelAnimRef.current)
      audioContextRef.current?.close().catch(() => {})
      setAudioLevel(0); setRecordSecs(0)

      const mr = mediaRecorderRef.current
      if (!mr) return
      const blob = await new Promise(resolve => {
        mr.onstop = () => resolve(new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' }))
        mr.stop(); mr.stream.getTracks().forEach(t => t.stop())
      })
      if (!blob || blob.size < 1000) return

      setIsTranscribing(true)
      try {
        const transcript = await transcribeWithWhisper(blob)
        if (transcript.trim()) {
          setInput(prev => prev.trimEnd() ? prev.trimEnd() + ' ' + transcript.trim() : transcript.trim())
          inputRef.current?.focus()
        }
      } catch { toast.error('Transcription failed') }
      finally { setIsTranscribing(false) }
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = audioCtx
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(buf)
        setAudioLevel(buf.reduce((a, b) => a + b, 0) / buf.length / 255)
        levelAnimRef.current = requestAnimationFrame(tick)
      }
      tick()
      setRecordSecs(0)
      recordTimerRef.current = setInterval(() => setRecordSecs(s => s + 1), 1000)
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                     : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const mr = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start(250)
      mediaRecorderRef.current = mr
      setListening(true)
    } catch { toast.error('Microphone access denied') }
  }

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }

  const openSMS = (text) => {
    const encoded = encodeURIComponent(text)
    window.open(`sms:?body=${encoded}`, '_self')
  }

  const mentionCandidates = useMemo(() => buildMentionCandidates(employees), [employees])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Floating button — desktop/FAB mode only ──────────────────────── */}
      {!inline && !open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-24 right-4 z-40 w-14 h-14 rounded-full shadow-xl flex items-center justify-center
            bg-zinc-950 hover:bg-zinc-800 active:scale-95 transition-all border border-white/20
            ring-1 ring-black/10 text-white"
          title="Shop Assistant"
        >
          <AssistantMark className="w-8 h-8" />
        </button>
      )}

      {/* ── Chat panel ──────────────────────────────────────────────────── */}
      {(inline || open) && (
        <div
          className={inline
            ? 'flex flex-col h-full w-full bg-gray-50 dark:bg-zinc-950 overflow-hidden'
            : `fixed z-50 flex flex-col bg-gray-50 dark:bg-zinc-950 shadow-2xl border border-gray-200 dark:border-zinc-800
              ${isFullscreen ? 'inset-0' : 'right-4 bottom-20 w-[min(520px,calc(100vw-2rem))] h-[min(580px,68vh)] rounded-2xl overflow-hidden'}`}
        >

          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 shrink-0">
            {inline && onBack && (
              <button
                onClick={onBack}
                className="p-1.5 -ml-1 mr-1 rounded-lg text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
                </svg>
              </button>
            )}
            <span className="w-8 h-8 rounded-full bg-zinc-950 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center">
              <AssistantMark className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm text-gray-900 dark:text-gray-100">Shop Assistant <span className="text-[10px] font-normal text-violet-500 dark:text-violet-400">Opus</span></p>
              <p className="text-xs text-gray-400 dark:text-zinc-500">
                {dataLoaded ? `${ros.length} ROs · ask anything` : 'Loading…'}
              </p>
            </div>
            {/* Memory button */}
            <button
              onClick={() => { setShowMemory(v => !v); setShowChatHistory(false) }}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors
                ${showMemory
                  ? 'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300'
                  : 'text-gray-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40'}`}
              title="Learned memory"
            >
              🧠 {memory.length}
            </button>
            {/* Chat history button */}
            <button
              onClick={() => { setShowChatHistory(v => !v); setShowMemory(false) }}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors
                ${showChatHistory
                  ? 'bg-gray-100 dark:bg-zinc-700 text-gray-700 dark:text-zinc-200'
                  : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
              title="Chat history"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span>{chatHistory.length}</span>
            </button>
            {/* New chat */}
            <button
              onClick={() => {
                if (messages.length > 1) {
                  const entry = {
                    id: Date.now(),
                    at: new Date().toISOString(),
                    preview: messages.find(m => m.role === 'user')?.content?.slice(0, 70) || '…',
                    messages: messages.slice(0, 30),
                  }
                  setChatHistory(prev => {
                    const updated = [entry, ...prev].slice(0, 15)
                    localStorage.setItem('autobody.chat.history.v1', JSON.stringify(updated))
                    return updated
                  })
                }
                setMessages([]); setPendingActions([]); setSmsDraft(null); setSavedFacts([])
              }}
              className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800"
            >New</button>
            {!inline && (
              <>
                <button
                  onClick={() => setIsFullscreen(v => !v)}
                  className="p-2 rounded-xl text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800"
                  title={isFullscreen ? 'Small window' : 'Full screen'}
                >
                  {isFullscreen ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/>
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="p-2 rounded-xl text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Memory panel — collapsible */}
          {showMemory && (
            <div className="bg-violet-50 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-800 px-4 py-3 shrink-0 max-h-48 overflow-y-auto">
              <p className="text-xs font-semibold text-violet-700 dark:text-violet-400 mb-2">
                🧠 Learned Memory ({memory.length} facts)
              </p>
              {memory.length === 0 && (
                <p className="text-xs text-violet-500 dark:text-violet-600">No facts yet — just chat and I'll learn from you automatically.</p>
              )}
              <div className="space-y-1">
                {memory.map((fact, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-violet-800 dark:text-violet-300">
                    <span className="shrink-0 mt-0.5 opacity-50">·</span>
                    <span className="flex-1">{fact}</span>
                    <button
                      onClick={async () => { const upd = await deleteAssistantMemory(fact); setMemory(upd) }}
                      className="shrink-0 text-violet-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chat history panel */}
          {showChatHistory && (
            <div className="bg-gray-50 dark:bg-zinc-800/60 border-b border-gray-200 dark:border-zinc-700 px-4 py-3 shrink-0 max-h-52 overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-600 dark:text-zinc-300">Past Conversations</p>
                {chatHistory.length > 0 && (
                  <button
                    onClick={() => { localStorage.removeItem('autobody.chat.history.v1'); setChatHistory([]) }}
                    className="text-xs text-gray-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
                  >Clear all</button>
                )}
              </div>
              {chatHistory.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-zinc-500">No past conversations yet.</p>
              ) : (
                <div className="space-y-1">
                  {chatHistory.map(c => (
                    <button
                      key={c.id}
                      onClick={() => { setMessages(c.messages); setShowChatHistory(false) }}
                      className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white dark:hover:bg-zinc-700 transition-colors"
                    >
                      <span className="block text-[10px] text-gray-400 dark:text-zinc-500">
                        {new Date(c.at).toLocaleDateString()} {new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="block text-xs text-gray-700 dark:text-zinc-200 truncate">{c.preview}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">

            {/* Empty state */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-full gap-4 py-8">
                <div className="w-14 h-14 rounded-2xl bg-zinc-950 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center shadow-lg">
                  <AssistantMark className="w-9 h-9" />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-gray-800 dark:text-gray-200">Shop Assistant</p>
                  <p className="text-sm text-gray-400 dark:text-zinc-500 mt-1">Ask me anything about vehicles in the shop</p>
                  <p className="text-xs text-gray-300 dark:text-zinc-600 mt-1.5">Use the quick prompts below ↓</p>
                </div>
              </div>
            )}

            {/* Chat messages */}
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                {/* Avatar */}
                <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm
                  ${msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-950 dark:bg-zinc-100'}`}
                >
                  {msg.role === 'user' ? '👤' : <AssistantMark className="w-4 h-4" />}
                </div>
                {/* Bubble */}
                <div className={`max-w-[82%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed
                  ${msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-sm'
                    : 'bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-100 border border-gray-100 dark:border-zinc-700 rounded-tl-sm'}`}
                >
                  {msg.role === 'assistant'
                    ? <MiniMarkdown text={msg.content} />
                    : msg.content
                  }
                </div>
              </div>
            ))}

            {/* Loading indicator */}
            {loading && (
              <div className="flex gap-2.5">
                <div className="shrink-0 w-7 h-7 rounded-full bg-zinc-950 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center">
                  <AssistantMark className="w-4 h-4" />
                </div>
                <div className="bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 rounded-2xl rounded-tl-sm px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {[0,1,2].map(i => (
                      <span key={i} className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-zinc-500"
                        style={{ animation: `voiceBar 0.9s ease-in-out ${i * 0.2}s infinite alternate` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Memory saved notification */}
            {savedFacts.length > 0 && (
              <div className="flex items-start gap-2 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 rounded-2xl px-3.5 py-2.5">
                <span className="text-base shrink-0">🧠</span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-violet-700 dark:text-violet-400">Memory updated</p>
                  {savedFacts.map((f, i) => (
                    <p key={i} className="text-xs text-violet-600 dark:text-violet-400 mt-0.5">+ {f}</p>
                  ))}
                </div>
                <button onClick={() => setSavedFacts([])} className="shrink-0 text-violet-300 hover:text-violet-500 text-xs">×</button>
              </div>
            )}

            {/* Pending actions card */}
            {pendingActions.length > 0 && (
              <div className="bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-2xl p-3 space-y-2">
                <p className="text-xs font-semibold text-green-700 dark:text-green-400">
                  🎯 {pendingActions.length} action{pendingActions.length !== 1 ? 's' : ''} to confirm
                </p>
                {pendingActions.map((a, i) => (
                  <div key={i} className="text-xs text-green-800 dark:text-green-300 bg-white/60 dark:bg-green-900/30 rounded-lg px-2.5 py-1.5">
                    <span className="font-mono font-semibold">RO#{a.roNumber}</span>
                    {' · '}
                    {a.type === 'add_note'       && `Add note: "${a.note?.slice(0, 60)}${a.note?.length > 60 ? '…' : ''}"`}
                    {a.type === 'assign_task'    && `Assign "${a.title}" → ${a.assigneeName}`}
                    {a.type === 'assign_body_man' && `Set body tech → ${a.assigneeName}`}
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={applyActions}
                    disabled={applying}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg"
                  >{applying ? 'Applying…' : '✓ Apply'}</button>
                  <button
                    onClick={() => setPendingActions([])}
                    className="px-3 py-1.5 border border-green-300 text-green-700 text-xs rounded-lg hover:bg-green-100 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900/40"
                  >Cancel</button>
                </div>
              </div>
            )}

            {/* SMS draft card */}
            {smsDraft && (
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-2xl p-3">
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">📱 SMS Draft</p>
                <p className="text-sm text-blue-900 dark:text-blue-200 whitespace-pre-wrap leading-relaxed">{smsDraft}</p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => copyText(smsDraft)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg"
                  >{copied ? '✓ Copied' : 'Copy'}</button>
                  <button
                    onClick={() => openSMS(smsDraft)}
                    className="px-3 py-1.5 border border-blue-300 text-blue-700 text-xs rounded-lg hover:bg-blue-100 dark:border-blue-700 dark:text-blue-400"
                  >📨 Open SMS</button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* ── Input area ─────────────────────────────────────────────── */}
          <div className="shrink-0 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-800 px-3 pt-2.5 pb-[env(safe-area-inset-bottom,10px)] space-y-2">

            {/* Textarea */}
            <MentionTextarea
              inputRef={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              candidates={mentionCandidates}
              dropdownPlacement="top"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
              placeholder="Ask about any vehicle…"
              rows={2}
              className="w-full px-3 py-2.5 border border-gray-200 dark:border-zinc-700 rounded-xl text-sm
                bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-gray-100
                placeholder-gray-400 dark:placeholder-zinc-600
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-800
                leading-relaxed transition-colors resize-none"
              style={{ maxHeight: 120, overflowY: 'auto' }}
              disabled={loading}
            />

            {/* Toolbar: mic | quick-prompt chips | send */}
            <div className="flex items-center gap-1.5">

              {/* Voice */}
              <button
                type="button"
                onClick={toggleVoice}
                disabled={isTranscribing}
                title={listening ? `Recording ${String(Math.floor(recordSecs/60)).padStart(2,'0')}:${String(recordSecs%60).padStart(2,'0')}` : 'Voice input'}
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border transition-all active:scale-95
                  ${listening
                    ? 'bg-red-500 border-red-400 text-white'
                    : isTranscribing
                    ? 'bg-purple-100 border-purple-300 text-purple-600 dark:bg-purple-950/30 dark:border-purple-700'
                    : 'border-gray-200 dark:border-zinc-700 text-gray-400 dark:text-zinc-500 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'}`}
              >
                {listening ? (
                  <span className="flex items-end gap-[2px] h-3.5 px-0.5">
                    {[0,1,2,3].map(i => (
                      <span key={i} className="w-[2px] rounded-full bg-white"
                        style={{ height: `${Math.max(20, Math.min(100, audioLevel * 100 * [0.7,1,0.8,0.9][i] + 10))}%` }} />
                    ))}
                  </span>
                ) : isTranscribing ? (
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <rect x="9" y="2" width="6" height="11" rx="3"/>
                    <path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>
                  </svg>
                )}
              </button>

              {/* Quick-prompt chips — horizontally scrollable */}
              <div className="flex-1 flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {QUICK_PROMPTS.map(q => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => sendMessage(q.text)}
                    disabled={!dataLoaded || loading}
                    className="shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-full border border-gray-200 dark:border-zinc-700
                      bg-white dark:bg-zinc-800 text-gray-600 dark:text-zinc-300
                      hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50
                      dark:hover:border-blue-700 dark:hover:bg-blue-950/40 dark:hover:text-blue-300
                      disabled:opacity-40 transition-all whitespace-nowrap"
                  >
                    {q.label}
                  </button>
                ))}
              </div>

              {/* Send */}
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading || !dataLoaded}
                className="shrink-0 w-8 h-8 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40
                  text-white flex items-center justify-center transition-all active:scale-95"
              >
                {loading ? (
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/>
                  </svg>
                )}
              </button>
            </div>

          </div>

        </div>
      )}
    </>
  )
}
