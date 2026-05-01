import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../firebase/config'

const AuthContext = createContext(null)

function StartupScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-700">
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div className="text-sm font-semibold text-gray-900">Loading AutoBody Board...</div>
        <div className="mt-1 text-xs text-gray-500">Checking your sign-in session.</div>
      </div>
    </div>
  )
}

function fallbackProfile(firebaseUser) {
  const fallbackName = firebaseUser.displayName
    || firebaseUser.email?.split('@')[0]
    || firebaseUser.phoneNumber
    || 'New Employee'

  return {
    name:   fallbackName,
    email:  firebaseUser.email?.toLowerCase() ?? '',
    phone:  firebaseUser.phoneNumber ?? '',
    role:   'body_man',
    active: true,
  }
}

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [authWarning, setAuthWarning] = useState('')

  useEffect(() => {
    const timeout = setTimeout(() => {
      setAuthWarning('Firebase Auth took too long to initialize. Using local session fallback.')
      const current = auth.currentUser
      if (current) {
        setUser(current)
        setUserProfile(fallbackProfile(current))
      } else {
        setUser(null)
        setUserProfile(null)
      }
      setLoading(false)
    }, 8000)

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        clearTimeout(timeout)
        if (!firebaseUser) {
          setUser(null)
          setUserProfile(null)
          return
        }

        setUser(firebaseUser)
        const ref  = doc(db, 'users', firebaseUser.uid)
        const snap = await getDoc(ref)

        if (snap.exists()) {
          setUserProfile(snap.data())
          return
        }

        const defaultProfile = {
          ...fallbackProfile(firebaseUser),
          createdAt: serverTimestamp(),
        }

        try {
          await setDoc(ref, defaultProfile)
        } catch (err) {
          console.warn('Could not create user profile automatically', err)
        }

        setUserProfile(defaultProfile)
      } catch (err) {
        console.error('Failed to load user profile', err)
        if (firebaseUser) {
          setUser(firebaseUser)
          setUserProfile(fallbackProfile(firebaseUser))
        } else {
          setUser(null)
          setUserProfile(null)
        }
      } finally {
        setLoading(false)
      }
    })
    return () => {
      clearTimeout(timeout)
      unsub()
    }
  }, [])

  const login = (email, password) =>
    signInWithEmailAndPassword(auth, email, password)

  const logout = () => signOut(auth)

  const value = {
    user,
    userProfile,
    role: userProfile?.role ?? null,
    displayName: userProfile?.name ?? user?.email ?? user?.phoneNumber ?? '',
    loading,
    authWarning,
    login,
    logout,
    refreshProfile: async () => {
      if (!user) return
      const snap = await getDoc(doc(db, 'users', user.uid))
      if (snap.exists()) setUserProfile(snap.data())
    },
  }

  return (
    <AuthContext.Provider value={value}>
      {loading ? <StartupScreen /> : children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
