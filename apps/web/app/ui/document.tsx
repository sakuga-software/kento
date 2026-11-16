import type { Handle, RemixNode } from 'remix/component'

import type { Theme } from './theme.ts'

export interface DocumentProps {
  /** The title of the page, before « · Kentō ». */
  title: string
  theme: Theme
  /** Appended to the URL of each asset, so that a new release is not read from a stale cache. */
  assetVersion: string
  children?: RemixNode
}

/** The HTML document of every screen: French, the theme on `<html>`, the shared stylesheet and scripts. */
export function Document(handle: Handle<DocumentProps>) {
  return () => {
    let { title, theme, assetVersion, children } = handle.props
    let v = encodeURIComponent(assetVersion)
    return (
      <html lang="en" data-theme={theme}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="robots" content="noindex" />
          <meta name="color-scheme" content="light dark" />
          <title>{`${title} · Kentō`}</title>
          <link rel="icon" href={`/assets/favicon.svg?v=${v}`} type="image/svg+xml" />
          <link
            rel="preload"
            href="/assets/fonts/archivo-latin-wght-normal.woff2"
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
          <link rel="stylesheet" href={`/assets/kento.css?v=${v}`} />
          {/* Blocking and tiny: it marks <html> as scripted before the first paint. */}
          <script src={`/assets/theme.js?v=${v}`}></script>
          {/* The confirmations of the destructive actions: « Cancel » and Escape. */}
          <script src={`/assets/confirm.js?v=${v}`} defer></script>
          {/* REV-91: « Menu » under 760 px, and the org switch. */}
          <script src={`/assets/frame.js?v=${v}`} defer></script>
        </head>
        <body>{children}</body>
      </html>
    )
  }
}
