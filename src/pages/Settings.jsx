import { useState, useEffect, useRef } from 'react'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, getDocs, collection } from 'firebase/firestore'
import { format } from 'date-fns'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { saveApiKey, getApiKey, clearKeyCache, saveOpenAIKey, getOpenAIKey, clearOpenAIKeyCache, summarizeDayNotes } from '../hooks/useAI'
import { parseNoteLines } from '../components/DailyNotesLog'
import { MANAGER_ROLES } from '../constants/roles'
import { t } from '../utils/mobileI18n'

// ── Preset glossary ───────────────────────────────────────────────────────────
// Chinese parts (中文零件)
const PRESET_GLOSSARY = [
  // —— 车身零件 Body Parts ——
  '叶子板 / 翼子板 = fender',
  '大灯 = headlight assembly',
  '尾灯 / 后灯 = tail light assembly',
  '转向灯 / 角灯 = turn signal / corner light',
  '雾灯 = fog light',
  '格栅 = grille',
  '前包围 / 前保险杠 = front bumper cover',
  '后包围 / 后保险杠 = rear bumper cover',
  '引擎盖 / 机盖 = hood',
  '尾箱盖 / 行李箱盖 = trunk lid / liftgate',
  '车门 = door',
  '门板 = door panel / door skin',
  'A柱 = A pillar',
  'B柱 = B pillar',
  'C柱 = C pillar',
  '侧裙 = rocker panel',
  '轮眉 = wheel arch / fender flare',
  '天窗 = sunroof / moonroof',
  '前风挡 = windshield',
  '后风挡 = rear windshield',
  '侧玻璃 = side glass',
  '水箱 / 散热器 = radiator',
  '气囊 = airbag',
  '安全带 = seatbelt',
  '车架 = frame / unibody',
  '底盘 = underbody / subframe',
  // —— 工序流程 Repair Process ——
  '钣金 = body work / metal repair',
  '喷漆 = paint / paint job',
  '调色 = color matching / blending',
  '打磨 / 磨平 = sanding',
  '上灰 / 打灰 = apply body filler',
  '腻子 = body filler / Bondo',
  '打底 = apply primer',
  '底漆 = primer coat',
  '面漆 = top coat',
  '清漆 = clear coat',
  '抛光 / 打蜡 = buffing / polishing',
  '拆件 = teardown / disassembly',
  '装件 = reassembly',
  '校正 / 四轮定位 = wheel alignment (4WA)',
  '标定 / 电脑标定 = ADAS calibration',
  '框架校正 = frame straightening',
  '拉伸 = frame pull',
  '进漆房 = in paint booth / in paint',
  '出漆房 = out of paint booth / paint complete',
  // —— 状态更新 Status & Updates ——
  '零件到了 / 料到了 = parts received / all received',
  '等零件 = waiting on parts',
  '零件已订 / 已下单 = parts ordered',
  '收车 / 进店 = vehicle check-in / car in shop',
  '交车 = vehicle delivery / customer pickup',
  '客户已授权 = customer authorized',
  '保险已授权 = insurance authorized',
  '钣金完成 / 修好了 = body work complete',
  '喷漆完成 = paint complete',
  '已完成 / 做好了 = work complete / done',
  // —— 常用缩写 Abbreviations ——
  'PT / 料行 = Parts Trader (parts supplier)',
  'SM = shop manager',
  'PM = production manager',
  'EST = estimator — writes estimates AND is responsible for ordering parts',
  'estimator orders parts = estimator places parts order after teardown reveals damage',
  'parts manager tracks parts = parts manager tracks ETA, confirms receipt, processes returns — does NOT order',
  '退零件 / 退料 = return parts (handled by parts manager)',
  '零件全收到 = all parts received (parts manager confirms)',
  'supp / 补项 = supplement (additional insurance claim)',
  'TL / 全损 = total loss',
  'DRP = Direct Repair Program (insurance preferred)',
  'adj / 定损员 = insurance adjuster',
  // —— Español (Spanish) ——
  'parachoques = bumper cover',
  'guardafango = fender',
  'capó = hood',
  'cajuela = trunk lid',
  'portezuela = door',
  'parabrisas = windshield',
  'carrocería = body work',
  'pintura = paint',
  'masilla = body filler',
  'lijado = sanding',
  'piezas llegaron = parts received',
  'esperando piezas = waiting on parts',
  'listo para entregar = ready for pickup',
]

const INPUT = 'w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono'
const PLAIN_INPUT = 'w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500'
const CARD = 'bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5'
const TITLE = 'text-sm font-semibold text-gray-800 dark:text-zinc-100'
const MUTED = 'text-xs text-gray-500 dark:text-zinc-400'
const LABEL = 'block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1'
const SECONDARY_BUTTON = 'px-4 py-2 border border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 text-sm rounded-lg transition-colors'
const SAVED_BANNER = 'flex items-center gap-2 mb-2 px-3 py-2 bg-green-50 dark:bg-emerald-950/25 border border-green-200 dark:border-emerald-900/60 rounded-lg'
const CODE = 'bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-200 px-1 rounded'
const DEFAULT_MONTHLY_REPAIR_GOAL = 26000

export default function Settings() {
  const { user, userProfile, role, refreshProfile } = useAuth()
  const isManager = MANAGER_ROLES.includes(role)

  const [displayName,    setDisplayName]    = useState('')
  const [phone,          setPhone]          = useState('')
  const [language,       setLanguage]       = useState('english')
  const [profileSaved,   setProfileSaved]   = useState(false)
  const [profileSaving,  setProfileSaving]  = useState(false)
  const [apiKey,         setApiKey]         = useState('')
  const [keyMasked,      setKeyMasked]      = useState(false)
  const [keyStatus,      setKeyStatus]      = useState(null)
  const [testLoading,    setTestLoading]    = useState(false)
  const [testResult,     setTestResult]     = useState(null)
  const [openaiKey,      setOpenaiKey]      = useState('')
  const [openaiMasked,   setOpenaiMasked]   = useState(false)
  const [openaiStatus,   setOpenaiStatus]   = useState(null)
  const [openaiTestLoad, setOpenaiTestLoad] = useState(false)
  const [openaiTestRes,  setOpenaiTestRes]  = useState(null)
  const [nameMap,        setNameMap]        = useState('')
  const [vendorMap,      setVendorMap]      = useState('')
  const [mapSaved,       setMapSaved]       = useState(false)
  const [monthlyRepairGoal, setMonthlyRepairGoal] = useState(String(DEFAULT_MONTHLY_REPAIR_GOAL))
  const [revenueSaved,   setRevenueSaved]   = useState(false)
  // Glossary / AI Memory (all users)
  const [memory,         setMemory]         = useState([])
  const [memLoading,     setMemLoading]     = useState(true)
  const [newFact,        setNewFact]        = useState('')
  const [memFlash,       setMemFlash]       = useState('')
  const [importPreview,  setImportPreview]  = useState(null) // { toAdd: string[] } | null
  const [searchGlossary, setSearchGlossary] = useState('')
  const newFactRef = useRef(null)
  // Note summary regeneration
  const [regenState,     setRegenState]     = useState(null) // null | { done, total, current, errors }

  useEffect(() => {
    setDisplayName(userProfile?.name ?? '')
    setPhone(userProfile?.phone ?? user?.phoneNumber ?? '')
    setLanguage(userProfile?.language ?? 'english')
  }, [userProfile, user])

  useEffect(() => {
    loadMemory()
    if (isManager) loadSettings()
  }, [isManager])

  const loadMemory = async () => {
    setMemLoading(true)
    try {
      const snap = await getDoc(doc(db, 'settings', 'assistantMemory'))
      setMemory(snap.exists() ? (snap.data().facts ?? []) : [])
    } finally {
      setMemLoading(false)
    }
  }

  const flash = (msg) => {
    setMemFlash(msg)
    setTimeout(() => setMemFlash(''), 2500)
  }

  const handleAddFact = async () => {
    const trimmed = newFact.trim()
    if (!trimmed || memory.includes(trimmed)) return
    const updated = [...memory, trimmed]
    await setDoc(doc(db, 'settings', 'assistantMemory'), { facts: updated }, { merge: true })
    setMemory(updated)
    setNewFact('')
    flash('✓ Term added')
    newFactRef.current?.focus()
  }

  const handleDeleteFact = async (fact) => {
    const updated = memory.filter(f => f !== fact)
    await setDoc(doc(db, 'settings', 'assistantMemory'), { facts: updated }, { merge: true })
    setMemory(updated)
  }

  const handleImportPreset = () => {
    const toAdd = PRESET_GLOSSARY.filter(t => !memory.includes(t))
    if (toAdd.length === 0) { flash('All preset terms already imported'); return }
    setImportPreview({ toAdd })
  }

  const confirmImport = async () => {
    const updated = [...memory, ...importPreview.toAdd]
    await setDoc(doc(db, 'settings', 'assistantMemory'), { facts: updated }, { merge: true })
    setMemory(updated)
    setImportPreview(null)
    flash(`✓ ${importPreview.toAdd.length} terms imported`)
  }

  const loadSettings = async () => {
    const snap = await getDoc(doc(db, 'settings', 'ai'))
    if (snap.exists()) {
      const d = snap.data()
      if (d.anthropicKey) { setApiKey(''); setKeyMasked(true) }
      if (d.openaiKey)    { setOpenaiKey(''); setOpenaiMasked(true) }
      if (d.nameMap)      setNameMap(d.nameMap)
      if (d.vendorMap)    setVendorMap(d.vendorMap)
    }
    const revenueSnap = await getDoc(doc(db, 'settings', 'revenue'))
    if (revenueSnap.exists()) {
      const goal = Number(revenueSnap.data()?.monthlyRepairGoal)
      if (Number.isFinite(goal) && goal > 0) setMonthlyRepairGoal(String(goal))
    }
  }

  const handleSaveKey = async () => {
    // Prevent saving if the field is empty (key already saved) or contains mask chars
    if (!apiKey.trim() || apiKey.includes('•')) {
      setKeyStatus('error')
      return
    }
    if (!apiKey.startsWith('sk-ant-') && !apiKey.startsWith('sk-')) {
      setKeyStatus('error')
      return
    }
    await saveApiKey(apiKey)
    setApiKey('')          // clear field after saving
    setKeyMasked(true)     // show saved indicator
    setKeyStatus('saved')
    setTimeout(() => setKeyStatus(null), 3000)
  }

  const handleTestKey = async () => {
    setTestLoading(true)
    setTestResult(null)
    try {
      const key = await getApiKey()
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply "OK" only.' }],
        }),
      })
      if (res.ok) {
        setTestResult({ ok: true, msg: '✅ API key is working!' })
      } else {
        const err = await res.json()
        setTestResult({ ok: false, msg: `❌ ${err.error?.message ?? 'Invalid key'}` })
      }
    } catch (e) {
      setTestResult({ ok: false, msg: `❌ ${e.message}` })
    } finally {
      setTestLoading(false)
    }
  }

  const handleSaveOpenAIKey = async () => {
    if (!openaiKey.trim() || openaiKey.includes('•')) { setOpenaiStatus('error'); return }
    if (!openaiKey.startsWith('sk-')) { setOpenaiStatus('error'); return }
    await saveOpenAIKey(openaiKey)
    setOpenaiKey(''); setOpenaiMasked(true); setOpenaiStatus('saved')
    setTimeout(() => setOpenaiStatus(null), 3000)
  }

  const handleTestOpenAIKey = async () => {
    setOpenaiTestLoad(true); setOpenaiTestRes(null)
    try {
      const key = await getOpenAIKey()
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      })
      if (res.ok) setOpenaiTestRes({ ok: true,  msg: '✅ OpenAI key is working!' })
      else        setOpenaiTestRes({ ok: false, msg: '❌ Invalid OpenAI key' })
    } catch (e) {
      setOpenaiTestRes({ ok: false, msg: `❌ ${e.message}` })
    } finally { setOpenaiTestLoad(false) }
  }

  const handleSaveMappings = async () => {
    await setDoc(doc(db, 'settings', 'ai'), { nameMap, vendorMap }, { merge: true })
    setMapSaved(true)
    setTimeout(() => setMapSaved(false), 3000)
  }

  const handleSaveRevenueGoal = async () => {
    const goal = Number(String(monthlyRepairGoal).replace(/[$,\s]/g, ''))
    if (!Number.isFinite(goal) || goal <= 0) return
    await setDoc(doc(db, 'settings', 'revenue'), {
      monthlyRepairGoal: goal,
      updatedAt: serverTimestamp(),
    }, { merge: true })
    setMonthlyRepairGoal(String(goal))
    setRevenueSaved(true)
    setTimeout(() => setRevenueSaved(false), 2500)
  }

  const handleSaveProfile = async () => {
    if (!user?.uid || !displayName.trim()) return
    setProfileSaving(true)
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        name: displayName.trim(),
        phone: phone.trim(),
        language,
        updatedAt: serverTimestamp(),
      })
      await refreshProfile()
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2500)
    } finally {
      setProfileSaving(false)
    }
  }

  const handleRegenSummaries = async () => {
    setRegenState({ done: 0, total: 0, current: '', errors: 0 })
    try {
      const snap = await getDocs(collection(db, 'ros'))
      const ros  = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      const todayMmdd = format(new Date(), 'MM/dd')
      const todayYear = new Date().getFullYear()
      setRegenState(s => ({ ...s, total: ros.length }))

      for (const ro of ros) {
        if (!ro.notes) { setRegenState(s => ({ ...s, done: s.done + 1 })); continue }
        setRegenState(s => ({ ...s, current: `RO${ro.roNumber}` }))

        const lines = parseNoteLines(ro.notes)
        const map   = new Map()
        for (const line of lines) {
          const m = line.match(/^\[(\d{2}\/\d{2})/)
          if (!m) continue
          const mmdd = m[1]
          if (!map.has(mmdd)) map.set(mmdd, [])
          map.get(mmdd).push(line)
        }

        const summaries = []
        for (const [mmdd, dayLines] of map.entries()) {
          if (mmdd === todayMmdd) continue
          const [month, day] = mmdd.split('/')
          const monthNum = parseInt(month, 10)
          const year = monthNum > new Date().getMonth() + 1 ? todayYear - 1 : todayYear
          const isoDate = `${year}-${month}-${day}`
          try {
            const result = await summarizeDayNotes({ vehicle: ro.vehicle, dateLabel: mmdd, noteLines: dayLines })
            summaries.push({ date: isoDate, bullets: result.bullets, generatedAt: new Date().toISOString() })
          } catch { setRegenState(s => ({ ...s, errors: s.errors + 1 })) }
        }

        if (summaries.length > 0) {
          await updateDoc(doc(db, 'ros', ro.id), { noteSummaries: summaries })
        }
        setRegenState(s => ({ ...s, done: s.done + 1 }))
      }
      setRegenState(s => ({ ...s, current: '', done: s.total }))
    } catch (err) {
      setRegenState(s => ({ ...s, current: `Error: ${err.message}` }))
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-zinc-100">{t(language, 'settings', 'Settings')}</h1>
        <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">Profile preferences</p>
      </div>

      <div className={CARD}>
        <h3 className={`${TITLE} mb-4`}>{language === 'spanish' ? 'Mi perfil' : 'My Profile'}</h3>
        <div className="space-y-4">
          <div>
            <label className={LABEL}>{language === 'spanish' ? 'Nombre visible' : 'Display name'}</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className={PLAIN_INPUT}
              placeholder="Your name"
            />
          </div>
          <div>
            <label className={LABEL}>{language === 'spanish' ? 'Telefono' : 'Phone'}</label>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className={PLAIN_INPUT}
              placeholder="+1 604 123 4567"
            />
          </div>
          <div>
            <label className={LABEL}>{language === 'spanish' ? 'Idioma' : 'Language'}</label>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              className={PLAIN_INPUT}
            >
              <option value="english">English</option>
              <option value="spanish">Spanish</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveProfile}
              disabled={profileSaving || !displayName.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {profileSaving
                ? (language === 'spanish' ? 'Guardando...' : 'Saving...')
                : (language === 'spanish' ? 'Guardar perfil' : 'Save Profile')}
            </button>
            {profileSaved && (
              <span className="text-xs text-green-600 dark:text-emerald-400">
                {language === 'spanish' ? 'Guardado' : 'Saved'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Shop Glossary / AI Memory (all users) ─────────────────────── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h3 className={TITLE}>📖 Shop Glossary</h3>
            <p className={`${MUTED} mt-0.5`}>
              AI memory — slang, abbreviations, and common terms GIB uses to understand your shop's language.
              Any update here takes effect on the next GIB input.
            </p>
          </div>
          <button
            onClick={handleImportPreset}
            className="shrink-0 px-3 py-1.5 text-xs font-medium border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-lg transition-colors whitespace-nowrap"
          >
            ⬇ Import Preset ({PRESET_GLOSSARY.length})
          </button>
        </div>

        {/* Import confirmation */}
        {importPreview && (
          <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/60 rounded-lg">
            <p className="text-sm text-blue-800 dark:text-blue-200 font-medium mb-2">
              Add {importPreview.toAdd.length} new terms to your glossary?
            </p>
            <div className="max-h-32 overflow-y-auto text-xs text-blue-700 dark:text-blue-300 space-y-0.5 mb-3">
              {importPreview.toAdd.map(t => <div key={t} className="font-mono">{t}</div>)}
            </div>
            <div className="flex gap-2">
              <button
                onClick={confirmImport}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg"
              >Confirm Import</button>
              <button
                onClick={() => setImportPreview(null)}
                className="px-3 py-1.5 text-xs text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg"
              >Cancel</button>
            </div>
          </div>
        )}

        {/* Flash feedback */}
        {memFlash && (
          <p className="text-xs text-green-600 dark:text-emerald-400 mb-2">{memFlash}</p>
        )}

        {/* Search */}
        <div className="mb-2">
          <input
            value={searchGlossary}
            onChange={e => setSearchGlossary(e.target.value)}
            placeholder="Search terms…"
            className={PLAIN_INPUT}
          />
        </div>

        {/* Entry list */}
        <div className="max-h-60 overflow-y-auto space-y-1 mb-3">
          {memLoading ? (
            <p className={MUTED}>Loading…</p>
          ) : memory.length === 0 ? (
            <p className={MUTED}>No terms yet. Import the preset or add your own below.</p>
          ) : (
            memory
              .filter(f => !searchGlossary || f.toLowerCase().includes(searchGlossary.toLowerCase()))
              .map(fact => (
                <div key={fact} className="flex items-center gap-2 group px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-zinc-800/60">
                  <span className="flex-1 text-xs font-mono text-gray-700 dark:text-zinc-300 truncate">{fact}</span>
                  <button
                    onClick={() => handleDeleteFact(fact)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-opacity"
                    title="Remove"
                  >✕</button>
                </div>
              ))
          )}
        </div>

        {/* Add new */}
        <div className="flex gap-2">
          <input
            ref={newFactRef}
            value={newFact}
            onChange={e => setNewFact(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddFact()}
            placeholder="e.g.  小李 = Li Wei (body tech)  or  OEM = original parts only"
            className={PLAIN_INPUT}
          />
          <button
            onClick={handleAddFact}
            disabled={!newFact.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
          >Add</button>
        </div>
        <p className={`${MUTED} mt-1`}>{memory.length} terms · hover a term to remove it</p>
      </div>

      {isManager && (
        <>
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>Monthly Repair Revenue Goal</h3>
        <p className={`${MUTED} mb-4`}>
          Used by the Production Board monthly revenue progress bar. Delivered ROs are counted by delivered date; total loss is excluded.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-2 text-sm font-semibold text-gray-400 dark:text-zinc-500">$</span>
            <input
              type="number"
              min="1"
              value={monthlyRepairGoal}
              onChange={e => setMonthlyRepairGoal(e.target.value)}
              className={`${PLAIN_INPUT} pl-7`}
              placeholder="26000"
            />
          </div>
          <button
            onClick={handleSaveRevenueGoal}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg whitespace-nowrap"
          >
            Save Goal
          </button>
        </div>
        {revenueSaved && <p className="text-xs text-green-600 dark:text-emerald-400 mt-1">Saved</p>}
      </div>

      {/* API Key */}
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>Anthropic API Key</h3>
        <p className={`${MUTED} mb-4`}>
          Required for the AI Quick Update box and Meeting Import features.
          Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 underline">console.anthropic.com</a> → API Keys.
        </p>
        {keyMasked && (
          <div className={SAVED_BANNER}>
            <span className="text-sm text-green-700 dark:text-emerald-300">✓ API key saved</span>
            <button
              onClick={() => { setKeyMasked(false); clearKeyCache() }}
              className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >Replace key</button>
          </div>
        )}
        {!keyMasked && (
          <div className="flex gap-2 mb-2">
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-… (paste your key here)"
              className={INPUT}
              autoComplete="off"
            />
            <button
              onClick={handleSaveKey}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg whitespace-nowrap"
            >Save</button>
          </div>
        )}
        <button
          onClick={handleTestKey}
          disabled={testLoading}
          className={SECONDARY_BUTTON}
        >{testLoading ? 'Testing…' : '🧪 Test Connection'}</button>
        {keyStatus === 'error' && <p className="text-xs text-red-600 dark:text-red-400 mt-1">Please paste a valid key starting with sk-ant-…</p>}
        {testResult && (
          <p className={`text-xs mt-1 ${testResult.ok ? 'text-green-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{testResult.msg}</p>
        )}
      </div>

      {/* OpenAI Key (Whisper voice) */}
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>🎙 OpenAI API Key <span className="text-xs font-normal text-gray-400 dark:text-zinc-500">(Whisper voice transcription)</span></h3>
        <p className={`${MUTED} mb-4`}>
          Powers multilingual voice input — Chinese, English, Spanish auto-detected with no language selection needed.
          Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 underline">platform.openai.com</a> → API Keys.
          Cost: ~$0.006 / minute of audio.
        </p>
        {openaiMasked && (
          <div className={SAVED_BANNER}>
            <span className="text-sm text-green-700 dark:text-emerald-300">✓ OpenAI key saved</span>
            <button onClick={() => { setOpenaiMasked(false); clearOpenAIKeyCache() }} className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">Replace key</button>
          </div>
        )}
        {!openaiMasked && (
          <div className="flex gap-2 mb-2">
            <input
              type="password"
              value={openaiKey}
              onChange={e => setOpenaiKey(e.target.value)}
              placeholder="sk-… (paste your OpenAI key here)"
              className={INPUT}
              autoComplete="off"
            />
            <button onClick={handleSaveOpenAIKey} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg whitespace-nowrap">Save</button>
          </div>
        )}
        <button onClick={handleTestOpenAIKey} disabled={openaiTestLoad} className={SECONDARY_BUTTON}>
          {openaiTestLoad ? 'Testing…' : '🧪 Test Connection'}
        </button>
        {openaiStatus === 'error' && <p className="text-xs text-red-600 dark:text-red-400 mt-1">Please paste a valid key starting with sk-…</p>}
        {openaiTestRes && <p className={`text-xs mt-1 ${openaiTestRes.ok ? 'text-green-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{openaiTestRes.msg}</p>}
      </div>

      {/* Name Mappings */}
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>👥 Employee Name Mappings</h3>
        <p className={`${MUTED} mb-3`}>
          Map informal names from DingTalk notes to full employee names.<br/>
          Format: one mapping per line — <code className={CODE}>informal name = Full Name</code>
        </p>
        <textarea
          value={nameMap}
          onChange={e => setNameMap(e.target.value)}
          rows={6}
          placeholder={"Aaron = Aaron Liu\nDavid = David Martinez\n小王 = Aaron Liu\nthe painter = Carlos Reyes"}
          className={INPUT + ' resize-y'}
        />
        <p className="text-xs text-gray-400 dark:text-zinc-500 mt-1">These will be used to match names in meeting notes to actual employees.</p>
      </div>

      {/* Vendor Mappings */}
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>🏢 Sublet Vendor Mappings</h3>
        <p className={`${MUTED} mb-3`}>
          Map vendor names from meeting notes to their full company names.<br/>
          Format: <code className={CODE}>short name = Full Company Name</code>
        </p>
        <textarea
          value={vendorMap}
          onChange={e => setVendorMap(e.target.value)}
          rows={5}
          placeholder={"AC Auto = AC Auto Glass\nframe shop = Valley Frame & Alignment\nupholstery = Premium Auto Upholstery"}
          className={INPUT + ' resize-y'}
        />
      </div>

      <button
        onClick={handleSaveMappings}
        className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition-colors"
      >
        Save Mappings
      </button>
      {mapSaved && <p className="text-xs text-green-600 dark:text-emerald-400 mt-1">✓ Mappings saved</p>}

      {/* ── Regenerate Note Summaries ────────────────────────────────── */}
      <div className={CARD}>
        <h3 className={`${TITLE} mb-1`}>🔄 Regenerate Note Summaries</h3>
        <p className={`${MUTED} mb-4`}>
          Re-generates all AI daily note summaries across every active RO using the latest format (no vehicle name, keyword tags, compact bullets). Run this once after updating the summary style.
        </p>
        {regenState === null ? (
          <button
            onClick={handleRegenSummaries}
            className="px-5 py-2 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Regenerate All Summaries
          </button>
        ) : regenState.done >= regenState.total && regenState.total > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-green-600 dark:text-emerald-400 font-medium">
              ✓ Done — {regenState.total} ROs processed{regenState.errors > 0 ? `, ${regenState.errors} day(s) skipped` : ''}
            </p>
            <button
              onClick={() => setRegenState(null)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Run again
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: regenState.total ? `${(regenState.done / regenState.total) * 100}%` : '0%' }}
                />
              </div>
              <span className="text-xs text-gray-500 dark:text-zinc-400 shrink-0 tabular-nums">
                {regenState.done}/{regenState.total}
              </span>
            </div>
            {regenState.current && (
              <p className="text-xs text-gray-400 dark:text-zinc-500 animate-pulse">{regenState.current}</p>
            )}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
