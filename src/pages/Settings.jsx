import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { saveApiKey, getApiKey, clearKeyCache, saveOpenAIKey, getOpenAIKey, clearOpenAIKeyCache } from '../hooks/useAI'
import { MANAGER_ROLES } from '../constants/roles'

const INPUT = 'w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono'
const PLAIN_INPUT = 'w-full border border-gray-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-950 text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500'
const CARD = 'bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5'
const TITLE = 'text-sm font-semibold text-gray-800 dark:text-zinc-100'
const MUTED = 'text-xs text-gray-500 dark:text-zinc-400'
const LABEL = 'block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1'
const SECONDARY_BUTTON = 'px-4 py-2 border border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 text-sm rounded-lg transition-colors'
const SAVED_BANNER = 'flex items-center gap-2 mb-2 px-3 py-2 bg-green-50 dark:bg-emerald-950/25 border border-green-200 dark:border-emerald-900/60 rounded-lg'
const CODE = 'bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-200 px-1 rounded'

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
  // OpenAI key (for Whisper voice transcription)
  const [openaiKey,      setOpenaiKey]      = useState('')
  const [openaiMasked,   setOpenaiMasked]   = useState(false)
  const [openaiStatus,   setOpenaiStatus]   = useState(null)
  const [openaiTestLoad, setOpenaiTestLoad] = useState(false)
  const [openaiTestRes,  setOpenaiTestRes]  = useState(null)
  const [nameMap,        setNameMap]        = useState('')
  const [vendorMap,      setVendorMap]      = useState('')
  const [mapSaved,       setMapSaved]       = useState(false)

  useEffect(() => {
    setDisplayName(userProfile?.name ?? '')
    setPhone(userProfile?.phone ?? user?.phoneNumber ?? '')
    setLanguage(userProfile?.language ?? 'english')
  }, [userProfile, user])

  useEffect(() => {
    if (isManager) loadSettings()
  }, [isManager])

  const loadSettings = async () => {
    const snap = await getDoc(doc(db, 'settings', 'ai'))
    if (snap.exists()) {
      const d = snap.data()
      if (d.anthropicKey) { setApiKey(''); setKeyMasked(true) }
      if (d.openaiKey)    { setOpenaiKey(''); setOpenaiMasked(true) }
      if (d.nameMap)      setNameMap(d.nameMap)
      if (d.vendorMap)    setVendorMap(d.vendorMap)
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

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-zinc-100">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">Profile preferences</p>
      </div>

      <div className={CARD}>
        <h3 className={`${TITLE} mb-4`}>My Profile</h3>
        <div className="space-y-4">
          <div>
            <label className={LABEL}>Display name</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className={PLAIN_INPUT}
              placeholder="Your name"
            />
          </div>
          <div>
            <label className={LABEL}>Phone</label>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className={PLAIN_INPUT}
              placeholder="+1 604 123 4567"
            />
          </div>
          <div>
            <label className={LABEL}>Language</label>
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
              {profileSaving ? 'Saving…' : 'Save Profile'}
            </button>
            {profileSaved && <span className="text-xs text-green-600 dark:text-emerald-400">✓ Saved</span>}
          </div>
        </div>
      </div>

      {isManager && (
        <>
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
        </>
      )}
    </div>
  )
}
