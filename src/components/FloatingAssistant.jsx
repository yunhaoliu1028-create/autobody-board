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

// ── Quick prompt chips ────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  { label: '🌅 晨会简报', text: '请给我一个今天的晨会简报：目前重点需要关注的车子，有什么问题，今天预计交车的有哪些？' },
  { label: '🚗 今日交车', text: '请列出今天和明天预计交车的车子，告诉我是否还有未完成的事项或部件未到。' },
  { label: '⚠️ 需跟进',  text: '请列出目前最需要关注和跟进的车子，包括超期、部件未到、或有其他问题的，按优先级排列。' },
  { label: '📱 生成短信', text: '请帮我生成一条简短的中文短信，总结今天店内所有车子的状态，供发给老板参考，控制在300字以内。' },
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
    <svg className={className} viewBox="0 0 64 64" fill="none" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="20" y="6" width="24" height="6" rx="2" fill="#111827" />
      <rect x="29" y="12" width="6" height="6" fill="#4b5563" />
      <rect x="12" y="18" width="40" height="34" rx="8" fill="#111827" />
      <rect x="16" y="22" width="32" height="26" rx="5" fill="#f8fafc" />
      <rect x="22" y="30" width="8" height="8" rx="2" fill="#111827" />
      <rect x="34" y="30" width="8" height="8" rx="2" fill="#111827" />
      <rect x="27" y="42" width="10" height="3" rx="1" fill="#9ca3af" />
      <rect x="6" y="28" width="6" height="14" rx="2" fill="#374151" />
      <rect x="52" y="28" width="6" height="14" rx="2" fill="#374151" />
      <rect x="23" y="31" width="2" height="2" fill="#f8fafc" />
      <rect x="35" y="31" width="2" height="2" fill="#f8fafc" />
    </svg>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FloatingAssistant() {
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
        ? '⚙️ 请先在 Settings 中配置 Anthropic API Key。'
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
          const assignee = findEmployeeByName(employees, action.assigneeName)
          if (assignee) {
            await updateDoc(doc(db, 'ros', roDoc.id), {
              assignedBodyMan: assignee.uid,
              updatedAt: serverTimestamp(),
            })
          }
        } else if (action.type === 'assign_task') {
          const assignee = findEmployeeByName(employees, action.assigneeName)
          if (!assignee) throw new Error(`Could not match task assignee "${action.assigneeName}".`)
          const roDueDate  = roDoc.cccDateOut || roDoc.promisedDate || null
          const isBodyTask = /body\s*(man|tech|work)/i.test(action.title ?? '')
          const fields = {
            roId: roDoc.id, roNumber: roDoc.roNumber,
            vehicleInfo: roDoc.vehicle,
            assignedTo: assignee.uid,
            assignedBy: user?.uid ?? '',
            assignedToName: assignee.name ?? '',
            title: action.title,
            description: action.description ?? '',
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
      setMessages(prev => [...prev, { role: 'assistant', content: '✅ 操作已完成！' }])
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
      {/* ── Floating button ─────────────────────────────────────────────── */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 w-14 h-14 rounded-full shadow-xl flex items-center justify-center
          bg-zinc-950 hover:bg-zinc-800 active:scale-95 transition-all border border-white/20
          ring-1 ring-black/10"
        title="Shop Assistant"
      >
        <AssistantMark className="w-8 h-8" />
      </button>

      {/* ── Chat panel ──────────────────────────────────────────────────── */}
      {open && (
        <div
          className={`fixed z-50 flex flex-col bg-gray-50 dark:bg-zinc-950 shadow-2xl border border-gray-200 dark:border-zinc-800
            ${isFullscreen
              ? 'inset-0'
              : 'right-4 bottom-20 w-[min(520px,calc(100vw-2rem))] h-[min(660px,calc(100vh-7rem))] rounded-2xl overflow-hidden'}`}
        >

          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 shrink-0">
            <span className="w-8 h-8 rounded-full bg-zinc-950 dark:bg-zinc-100 flex items-center justify-center">
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
              onClick={() => setShowMemory(v => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors
                ${showMemory
                  ? 'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300'
                  : 'text-gray-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40'}`}
              title="Learned memory"
            >
              🧠 {memory.length}
            </button>
            {/* New chat */}
            <button
              onClick={() => { setMessages([]); setPendingActions([]); setSmsDraft(null); setSavedFacts([]) }}
              className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800"
            >New</button>
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

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">

            {/* Empty state with quick prompts */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-full gap-5 py-8">
                <div className="w-14 h-14 rounded-2xl bg-zinc-950 dark:bg-zinc-100 flex items-center justify-center shadow-lg">
                  <AssistantMark className="w-9 h-9" />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-gray-800 dark:text-gray-200">你好！我是店铺助手</p>
                  <p className="text-sm text-gray-400 dark:text-zinc-500 mt-1">可以问我任何关于店内车辆的问题</p>
                </div>
                <div className="grid grid-cols-2 gap-2 w-full max-w-xs">
                  {QUICK_PROMPTS.map(q => (
                    <button
                      key={q.label}
                      onClick={() => sendMessage(q.text)}
                      disabled={!dataLoaded}
                      className="px-3 py-2.5 text-xs font-medium text-left rounded-xl border border-gray-200 dark:border-zinc-700
                        bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300
                        hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 dark:hover:border-blue-700
                        disabled:opacity-40 transition-all active:scale-95"
                    >
                      {q.label}
                    </button>
                  ))}
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
                <div className="shrink-0 w-7 h-7 rounded-full bg-zinc-950 dark:bg-zinc-100 flex items-center justify-center">
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
                  <p className="text-xs font-semibold text-violet-700 dark:text-violet-400">记忆已更新</p>
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
                  🎯 {pendingActions.length} 个操作待确认
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
                  >{applying ? 'Applying…' : '✓ 执行操作'}</button>
                  <button
                    onClick={() => setPendingActions([])}
                    className="px-3 py-1.5 border border-green-300 text-green-700 text-xs rounded-lg hover:bg-green-100 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900/40"
                  >取消</button>
                </div>
              </div>
            )}

            {/* SMS draft card */}
            {smsDraft && (
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-2xl p-3">
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">📱 短信草稿</p>
                <p className="text-sm text-blue-900 dark:text-blue-200 whitespace-pre-wrap leading-relaxed">{smsDraft}</p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => copyText(smsDraft)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg"
                  >{copied ? '✓ 已复制' : '复制'}</button>
                  <button
                    onClick={() => openSMS(smsDraft)}
                    className="px-3 py-1.5 border border-blue-300 text-blue-700 text-xs rounded-lg hover:bg-blue-100 dark:border-blue-700 dark:text-blue-400"
                  >📨 打开短信</button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* ── Input area ─────────────────────────────────────────────── */}
          <div className="shrink-0 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-800 px-4 py-3 pb-[env(safe-area-inset-bottom,14px)]">
            <div className="flex items-end gap-2.5">

              {/* Voice button */}
              <button
                type="button"
                onClick={toggleVoice}
                disabled={isTranscribing}
                className={`shrink-0 w-11 h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 border-2 transition-all active:scale-95
                  ${listening
                    ? 'bg-red-500 border-red-400 text-white'
                    : isTranscribing
                    ? 'bg-purple-100 border-purple-300 text-purple-600'
                    : 'border-gray-200 dark:border-zinc-700 text-gray-400 dark:text-zinc-500 hover:border-blue-400 hover:text-blue-600 bg-white dark:bg-zinc-800'}`}
              >
                {listening ? (
                  <span className="flex items-end gap-[2px] h-4">
                    {[0,1,2,3].map(i => (
                      <span key={i} className="w-[2.5px] rounded-full bg-white"
                        style={{ height: `${Math.max(20, Math.min(100, audioLevel * 100 * [0.7,1,0.8,0.9][i] + 10))}%` }} />
                    ))}
                  </span>
                ) : isTranscribing ? (
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <rect x="9" y="2" width="6" height="11" rx="3"/>
                    <path strokeLinecap="round" d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>
                  </svg>
                )}
                {listening && (
                  <span className="text-[9px] font-mono text-white leading-none">
                    {String(Math.floor(recordSecs/60)).padStart(2,'0')}:{String(recordSecs%60).padStart(2,'0')}
                  </span>
                )}
              </button>

              {/* Text input */}
              <MentionTextarea
                inputRef={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                candidates={mentionCandidates}
                dropdownPlacement="inside"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
                placeholder="问我关于车辆的任何问题…"
                rows={3}
                className="flex-1 resize-y min-h-[92px] px-3.5 py-3 border border-gray-200 dark:border-zinc-700 rounded-xl text-sm
                  bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-gray-100
                  placeholder-gray-400 dark:placeholder-zinc-600
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-800
                  leading-relaxed transition-colors"
                style={{ maxHeight: 180, overflowY: 'auto' }}
                disabled={loading}
              />

              {/* Send button */}
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading || !dataLoaded}
                className="shrink-0 w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40
                  text-white flex items-center justify-center transition-all active:scale-95"
              >
                {loading ? (
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
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
