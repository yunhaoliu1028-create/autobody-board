import { useEffect, useState } from 'react'
import {
  collection, onSnapshot, doc, updateDoc, addDoc, serverTimestamp, setDoc,
} from 'firebase/firestore'
import {
  createUserWithEmailAndPassword, sendPasswordResetEmail,
} from 'firebase/auth'
import { db, auth, secondaryAuth } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { MANAGER_ROLES, ROLES, ROLE_LABELS } from '../constants/roles'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([k, v]) => ({ key: k, label: v }))

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function Admin() {
  const { role } = useAuth()
  const navigate  = useNavigate()

  const [employees, setEmployees] = useState([])
  const [showAdd,   setShowAdd]   = useState(false)
  const [form,      setForm]      = useState({ name: '', email: '', role: 'body_man', phone: '' })
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState('')

  useEffect(() => {
    if (!MANAGER_ROLES.includes(role)) navigate('/')
  }, [role, navigate])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  const set = (field) => (e) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }))

  const handleAddEmployee = async (e) => {
    e.preventDefault()
    setError(''); setSuccess('')
    if (!form.name.trim() || !form.email.trim()) {
      setError('Name and email are required.')
      return
    }
    setSaving(true)
    try {
      // Create Firebase Auth account with a temp password
      const tempPassword = `AutoBody${Math.random().toString(36).slice(2, 8)}!`
      // Use secondaryAuth so the current admin stays logged in
      const cred = await createUserWithEmailAndPassword(secondaryAuth, form.email.trim(), tempPassword)
      await secondaryAuth.signOut()
      // Save user profile in Firestore
      await setDoc(doc(db, 'users', cred.user.uid), {
        name:      form.name.trim(),
        email:     form.email.trim().toLowerCase(),
        role:      form.role,
        phone:     form.phone.trim(),
        active:    true,
        createdAt: serverTimestamp(),
      })
      // Send password reset so they can set their own
      await sendPasswordResetEmail(auth, form.email.trim())
      setSuccess(`✓ Account created for ${form.name}. A password-setup email was sent to ${form.email}.`)
      setForm({ name: '', email: '', role: 'body_man', phone: '' })
      setShowAdd(false)
    } catch (err) {
      setError(err.message ?? 'Failed to create account.')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (uid, currentActive) => {
    await updateDoc(doc(db, 'users', uid), { active: !currentActive })
  }

  const changeRole = async (uid, newRole) => {
    await updateDoc(doc(db, 'users', uid), { role: newRole })
  }

  const sendReset = async (email) => {
    await sendPasswordResetEmail(auth, email)
    setSuccess(`Password reset email sent to ${email}`)
  }

  const roleColor = {
    shop_manager:       'bg-blue-100 text-blue-800',
    production_manager: 'bg-indigo-100 text-indigo-800',
    estimator:          'bg-purple-100 text-purple-800',
    body_man:           'bg-orange-100 text-orange-800',
    painter:            'bg-yellow-100 text-yellow-800',
    paint_helper:       'bg-amber-100 text-amber-800',
    parts_manager:      'bg-green-100 text-green-800',
  }

  const active   = employees.filter(e => e.active !== false)
  const inactive = employees.filter(e => e.active === false)

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Team Management</h1>
          <p className="text-sm text-gray-500">{active.length} active · {inactive.length} inactive</p>
        </div>
        <button
          onClick={() => setShowAdd(v => !v)}
          className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Employee
        </button>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Add employee form */}
      {showAdd && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-blue-900 mb-4">New Employee Account</h3>
          <form onSubmit={handleAddEmployee}>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Full Name *</label>
                <input className={INPUT} value={form.name} onChange={set('name')} placeholder="John Smith" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
                <input type="email" className={INPUT} value={form.email} onChange={set('email')} placeholder="john@shop.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Role *</label>
                <select className={INPUT + ' bg-white'} value={form.role} onChange={set('role')}>
                  {ROLE_OPTIONS.map(r => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
                <input className={INPUT} value={form.phone} onChange={set('phone')} placeholder="(555) 000-0000" />
              </div>
            </div>
            <p className="text-xs text-blue-600 mb-4">
              ℹ A password-setup email will be sent to the employee automatically.
            </p>
            <div className="flex gap-2">
              <button
                type="submit" disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg"
              >
                {saving ? 'Creating…' : 'Create Account'}
              </button>
              <button
                type="button" onClick={() => { setShowAdd(false); setError('') }}
                className="text-sm text-gray-600 hover:text-gray-800 px-4 py-2 border border-gray-300 rounded-lg"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Employee table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {employees.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">No employees yet.</td>
              </tr>
            )}
            {employees.map(emp => (
              <tr key={emp.uid} className={emp.active === false ? 'opacity-50' : ''}>
                <td className="px-4 py-3 font-medium text-gray-900">{emp.name}</td>
                <td className="px-4 py-3">
                  <select
                    value={emp.role}
                    onChange={e => changeRole(emp.uid, e.target.value)}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border-0 focus:ring-2 focus:ring-blue-500 ${roleColor[emp.role] ?? 'bg-gray-100 text-gray-700'}`}
                  >
                    {ROLE_OPTIONS.map(r => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{emp.email}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                    ${emp.active !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {emp.active !== false ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right flex justify-end gap-2">
                  <button
                    onClick={() => sendReset(emp.email)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Reset Password
                  </button>
                  <button
                    onClick={() => toggleActive(emp.uid, emp.active !== false)}
                    className="text-xs text-gray-500 hover:text-gray-800"
                  >
                    {emp.active !== false ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
