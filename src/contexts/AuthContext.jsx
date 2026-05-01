import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../firebase/config'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser)
        // Fetch role + profile from Firestore
        const ref  = doc(db, 'users', firebaseUser.uid)
        const snap = await getDoc(ref)
        if (snap.exists()) {
          setUserProfile(snap.data())
        } else {
          // First login — auto-create a default profile so they appear in Team Management
          const defaultProfile = {
            name:      firebaseUser.displayName || firebaseUser.email.split('@')[0],
            email:     firebaseUser.email.toLowerCase(),
            role:      'body_man',   // manager can change this via Team page
            active:    true,
            createdAt: serverTimestamp(),
          }
          await setDoc(ref, defaultProfile)
          setUserProfile(defaultProfile)
        }
      } else {
        setUser(null)
        setUserProfile(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  const login = (email, password) =>
    signInWithEmailAndPassword(auth, email, password)

  const logout = () => signOut(auth)

  const value = {
    user,
    userProfile,
    role: userProfile?.role ?? null,
    displayName: userProfile?.name ?? user?.email ?? '',
    loading,
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
      {!loading && children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
