import { useState, useEffect } from 'react'

export type ThemeId = 'dev' | 'prism'

export interface Theme {
  id: ThemeId
  label: string
  icon: string
}

export const THEMES: Theme[] = [
  { id: 'dev', label: 'DEV', icon: '◈' },
  { id: 'prism', label: 'PRISM', icon: '◇' },
]

const STORAGE_KEY = 'homunculus-theme'

const VALID_THEMES = THEMES.map((t) => t.id)

function isThemeId(v: string | null): v is ThemeId {
  return v !== null && (VALID_THEMES as string[]).includes(v)
}

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return isThemeId(saved) ? saved : 'dev'
  })

  useEffect(() => {
    const html = document.documentElement
    if (theme === 'dev') {
      html.removeAttribute('data-theme')
    } else {
      html.setAttribute('data-theme', theme)
    }
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  return [theme, setThemeState]
}
