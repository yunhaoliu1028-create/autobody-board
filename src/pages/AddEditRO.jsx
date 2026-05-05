import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  doc, getDoc, addDoc, updateDoc, collection, serverTimestamp, onSnapshot,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import { useAuth } from '../contexts/AuthContext'
import { RO_STATUSES, PARTS_STATUSES, CAR_STATUSES, EDIT_RO_ROLES } from '../constants/roles'

const EMPTY = {
  roNumber:            '',
  customerName:        '',
  customerPhone:       '',
  vehicle:             '',
  vehicleColor:        '',
  vin:                 '',
  insuranceCompany:    '',
  claimNumber:         '',
  deductible:          '',
  dateIn:              '',
  promisedDate:        '',
  dropOffDate:         '',
  hasRental:           null,   // null = unknown, true = has rental, false = no rental
  carStatus:           'pending_dropoff',
  status:              'checked_in',
  assignedEstimator:   '',
  assignedBodyMan:     '',
  assignedPainter:     '',
  assignedPartsManager:'',
  laborAmount:         '',
  partsAmount:         '',
  totalAmount:         '',
  partsStatus:         'not_ordered',
  partsNotes:          '',
}

function Field({ label, children, required }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const SELECT = INPUT + ' bg-white'

export default function AddEditRO() {
  const { id }     = useParams()           // undefined → new
  const isNew      = !id || id === 'new'
  const navigate   = useNavigate()
  const { role, user } = useAuth()

  const [form,      setForm]      = useState(EMPTY)
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(!isNew)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  // Guard: only allowed roles
  useEffect(() => {
    if (!EDIT_RO_ROLES.includes(role)) navigate('/')
  }, [role, navigate])

  // Load employees for assignment dropdowns
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  // Load existing RO if editing
  useEffect(() => {
    if (isNew) return
    getDoc(doc(db, 'ros', id)).then(snap => {
      if (snap.exists()) setForm({ ...EMPTY, ...snap.data() })
      setLoading(false)
    })
  }, [id, isNew])

  const set = (field) => (e) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.roNumber.trim()) { setError('RO Number is required.'); return }
    if (!form.customerName.trim()) { setError('Customer name is required.'); return }
    setSaving(true)
    try {
      const payload = {
        ...form,
        updatedAt: serverTimestamp(),
      }
      if (isNew) {
        payload.createdAt = serverTimestamp()
        payload.createdBy = user.uid
        const ref = await addDoc(collection(db, 'ros'), payload)
        navigate(`/ro/${ref.id}`)
      } else {
        await updateDoc(doc(db, 'ros', id), payload)
        navigate(`/ro/${id}`)
      }
    } catch (err) {
      setError('Failed to save. Please try again.')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const empByRole = (targetRole) =>
    employees.filter(e => e.role === targetRole || !targetRole)

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-400">Loading…</div>
  )

  return (
    <div className="max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link to="/board" className="hover:text-blue-600">Board</Link>
        <span>›</span>
        {!isNew && (
          <>
            <Link to={`/ro/${id}`} className="hover:text-blue-600">RO #{form.roNumber}</Link>
            <span>›</span>
          </>
        )}
        <span className="font-semibold text-gray-900">{isNew ? 'New Repair Order' : 'Edit RO'}</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* RO Info */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Repair Order Info</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="RO Number" required>
              <input className={INPUT} value={form.roNumber} onChange={set('roNumber')} placeholder="e.g. 12345" />
            </Field>

            {/* CCC Date-In: locked if imported from CCC */}
            {form.cccDateIn ? (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-1">
                  CCC Date-In <span className="text-orange-400" title="Sourced from CCC – not editable">🔒</span>
                </label>
                <div className={INPUT + ' bg-gray-50 text-gray-500 cursor-not-allowed'}>{form.cccDateIn}</div>
              </div>
            ) : (
              <Field label="Date In">
                <input type="date" className={INPUT} value={form.dateIn} onChange={set('dateIn')} />
              </Field>
            )}

            {/* CCC Date-Out: locked if imported from CCC */}
            {form.cccDateOut ? (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-1">
                  CCC Date-Out <span className="text-orange-400" title="Sourced from CCC – not editable">🔒</span>
                </label>
                <div className={INPUT + ' bg-gray-50 text-gray-500 cursor-not-allowed'}>{form.cccDateOut}</div>
              </div>
            ) : (
              <Field label="Promise Date">
                <input type="date" className={INPUT} value={form.promisedDate} onChange={set('promisedDate')} />
              </Field>
            )}

            <Field label="Drop-Off Date">
              <input type="date" className={INPUT} value={form.dropOffDate} onChange={set('dropOffDate')} />
            </Field>

            <Field label="Rental Car">
              <select
                className={SELECT}
                value={form.hasRental === true ? 'yes' : form.hasRental === false ? 'no' : ''}
                onChange={e => setForm(f => ({
                  ...f,
                  hasRental: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null,
                }))}
              >
                <option value="">— Unknown —</option>
                <option value="yes">Customer has rental</option>
                <option value="no">No rental</option>
              </select>
            </Field>

            <Field label="Car Status">
              <select className={SELECT} value={form.carStatus} onChange={set('carStatus')}>
                <option value="">— Not Set —</option>
                {CAR_STATUSES.map(s => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Repair Status">
              <select className={SELECT} value={form.status} onChange={set('status')}>
                {RO_STATUSES.map(s => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        {/* Customer */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Customer</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Customer Name" required>
              <input className={INPUT} value={form.customerName} onChange={set('customerName')} placeholder="Jane Doe" />
            </Field>
            <Field label="Phone">
              <input className={INPUT} value={form.customerPhone} onChange={set('customerPhone')} placeholder="(555) 000-0000" />
            </Field>
          </div>
        </div>

        {/* Vehicle */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">
            Vehicle
            {form.cccImported && (
              <span className="ml-2 text-orange-400 font-normal normal-case text-xs">
                🔒 Some fields locked (imported from CCC)
              </span>
            )}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="col-span-2 sm:col-span-2">
              {form.cccImported ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-1">
                    Year / Make / Model <span className="text-orange-400">🔒</span>
                  </label>
                  <div className={INPUT + ' bg-gray-50 text-gray-500 cursor-not-allowed'}>{form.vehicle || '—'}</div>
                </div>
              ) : (
                <Field label="Year / Make / Model" required>
                  <input className={INPUT} value={form.vehicle} onChange={set('vehicle')} placeholder="2021 Toyota Camry" />
                </Field>
              )}
            </div>
            <Field label="Color">
              <input className={INPUT} value={form.vehicleColor} onChange={set('vehicleColor')} placeholder="White" />
            </Field>
            <div className="col-span-2 sm:col-span-3">
              {form.cccImported ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-1">
                    VIN <span className="text-orange-400">🔒</span>
                  </label>
                  <div className={INPUT + ' bg-gray-50 text-gray-500 cursor-not-allowed font-mono text-xs'}>{form.vin || '—'}</div>
                </div>
              ) : (
                <Field label="VIN">
                  <input className={INPUT} value={form.vin} onChange={set('vin')} placeholder="1HGCM82633A123456" />
                </Field>
              )}
            </div>
          </div>
        </div>

        {/* Insurance */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Insurance</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="Insurance Company">
              <input className={INPUT} value={form.insuranceCompany} onChange={set('insuranceCompany')} placeholder="State Farm" />
            </Field>
            <Field label="Claim #">
              <input className={INPUT} value={form.claimNumber} onChange={set('claimNumber')} />
            </Field>
            <Field label="Deductible ($)">
              <input type="number" className={INPUT} value={form.deductible} onChange={set('deductible')} placeholder="500" />
            </Field>
          </div>
        </div>

        {/* Financials */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Financials</h3>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Labor ($)">
              <input type="number" className={INPUT} value={form.laborAmount} onChange={set('laborAmount')} placeholder="0.00" />
            </Field>
            <Field label="Parts ($)">
              <input type="number" className={INPUT} value={form.partsAmount} onChange={set('partsAmount')} placeholder="0.00" />
            </Field>
            <Field label="Total ($)">
              <input type="number" className={INPUT} value={form.totalAmount} onChange={set('totalAmount')} placeholder="0.00" />
            </Field>
          </div>
        </div>

        {/* Assignments */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Assignments</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Estimator',    field: 'assignedEstimator',    roles: ['estimator', 'shop_manager'] },
              { label: 'Body Tech',    field: 'assignedBodyMan',       roles: ['body_man'] },
              { label: 'Painter',      field: 'assignedPainter',       roles: ['painter', 'paint_helper'] },
              { label: 'Parts Mgr',   field: 'assignedPartsManager',  roles: ['parts_manager'] },
            ].map(({ label, field, roles: r }) => (
              <Field key={field} label={label}>
                <select className={SELECT} value={form[field]} onChange={set(field)}>
                  <option value="">Unassigned</option>
                  {employees
                    .filter(e => r.includes(e.role))
                    .map(e => (
                      <option key={e.uid} value={e.uid}>{e.name}</option>
                    ))
                  }
                </select>
              </Field>
            ))}
          </div>
        </div>

        {/* Parts */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Parts</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Parts Status">
              <select className={SELECT} value={form.partsStatus} onChange={set('partsStatus')}>
                {PARTS_STATUSES.map(p => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Parts Notes">
              <input className={INPUT} value={form.partsNotes} onChange={set('partsNotes')} placeholder="Backordered items, ETA…" />
            </Field>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex gap-3 pb-6">
          <button
            type="submit" disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors"
          >
            {saving ? 'Saving…' : isNew ? 'Create RO' : 'Save Changes'}
          </button>
          <Link
            to={isNew ? '/' : `/ro/${id}`}
            className="text-sm text-gray-600 hover:text-gray-800 px-4 py-2.5 border border-gray-300 rounded-lg transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
