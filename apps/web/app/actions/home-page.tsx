import type { Handle } from 'remix/component'

/** A placeholder page. The screens of Kentō arrive with milestone M3. */
export function HomePage(handle: Handle<{ version: string }>) {
  return () => (
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>Kentō</title>
      </head>
      <body>
        <main>
          <h1>Kentō</h1>
          <p>Version {handle.props.version}</p>
        </main>
      </body>
    </html>
  )
}
