import { useEffect, useState } from 'react'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { saveApiKey, getApiKey, clearKeyCache, saveOpenAIKey, getOpenAIKey, clearOpenAIKeyCache } from '../hooks/useAI'
import { MANAGER_ROLES, ROLE_LABELS } from '../constants/roles'

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const MONO_INPUT = INPUT + ' font-mono'

export default function Settings() {
  const { user, userProfile, role, refreshProfile } = useAuth()
  const { dark, setTheme } = useTheme()
  const isManager = MANAGER_ROLES.includes(role)

  const [profile, setProfile] = useState({ name: '', phone: '' })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

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

  useEffect(() => {
    setProfile({
      name: userProfile?.name ?? user?.displayName ?? '',
      phone: userProfile?.phone ?? user?.phoneNumber ?? '',
    })
  }, [userProfile, user])

  useEffect(() => {
    if (isManager) loadAISettings()
  }, [isManager])

  const loadAISettings = async () => {
    const snap = await getDoc(doc(db, 'settings', 'ai'))
    if (snap.exists()) {
      const d = snap.data()
      if (d.anthropicKey) { setApiKey(''); setKeyMasked(true) }
      if (d.openaiKey)    { setOpenaiKey(''); setOpenaiMasked(true) }
      if (d.nameMap)      setNameMap(d.nameMap)
      if (d.vendorMap)    setVendorMap(d.vendorMap)
    }
  }

  const handleSaveProfile = async (e) => {
    e.preventDefault()
    if (!user) return
    setProfileSaving(true)
    try {
      await setDoc(doc(db, 'users', user.uid), {
        name: profile.name.trim() || user.phoneNumber || user.email || 'Employee',
        phone: profile.phone.trim(),
        email: user.email ?? userProfile?.email ?? '',
        active: userProfile?.active ?? true,
        role: userProfile?.role ?? 'body_man',
        updatedAt: serverTimestamp(),
      }, { merge: true })
      await refreshProfile()
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2500)
    } finally {
      setProfileSaving(false)
    }
  }

  const handleSaveKey = async () => {
    if (!apiKey.trim() || apiKey.includes('•')) { setKeyStatus('error'); return }
    if (!apiKey.startsWith('sk-ant-') && !apiKey.startsWith('sk-')) { setKeyStatus('error'); return }
    await saveApiKey(apiKey)
    setApiKey('')
    setKeyMasked(true)
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
      if (res.ok) setTestResult({ ok: true, msg: 'API key is working.' })
      else {
        const err = await res.json()
        setTestResult({ ok: false, msg: err.error?.message ?? 'Invalid key' })
      }
    } catch (e) {
      setTestResult({ ok: false, msg: e.message })
    } finally {
      setTestLoading(false)
    }
  }

  const handleSaveOpenAIKey = async () => {
    if (!openaiKey.trim() || openaiKey.includes('•')) { setOpenaiStatus('error'); return }
    if (!openaiKey.startsWith('sk-')) { setOpenaiStatus('error'); return }
    await saveOpenAIKey(openaiKey)
    setOpenaiKey('')
    setOpenaiMasked(true)
    setOpenaiStatus('saved')
    setTimeout(() => setOpenaiStatus(null), 3000)
  }

  const handleTestOpenAIKey = async () => {
    setOpenaiTestLoad(true)
    setOpenaiTestRes(null)
    try {
      const key = await getOpenAIKey()
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      })
      setOpenaiTestRes(res.ok ? { ok: true, msg: 'OpenAI key is working.' } : { ok: false, msg: 'Invalid OpenAI key' })
    } catch (e) {
      setOpenaiTestRes({ ok: false, msg: e.message })
    } finally {
      setOpenaiTestLoad(false)
    }
  }

  const handleSaveMappings = async () => {
    await setDoc(doc(db, 'settings', 'ai'), { nameMap, vendorMap }, { merge: true })
    setMapSaved(true)
    setTimeout(() => setMapSaved(false), 3000)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">Profile and workspace preferences</p>
      </div>

      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">Profile</h2>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Display Name</label>
            <input
              className={INPUT + ' dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'}
              value={profile.name}
              onChange={e => setProfile(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">Phone</label>
            <input
              className={INPUT + ' dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'}
              value={profile.phone}
              onChange={e => setProfile(prev => ({ ...prev, phone: e.target.value }))}
              placeholder="+19095940001"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-gray-500 dark:text-zinc-400">
            <div>Email: <span className="font-medium text-gray-700 dark:text-zinc-200">{user?.email || 'None'}</span></div>
            <div>Role: <span className="font-medium text-gray-700 dark:text-zinc-200">{ROLE_LABELS[role] ?? role}</span></div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={profileSaving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
            >
              {profileSaving ? 'Saving...' : 'Save Profile'}
            </button>
            {profileSaved && <span className="text-xs text-green-600">Profile saved</span>}
          </div>
        </form>
      </section>

      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3">Appearance</h2>
        <div className="inline-grid grid-cols-2 gap-1 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1">
          <button
            type="button"
            onClick={() => setTheme('light')}
            className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${
              !dark ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-100'
            }`}
          >
            Light
          </button>
          <button
            type="button"
            onClick={() => setTheme('dark')}
            className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${
              dark ? 'bg-zinc-950 text-white shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-100'
            }`}
          >
            Dark
          </button>
        </div>
      </section>

      {isManager && (
        <>
          <div className="pt-2">
            <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Manager Configuration</h2>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5">Visible to shop managers and production managers only.</p>
          </div>

          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Anthropic API Key</h3>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mb-4">Required for AI Quick Update, Chat, and Meeting Import.</p>
            {keyMasked && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-lg">
                <span className="text-sm text-green-700 dark:text-green-300">API key saved</span>
                <button onClick={() => { setKeyMasked(false); clearKeyCache() }} className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">Replace key</button>
              </div>
            )}
            {!keyMasked && (
              <div className="flex gap-2 mb-2">
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-api03-..." className={MONO_INPUT + ' dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'} autoComplete="off" />
                <button onClick={handleSaveKey} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg whitespace-nowrap">Save</button>
              </div>
            )}
            <button onClick={handleTestKey} disabled={testLoading} className="px-4 py-2 border border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 text-sm rounded-lg">
              {testLoading ? 'Testing...' : 'Test Connection'}
            </button>
            {keyStatus === 'error' && <p className="text-xs text-red-600 mt-1">Please paste a valid key starting with sk-ant-.</p>}
            {testResult && <p className={`text-xs mt-1 ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>{testResult.msg}</p>}
          </section>

          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">OpenAI API Key</h3>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mb-4">Used for Whisper voice transcription.</p>
            {openaiMasked && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-lg">
                <span className="text-sm text-green-700 dark:text-green-300">OpenAI key saved</span>
                <button onClick={() => { setOpenaiMasked(false); clearOpenAIKeyCache() }} className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">Replace key</button>
              </div>
            )}
            {!openaiMasked && (
              <div className="flex gap-2 mb-2">
                <input type="password" value={openaiKey} onChange={e => setOpenaiKey(e.target.value)} placeholder="sk-..." className={MONO_INPUT + ' dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'} autoComplete="off" />
                <button onClick={handleSaveOpenAIKey} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg whitespace-nowrap">Save</button>
              </div>
            )}
            <button onClick={handleTestOpenAIKey} disabled={openaiTestLoad} className="px-4 py-2 border border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 text-sm rounded-lg">
              {openaiTestLoad ? 'Testing...' : 'Test Connection'}
            </button>
            {openaiStatus === 'error' && <p className="text-xs text-red-600 mt-1">Please paste a valid key starting with sk-.</p>}
            {openaiTestRes && <p className={`text-xs mt-1 ${openaiTestRes.ok ? 'text-green-600' : 'text-red-600'}`}>{openaiTestRes.msg}</p>}
          </section>

          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Employee Name Mappings</h3>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">Format: one mapping per line, like <code className="bg-gray-100 dark:bg-zinc-800 px-1 rounded">lee = Lee Zhang</code></p>
            <textarea value={nameMap} onChange={e => setNameMap(e.target.value)} rows={6} placeholder={"Aaron = Aaron Liu\nDavid = David Martinez"} className={MONO_INPUT + ' resize-y dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'} />
          </section>

          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Sublet Vendor Mappings</h3>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">Format: one mapping per line, like <code className="bg-gray-100 dark:bg-zinc-800 px-1 rounded">glass = AC Auto Glass</code></p>
            <textarea value={vendorMap} onChange={e => setVendorMap(e.target.value)} rows={5} placeholder={"glass = AC Auto Glass\nframe shop = Valley Frame & Alignment"} className={MONO_INPUT + ' resize-y dark:bg-zinc-800 dark:border-zinc-700 dark:text-gray-100'} />
          </section>

          <button onClick={handleSaveMappings} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg">
            Save Mappings
          </button>
          {mapSaved && <p className="text-xs text-green-600 mt-1">Mappings saved</p>}
        </>
      )}
    </div>
  )
}
