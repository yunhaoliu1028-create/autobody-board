import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth'
import { useAuth } from '../contexts/AuthContext'
import { auth } from '../firebase/config'

export default function Login() {
  const [mode,     setMode]     = useState('email')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [phone,    setPhone]    = useState('')
  const [code,     setCode]     = useState('')
  const [confirm,  setConfirm]  = useState(null)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const recaptchaRef = useRef(null)
  const { login } = useAuth()
  const navigate  = useNavigate()

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError('')
    setConfirm(null)
    setCode('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email.trim(), password)
      navigate('/')
    } catch (err) {
      console.error('Firebase login error:', err.code, err.message)
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

  const getRecaptcha = () => {
    if (recaptchaRef.current) return recaptchaRef.current
    recaptchaRef.current = new RecaptchaVerifier(auth, 'phone-recaptcha', {
      size: 'invisible',
      callback: () => {},
    })
    return recaptchaRef.current
  }

  const handleSendCode = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const normalizedPhone = phone.trim().replace(/[^\d+]/g, '')
      if (!normalizedPhone.startsWith('+')) throw new Error('Use format like +19095940001.')
      const confirmation = await signInWithPhoneNumber(auth, normalizedPhone, getRecaptcha())
      setPhone(normalizedPhone)
      setConfirm(confirmation)
    } catch (err) {
      console.error('Phone sign-in error:', err.code, err.message)
      setError({
        'auth/invalid-phone-number': 'Use format like +19095940001.',
        'auth/too-many-requests': 'Too many attempts. Please wait a few minutes.',
        'auth/quota-exceeded': 'SMS quota exceeded. Test numbers should not use quota.',
        'auth/captcha-check-failed': 'reCAPTCHA check failed. Refresh and try again.',
      }[err.code] ?? err.message ?? 'Could not send verification code.')
      recaptchaRef.current?.clear?.()
      recaptchaRef.current = null
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyCode = async (e) => {
    e.preventDefault()
    if (!confirm) return
    setError('')
    setLoading(true)
    try {
      await confirm.confirm(code.trim())
      navigate('/')
    } catch (err) {
      console.error('Phone verification error:', err.code, err.message)
      setError({
        'auth/invalid-verification-code': 'Wrong verification code.',
        'auth/code-expired': 'Code expired. Send a new code.',
      }[err.code] ?? err.message ?? 'Could not verify code.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-700 to-blue-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🔧</div>
          <h1 className="text-2xl font-bold text-white">AutoBody Production Board</h1>
          <p className="text-blue-200 text-sm mt-1">Sign in to your workspace</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="grid grid-cols-2 gap-1 bg-gray-100 rounded-lg p-1 mb-5">
            <button
              type="button"
              onClick={() => switchMode('email')}
              className={`py-2 rounded-md text-sm font-semibold transition-colors ${
                mode === 'email' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => switchMode('phone')}
              className={`py-2 rounded-md text-sm font-semibold transition-colors ${
                mode === 'phone' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Phone
            </button>
          </div>

          {mode === 'email' ? (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
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
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={confirm ? handleVerifyCode : handleSendCode} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  disabled={!!confirm}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm disabled:bg-gray-50"
                  placeholder="+19095940001"
                  autoComplete="tel"
                />
              </div>

              {confirm && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Verification Code</label>
                  <input
                    required
                    inputMode="numeric"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    placeholder="111111"
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
                {loading ? 'Please wait...' : confirm ? 'Verify & Sign In' : 'Send Code'}
              </button>

              {confirm && (
                <button
                  type="button"
                  onClick={() => { setConfirm(null); setCode(''); setError('') }}
                  className="w-full text-sm text-gray-500 hover:text-gray-700"
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
