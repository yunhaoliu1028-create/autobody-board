import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [mode,     setMode]     = useState('email')
  const [phone,    setPhone]    = useState('')
  const [code,     setCode]     = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const { login, sendPhoneCode } = useAuth()
  const navigate  = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email.trim(), password)
      navigate('/')
    } catch (err) {
      console.error('Firebase login error:', err.code, err.message)
      // Show the actual Firebase error code to help debug
      const msg = {
        'auth/invalid-credential':    'Wrong email or password.',
        'auth/user-not-found':        'No account found with this email.',
        'auth/wrong-password':        'Incorrect password.',
        'auth/invalid-email':         'Invalid email format.',
        'auth/user-disabled':         'This account has been disabled.',
        'auth/too-many-requests':     'Too many attempts. Please wait a few minutes.',
        'auth/network-request-failed':'Network error. Check your connection.',
      }[err.code] ?? `Error: ${err.code}`
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const formatPhone = (value) => {
    const trimmed = value.trim()
    if (trimmed.startsWith('+')) return trimmed
    const digits = trimmed.replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    return trimmed
  }

  const handleSendCode = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await sendPhoneCode(formatPhone(phone), 'phone-recaptcha')
      setConfirmation(result)
    } catch (err) {
      console.error('Firebase phone login error:', err.code, err.message)
      const msg = {
        'auth/invalid-phone-number': 'Enter a valid phone number, for example +16041234567.',
        'auth/missing-phone-number': 'Phone number is required.',
        'auth/quota-exceeded':       'SMS quota exceeded. Try again later.',
        'auth/too-many-requests':    'Too many attempts. Please wait a few minutes.',
        'auth/captcha-check-failed': 'Verification failed. Please try again.',
      }[err.code] ?? `Error: ${err.code}`
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyCode = async (e) => {
    e.preventDefault()
    if (!confirmation) return
    setError('')
    setLoading(true)
    try {
      await confirmation.confirm(code.trim())
      navigate('/')
    } catch (err) {
      console.error('Firebase phone code error:', err.code, err.message)
      const msg = {
        'auth/invalid-verification-code': 'Wrong verification code.',
        'auth/code-expired':              'Code expired. Please send a new code.',
      }[err.code] ?? `Error: ${err.code}`
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError('')
    setConfirmation(null)
    setCode('')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-700 to-blue-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🔧</div>
          <h1 className="text-2xl font-bold text-white">AutoBody Production Board</h1>
          <p className="text-blue-200 text-sm mt-1">Sign in to your workspace</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="grid grid-cols-2 gap-1 bg-gray-100 rounded-lg p-1 mb-6">
            <button
              type="button"
              onClick={() => switchMode('email')}
              className={`py-2 text-sm font-medium rounded-md transition-colors ${
                mode === 'email' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => switchMode('phone')}
              className={`py-2 text-sm font-medium rounded-md transition-colors ${
                mode === 'phone' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              Phone
            </button>
          </div>

          {mode === 'email' ? (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  placeholder="you@shop.com"
                  autoComplete="email"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={confirmation ? handleVerifyCode : handleSendCode} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone number
                </label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  placeholder="+1 604 123 4567"
                  autoComplete="tel"
                  disabled={!!confirmation}
                />
              </div>

              {confirmation && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Verification code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    placeholder="6-digit code"
                    autoComplete="one-time-code"
                  />
                </div>
              )}

              <div id="phone-recaptcha" />

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                {loading ? 'Please wait…' : confirmation ? 'Verify Code' : 'Send Code'}
              </button>

              {confirmation && (
                <button
                  type="button"
                  onClick={() => { setConfirmation(null); setCode(''); setError('') }}
                  className="w-full text-sm text-blue-600 hover:text-blue-700"
                >
                  Use a different phone number
                </button>
              )}
            </form>
          )}
        </div>

        <p className="text-center text-blue-300 text-xs mt-6">
          Contact your manager if you need access
        </p>
      </div>
    </div>
  )
}
