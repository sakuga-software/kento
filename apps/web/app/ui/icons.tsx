import type { Handle } from 'remix/component'

// Line icons on a 24 px grid, 1.75 px stroke, in the colour of the text. They are decorative: the
// text beside them names the action, so each one is aria-hidden.

function icon(paths: string[]) {
  return function Icon(_handle: Handle<{}>) {
    return () => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {paths.map((d) => (
          <path d={d} />
        ))}
      </svg>
    )
  }
}

export const DashboardIcon = icon(['M4 13h6V4H4z', 'M14 20h6v-9h-6z', 'M4 20h6v-3H4z', 'M14 7h6V4h-6z'])
export const ReposIcon = icon([
  'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z',
  'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
  'M9 7h6',
])
export const FindingsIcon = icon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-5-5', 'M11 8v3', 'M11 14h.01'])
export const RunnersIcon = icon(['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M8 8h.01', 'M8 16h.01', 'M12 8h4', 'M12 16h4'])
export const SettingsIcon = icon([
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
])
export const EyeIcon = icon(['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'])
export const AlertIcon = icon(['M12 3l10 18H2z', 'M12 10v4', 'M12 17h.01'])
export const CheckIcon = icon(['M20 6L9 17l-5-5'])
export const ExternalIcon = icon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'])
export const SignOutIcon = icon(['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'])

/** The mark of Kentō: the corner notch (kagi kentō) that registers a woodblock print. */
export function MarkGlyph(_handle: Handle<{}>) {
  return () => (
    <svg class="mark-glyph" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="26" height="26" rx="6" fill="currentColor" />
      <path d="M9 8v11h11" class="mark-notch" />
      <path d="M14 8h6" class="mark-notch" />
    </svg>
  )
}

/** The GitHub mark, for the sign-in button. */
export function GitHubIcon(_handle: Handle<{}>) {
  return () => (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  )
}
