import type { Handle } from 'remix/component'
import { createController } from 'remix/router'

import { pageRoutes } from '../routes.ts'
import { securityHeaders } from './security-headers.ts'
import { Shell, type PageFrame, type Section } from './shell.tsx'
import { isTheme, readTheme, themeCookie } from './theme.ts'

export interface PagesDependencies {
  version: string
  /** The commit of the image, when the build gives it: it versions the URLs of the assets. */
  commit: string | null
}

/**
 * The screens of milestone M3. Each one is a frame with an empty state until its own ticket fills
 * it: REV-14 the dashboard, REV-9 the repos, REV-18 the findings, REV-10 the runners, REV-13 the
 * settings of the org.
 */
const PLACEHOLDERS: Record<Section, { title: string; lead: string; empty: string }> = {
  dashboard: {
    title: 'Tableau de bord',
    lead: 'Ce qui tourne, ce qui a échoué, et ce que ça coûte.',
    empty: 'Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.',
  },
  repos: {
    title: 'Repos',
    lead: 'Les repos de l’installation, et où en est chacun dans sa bascule.',
    empty: 'La liste des repos, leur mode et leur compteur de bascule s’afficheront ici.',
  },
  findings: {
    title: 'Findings',
    lead: 'Chaque finding, et la précision des reviews.',
    empty: 'Les findings filtrables et la précision par repo s’afficheront ici.',
  },
  runners: {
    title: 'Runners',
    lead: 'Les machines qui font les reviews.',
    empty: 'Les runners, leur dernier signal et leurs jobs s’afficheront ici.',
  },
  settings: {
    title: 'Réglages',
    lead: 'Ce qui vaut pour toute l’organisation.',
    empty: 'Le plafond de coût, les valeurs par défaut, les providers et l’état de l’App s’afficheront ici.',
  },
}

export function createPagesController(deps: PagesDependencies) {
  let assetVersion = deps.commit ?? deps.version

  function frame(context: { headers: Headers; url: URL }): PageFrame {
    return {
      theme: readTheme(context.headers.get('Cookie')),
      version: deps.version,
      assetVersion,
      viewer: null,
      csrfToken: null,
      path: context.url.pathname,
    }
  }

  return createController(pageRoutes, {
    middleware: [securityHeaders()],
    actions: {
      home(context) {
        return context.render(<PlaceholderPage frame={frame(context)} section="dashboard" />)
      },
      repos(context) {
        return context.render(<PlaceholderPage frame={frame(context)} section="repos" />)
      },
      findings(context) {
        return context.render(<PlaceholderPage frame={frame(context)} section="findings" />)
      },
      runners(context) {
        return context.render(<PlaceholderPage frame={frame(context)} section="runners" />)
      },
      settings(context) {
        return context.render(<PlaceholderPage frame={frame(context)} section="settings" />)
      },

      // The theme form, for a browser without JavaScript: public/assets/theme.js does the same at once.
      async theme(context) {
        let form = await context.request.formData().catch(() => null)
        let theme = form?.get('theme')
        let returnTo = localPath(form?.get('returnTo'))
        let headers = new Headers({ Location: returnTo })
        if (isTheme(theme)) headers.append('Set-Cookie', themeCookie(theme, context.url.protocol === 'https:'))
        return new Response(null, { status: 303, headers })
      },
    },
  })
}

/** A path of this site, or `/`: never another origin (`//host`, `/\host`, a scheme). */
export function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    let url = new URL(value, 'http://kento.invalid')
    return url.origin === 'http://kento.invalid' ? `${url.pathname}${url.search}` : '/'
  } catch {
    return '/'
  }
}

function PlaceholderPage(handle: Handle<{ frame: PageFrame; section: Section }>) {
  return () => {
    let { frame, section } = handle.props
    let page = PLACEHOLDERS[section]
    return (
      <Shell frame={frame} section={section} title={page.title} lead={page.lead}>
        <section class="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Bientôt ici</h2>
          <p>{page.empty}</p>
        </section>
      </Shell>
    )
  }
}
