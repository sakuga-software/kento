// Writes the frames of the board design/socle/ from the real components of the app, so that the
// board shows the markup and the stylesheet that the screens use.
//
//   pnpm -F @sakuga-review/web design:board
//
// Each frame is one HTML document; the board shows it in an <iframe> at its width, so that the
// media queries of the stylesheet apply as on a screen of that width.
import { mkdir, writeFile } from 'node:fs/promises'

import { renderToString } from 'remix/component/server'

import { Shell, type PageFrame, type Viewer } from '../app/ui/shell.tsx'
import { SignInPage } from '../app/ui/sign-in.tsx'
import type { Theme } from '../app/ui/theme.ts'

const OUT = new URL('../../../design/socle/frames/', import.meta.url)
// From design/socle/frames/ to the assets of the app.
const ASSETS = '../../../apps/web/public/assets/'

const admin: Viewer = { login: 'alex', name: 'Alex Martin', avatarUrl: null, role: 'admin', org: { login: 'sakuga-software' } }
const member: Viewer = { ...admin, login: 'camille', name: 'Camille', role: 'member' }

function frame(theme: Theme, viewer: Viewer | null, path: string): PageFrame {
  return { theme, version: '0.1.0', assetVersion: 'board', viewer, csrfToken: 'board', path }
}

const frames: { file: string; node: unknown }[] = [
  {
    file: 'signin-paper.html',
    node: <SignInPage theme="paper" version="0.1.0" assetVersion="board" signInHref="#" notice={null} />,
  },
  {
    file: 'signin-refused-sumi-390.html',
    node: <SignInPage theme="sumi" version="0.1.0" assetVersion="board" signInHref="#" notice="not_member" />,
  },
  {
    file: 'dashboard-admin-paper.html',
    node: (
      <Shell
        frame={frame('paper', admin, '/')}
        section="dashboard"
        title="Tableau de bord"
        lead="Ce qui tourne, ce qui a échoué, et ce que ça coûte."
        actions={<a class="button button-primary" href="#">Relancer en balanced</a>}
      >
        <section class="empty"><h2>Bientôt ici</h2><p>Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.</p></section>
      </Shell>
    ),
  },
  {
    file: 'repos-member-sumi.html',
    node: (
      <Shell
        frame={frame('sumi', member, '/repos')}
        section="repos"
        title="Repos"
        lead="Les repos de l’installation, et où en est chacun dans sa bascule."
        actions={<a class="button button-primary" href="#">Activer un repo</a>}
      >
        <section class="empty"><h2>Bientôt ici</h2><p>La liste des repos, leur mode et leur compteur de bascule s’afficheront ici.</p></section>
      </Shell>
    ),
  },
  {
    file: 'dashboard-member-paper-390.html',
    node: (
      <Shell frame={frame('paper', member, '/')} section="dashboard" title="Tableau de bord" lead="Ce qui tourne, ce qui a échoué, et ce que ça coûte.">
        <section class="empty"><h2>Bientôt ici</h2><p>Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.</p></section>
      </Shell>
    ),
  },
  {
    file: 'runners-admin-sumi-390.html',
    node: (
      <Shell frame={frame('sumi', admin, '/runners')} section="runners" title="Runners" lead="Les machines qui font les reviews." actions={<a class="button button-primary" href="#">Nouveau runner</a>}>
        <section class="empty"><h2>Bientôt ici</h2><p>Les runners, leur dernier signal et leurs jobs s’afficheront ici.</p></section>
      </Shell>
    ),
  },
]

await mkdir(OUT, { recursive: true })
for (let { file, node } of frames) {
  let html = await renderToString(node as Parameters<typeof renderToString>[0])
  html = html.replaceAll('"/assets/', `"${ASSETS}`).replace(/\?v=board/g, '')
  await writeFile(new URL(file, OUT), `<!DOCTYPE html>\n${html}\n`)
  console.log(`design/socle/frames/${file}`)
}
