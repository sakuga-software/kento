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
import type { RunnersScreen } from '../app/runner/admin.ts'
import { RunnersPage } from '../app/ui/runners.tsx'

const OUT = new URL('../../../design/socle/frames/', import.meta.url)
// From design/socle/frames/ to the assets of the app.
const ASSETS = '../../../apps/web/public/assets/'

const admin: Viewer = { login: 'alex', name: 'Alex Martin', avatarUrl: null, role: 'admin', org: { id: 'org-1', login: 'sakuga-software' }, orgs: [{ id: 'org-1', login: 'sakuga-software' }] }
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

// The Runners screen (REV-10), with the states that the ticket names.
const RUNNERS_OUT = new URL('../../../design/runners/frames/', import.meta.url)
const now = new Date('2026-10-29T10:00:00Z')
const minutes = (n: number) => new Date(now.getTime() - n * 60_000)
const runnersScreen: RunnersScreen = {
  now,
  registrations: [
    { id: '00000000-0000-4000-8000-000000000001', name: 'gpu-scaleway', labels: ['gpu', 'linux'], trusted: false, expiresAt: new Date(now.getTime() + 42 * 60_000), createdAt: minutes(18) },
    { id: '00000000-0000-4000-8000-000000000002', name: 'poste-camille', labels: ['local'], trusted: true, expiresAt: minutes(95), createdAt: minutes(155) },
  ],
  runners: [
    { id: '00000000-0000-4000-8000-000000000010', name: 'mac-mini', labels: ['macos', 'arm64'], version: '0.1.0', trusted: true, orgId: 'org-1', revokedAt: null, lastSeenAt: new Date(now.getTime() - 12_000), createdAt: minutes(3000), currentJob: { kind: 'review', repo: 'sakuga-software/sakuga-review', prNumber: 57, startedAt: minutes(2) }, jobs24h: 14 },
    { id: '00000000-0000-4000-8000-000000000011', name: 'runners-host', labels: ['linux', 'x64'], version: '0.1.0', trusted: true, orgId: null, revokedAt: null, lastSeenAt: new Date(now.getTime() - 25_000), createdAt: minutes(9000), currentJob: null, jobs24h: 31 },
    { id: '00000000-0000-4000-8000-000000000012', name: 'portable-alex', labels: ['local'], version: '0.0.9', trusted: false, orgId: 'org-1', revokedAt: null, lastSeenAt: minutes(47), createdAt: minutes(6000), currentJob: null, jobs24h: 2 },
    { id: '00000000-0000-4000-8000-000000000013', name: 'gpu-test', labels: ['gpu'], version: '0.1.0', trusted: false, orgId: 'org-1', revokedAt: null, lastSeenAt: minutes(60 * 24 * 4), createdAt: minutes(60 * 24 * 9), currentJob: null, jobs24h: 0 },
    { id: '00000000-0000-4000-8000-000000000014', name: 'ancien-mac', labels: ['macos'], version: '0.0.8', trusted: false, orgId: 'org-1', revokedAt: minutes(60 * 30), lastSeenAt: minutes(60 * 31), createdAt: minutes(60 * 24 * 20), currentJob: null, jobs24h: 0 },
  ],
}
const kentoUrl = 'https://review.sakuga.dev'
const created = { name: 'mac-mini-2', labels: ['macos', 'arm64'], trusted: true, token: 'kento_reg_EXAMPLE-not-a-real-token-0000000000000', expiresAt: new Date(now.getTime() + 60 * 60_000) }
const runnersFrames: { file: string; node: unknown }[] = [
  { file: 'runners-admin-paper.html', node: <RunnersPage frame={frame('paper', admin, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} /> },
  { file: 'runners-admin-token-sumi.html', node: <RunnersPage frame={frame('sumi', admin, '/runners')} screen={{ ...runnersScreen, registrations: [] }} version="0.1.0" kentoUrl={kentoUrl} created={created} /> },
  { file: 'runners-member-sumi-390.html', node: <RunnersPage frame={frame('sumi', member, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} /> },
  { file: 'runners-admin-paper-390.html', node: <RunnersPage frame={frame('paper', admin, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} notice="revoked" /> },
  {
    file: 'runners-admin-empty-sumi.html',
    node: (
      <RunnersPage
        frame={frame('sumi', admin, '/runners')}
        screen={{ now, registrations: [], runners: [] }}
        version="0.1.0"
        kentoUrl={kentoUrl}
        form={{ values: { name: 'mac mini', labels: 'macos', keyMode: 'app' }, errors: { name: 'Lettres, chiffres, points, tirets ou soulignés, 100 au plus.' } }}
      />
    ),
  },
]

async function writeFrames(out: URL, assets: string, list: { file: string; node: unknown }[], label: string) {
  await mkdir(out, { recursive: true })
  for (let { file, node } of list) {
    let html = await renderToString(node as Parameters<typeof renderToString>[0])
    html = html.replaceAll('"/assets/', `"${assets}`).replace(/\?v=board/g, '')
    await writeFile(new URL(file, out), `<!DOCTYPE html>\n${html}\n`)
    console.log(`${label}${file}`)
  }
}

await writeFrames(OUT, ASSETS, frames, 'design/socle/frames/')
await writeFrames(RUNNERS_OUT, ASSETS, runnersFrames, 'design/runners/frames/')
