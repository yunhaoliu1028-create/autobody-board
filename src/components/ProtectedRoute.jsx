import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function ProtectedRoute({ children, allowedRoles }) {
  const { user, role, isActive, logout } = useAuth()

  if (!user) return <Navigate to="/login" replace />

  if (!isActive) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900">Account inactive</h1>
          <p className="mt-2 text-sm text-gray-500">
            This account is not active or has not been provisioned by a manager.
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    return <Navigate to="/" replace />
  }
  return children
}
