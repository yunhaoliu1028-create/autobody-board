import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Login         from './pages/Login'
import ROBoard       from './pages/ROBoard'
import RODetail      from './pages/RODetail'
import AddEditRO     from './pages/AddEditRO'
import TaskBoard     from './pages/TaskBoard'
import Admin         from './pages/Admin'
import MeetingImport from './pages/MeetingImport'
import Settings      from './pages/Settings'
import Chat          from './pages/Chat'
import { ToastProvider } from './components/Toast'
import AppErrorBoundary from './components/AppErrorBoundary'
import { MANAGER_ROLES } from './constants/roles'

function AppRoutes() {
  const { user } = useAuth()

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />

      <Route path="/" element={
        <ProtectedRoute><Layout><ROBoard /></Layout></ProtectedRoute>
      } />
      <Route path="/ro/new" element={
        <ProtectedRoute><Layout><AddEditRO /></Layout></ProtectedRoute>
      } />
      <Route path="/ro/:id" element={
        <ProtectedRoute><Layout><RODetail /></Layout></ProtectedRoute>
      } />
      <Route path="/ro/:id/edit" element={
        <ProtectedRoute><Layout><AddEditRO /></Layout></ProtectedRoute>
      } />
      <Route path="/tasks" element={
        <ProtectedRoute><Layout><TaskBoard /></Layout></ProtectedRoute>
      } />
      <Route path="/meeting" element={
        <ProtectedRoute allowedRoles={MANAGER_ROLES}>
          <Layout><MeetingImport /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/settings" element={
        <ProtectedRoute>
          <Layout><Settings /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/admin" element={
        <ProtectedRoute allowedRoles={MANAGER_ROLES}>
          <Layout><Admin /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/chat" element={
        <ProtectedRoute><Layout><Chat /></Layout></ProtectedRoute>
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </AppErrorBoundary>
  )
}
