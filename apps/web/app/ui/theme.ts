import { isOneOf } from '@kento/protocol'

/** Paper (day), Sumi (night), or the theme of the device. */
export type Theme = 'paper' | 'sumi' | 'system'

export const THEMES: readonly Theme[] = ['paper', 'sumi', 'system']

export const THEME_LABELS: Record<Theme, string> = {
  paper: 'Paper',
  sumi: 'Sumi',
  system: 'Device',
}

/** The cookie of this browser that holds the theme. Not a secret: public/assets/theme.js writes it too. */
export const THEME_COOKIE = 'kento_theme'

/** A year, as in public/assets/theme.js. */
const THEME_COOKIE_MAX_AGE = 31_536_000

export function isTheme(value: unknown): value is Theme {
  return isOneOf(THEMES, value)
}

/** The theme of a request: its cookie, else the theme of the device. */
export function readTheme(cookieHeader: string | null): Theme {
  if (!cookieHeader) return 'system'
  for (let part of cookieHeader.split(';')) {
    let [name, value] = part.trim().split('=')
    if (name === THEME_COOKIE && isTheme(value)) return value
  }
  return 'system'
}

/** The `Set-Cookie` value of a theme, as public/assets/theme.js writes it. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}
