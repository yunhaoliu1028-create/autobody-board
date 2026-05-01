import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
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
        try {
          const ref  = doc(db, 'users', firebaseUser.uid)
          const snap = await getDoc(ref)
          if (snap.exists()) {
            setUserProfile(snap.data())
          } else {
            setUserProfile({
              email: firebaseUser.email?.toLowerCase() ?? '',
              active: false,
              missingProfile: true,
            })
          }
        } catch (err) {
          setUserProfile({
            email: firebaseUser.email?.toLowerCase() ?? '',
            active: false,
            profileError: err.message,
          })
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
    isActive: Boolean(user && userProfile && userProfile.active !== false && !userProfile.missingProfile),
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
