import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react'
import { useAuth } from './AuthContext'

const ThemeContext = createContext(null)
const FALLBACK_THEME_KEY = 'autobody_theme'

function themeKey(uid) {
  return uid ? `autobody_theme_${uid}` : FALLBACK_THEME_KEY
}

function getStoredTheme(uid) {
  try {
    return localStorage.getItem(themeKey(uid)) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(value) {
  const isDark = value === 'dark'
  const root = document.documentElement
  const body = document.body

  root.classList.toggle('dark', isDark)
  body?.classList.toggle('dark', isDark)
  root.dataset.theme = value
  root.style.colorScheme = value
  if (body) body.style.colorScheme = value
}

export function ThemeProvider({ children }) {
  const { user } = useAuth()
  const uid = user?.uid ?? null
  const [theme, setThemeState] = useState(() => getStoredTheme(uid))

  useEffect(() => {
    setThemeState(getStoredTheme(uid))
  }, [uid])

  useLayoutEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const syncFromStorage = (event) => {
      if (!event || event.key === themeKey(uid)) setThemeState(getStoredTheme(uid))
    }
    window.addEventListener('storage', syncFromStorage)
    window.addEventListener('focus', syncFromStorage)
    return () => {
      window.removeEventListener('storage', syncFromStorage)
      window.removeEventListener('focus', syncFromStorage)
    }
  }, [uid])

  const setTheme = (value) => {
    const next = value === 'dark' ? 'dark' : 'light'
    try {
      localStorage.setItem(themeKey(uid), next)
    } catch { /* ignore */ }
    applyTheme(next)
    setThemeState(next)
  }

  const toggle = () => setTheme(theme === 'dark' ? 'light' : 'dark')
  const dark = theme === 'dark'

  return (
    <ThemeContext.Provider value={{ dark, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
