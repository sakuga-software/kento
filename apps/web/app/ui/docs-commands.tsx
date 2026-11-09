// REV-96. « Les commandes de Kentō »: a public page, open without a sign-in, so that the link of a
// comment of Kentō on GitHub works for every reader of the pull request. It describes `review`,
// `force`, `resolve` and `reject`: where to write them, who can run them, what they do at once and
// what the next review does with them.
import { MAX_RESOLVE_PACK_BYTES, MAX_RESOLVE_THREADS } from '@sakuga-review/protocol'
import type { Handle, RemixNode } from 'remix/component'

import { REASON_MAX } from '../findings/store.ts'
import { authRoutes } from '../routes.ts'
import { Document } from './document.tsx'
import { Logo } from './icons.tsx'
import type { Theme } from './theme.ts'

export interface CommandsPageProps {
  theme: Theme
  version: string
  assetVersion: string
}

interface Command {
  id: string
  name: string
  lead: string
  syntax: { where: string; code: string }[]
  who: string
  now: RemixNode
  next: RemixNode
  examples?: { code: string; why: string }[]
}

const WRITERS = 'Une personne qui peut écrire dans le repo (write, maintain ou admin), ou un bot que l’org a déclaré de confiance.'

const COMMANDS: Command[] = [
  {
    id: 'review',
    name: 'review',
    lead: 'Demander une review de la PR, au niveau choisi.',
    syntax: [
      { where: 'Dans la conversation de la PR', code: '@kento-review [lite|balanced|heavy]' },
      { where: 'Forme longue', code: '@kento-review review balanced' },
    ],
    who: WRITERS,
    now: (
      <>
        Kentō met la review en file et réagit 👀 sur le commentaire, puis 🚀 quand la review est publiée, ou 😕 si elle échoue.
        Sans niveau, c’est <code>lite</code>.
      </>
    ),
    next: (
      <>
        La review relit le dernier commit de la PR. Un commit qui a déjà une review à ce niveau n’est pas relu une deuxième fois : il
        faut <code>force</code>.
      </>
    ),
  },
  {
    id: 'force',
    name: 'force',
    lead: 'Payer une nouvelle review à un niveau que ce commit a déjà reçu.',
    syntax: [{ where: 'Dans la conversation de la PR', code: '@kento-review heavy force' }],
    who: WRITERS,
    now: <>Comme <code>review</code> : la review part même si le commit a déjà une review à ce niveau.</>,
    next: <>La review est payée une deuxième fois. Elle est publiée comme les autres : son bloc remplace le précédent dans la description de la PR.</>,
  },
  {
    id: 'resolve',
    name: 'resolve',
    lead: 'Répondre aux fils ouverts de Kentō, et résoudre ceux que le code règle.',
    syntax: [{ where: 'Dans la conversation de la PR', code: '@kento-review resolve [lite|balanced|heavy]' }],
    who: WRITERS,
    now: (
      <>
        Kentō lit jusqu’à {MAX_RESOLVE_THREADS} fils ouverts, dans une limite de {MAX_RESOLVE_PACK_BYTES / 1000} ko, avec le code du
        dernier commit : il répond dans chaque fil, et résout ceux que le code corrige. Les fils au-delà attendent : le résumé le dit, et
        une nouvelle commande les lit.
      </>
    ),
    next: <>Un fil auquel <code>resolve</code> a déjà répondu sur ce commit attend un nouveau push avant d’être relu.</>,
  },
  {
    id: 'reject',
    name: 'reject',
    lead: 'Écarter un constat faux, avec sa cause. Il ne revient pas tant que son fichier ne change pas, et ne compte plus dans la note.',
    syntax: [
      { where: 'En réponse, dans le fil du constat', code: '@kento-review reject <cause>' },
      { where: 'Dans la conversation, pour un constat sans fil', code: '@kento-review reject #3cf454 <cause>' },
    ],
    who: WRITERS,
    now: (
      <>
        Le constat passe en <code>dismissed</code> avec sa cause. Quand le constat a un fil, Kentō y répond et le résout ; s’il ne peut pas
        le résoudre, sa réponse le dit, et une personne le résout à la main. Si la dernière review demandait des
        changements et qu’aucun constat bloquant ne reste ouvert, Kentō retire cette demande. L’id est celui de la liste des constats, à
        la fin de la description de la PR.
      </>
    ),
    next: (
      <>
        La review suivante lit les constats écartés et leur cause : elle ne les écrit plus tant que leur fichier ne change pas, et ils ne
        comptent plus dans la note.
      </>
    ),
    examples: [
      { code: '@kento-review reject faux positif : la valeur est validée par le schéma (schema.ts:12)', why: 'Le fait qui réfute le constat, avec où le lire.' },
      { code: '@kento-review reject risque accepté : le cache est par processus, voulu (doc dans cache.ts)', why: 'Un choix voulu et déjà écrit.' },
      { code: '@kento-review reject #3cf454 même constat que le fil du dessus, déjà réfuté', why: 'Un constat qui revient avec d’autres mots.' },
    ],
  },
]

/** The public page of the commands of Kentō. */
export function CommandsPage(handle: Handle<CommandsPageProps>) {
  return () => {
    let { theme, version, assetVersion } = handle.props
    return (
      <Document title="Les commandes" theme={theme} assetVersion={assetVersion}>
        <main class="docs">
          <header class="docs-head">
            <a class="mark" href={authRoutes.signIn.href()} aria-label="Kentō, se connecter">
              <Logo />
            </a>
          </header>
          <article class="docs-body">
            <h1>Les commandes de Kentō</h1>
            <p class="docs-lead">
              Kentō lit une commande dans un commentaire d’une pull request, sur une ligne qui commence par <code>@kento-review</code>{' '}
              (<code>@sakuga-review</code> marche aussi), hors d’une citation et d’un bloc de code. Le reste du commentaire est du texte libre.
            </p>
            <nav class="docs-toc" aria-label="Commandes">
              <ul>
                {COMMANDS.map((c) => (
                  <li>
                    <a href={`#${c.id}`}>
                      <code>{c.name}</code>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {COMMANDS.map((c) => (
              <section class="docs-command" id={c.id} aria-labelledby={`${c.id}-title`}>
                <h2 id={`${c.id}-title`}>
                  <code>{c.name}</code>
                </h2>
                <p>{c.lead}</p>
                <dl class="docs-facts">
                  <div>
                    <dt>Syntaxe</dt>
                    <dd>
                      <ul class="docs-syntax">
                        {c.syntax.map((s) => (
                          <li>
                            <span>{s.where}</span>
                            <code>{s.code}</code>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  <div>
                    <dt>Qui peut la lancer</dt>
                    <dd>{c.who}</dd>
                  </div>
                  <div>
                    <dt>Effet immédiat</dt>
                    <dd>{c.now}</dd>
                  </div>
                  <div>
                    <dt>À la review suivante</dt>
                    <dd>{c.next}</dd>
                  </div>
                  {c.examples ? (
                    <div>
                      <dt>Exemples de causes</dt>
                      <dd>
                        <ul class="docs-syntax">
                          {c.examples.map((e) => (
                            <li>
                              <code>{e.code}</code>
                              <span>{e.why}</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            ))}
            <section class="docs-command" id="indice" aria-labelledby="indice-title">
              <h2 id="indice-title">Quand Kentō suggère <code>reject</code></h2>
              <p>
                Une réponse dans le fil d’un constat qui semble l’écarter sans la commande (« Not applied », « Non retenu », « Risque
                accepté »…) reçoit une fois une réponse de Kentō qui donne la commande. Cette réponse ne change rien au constat : seul{' '}
                <code>reject</code> l’écarte. Elle ne vient jamais dans un fil résolu, ni pour un constat déjà écarté.
              </p>
            </section>
            <p class="docs-note">
              La cause tient sur la ligne de la commande, en {REASON_MAX} caractères au plus. Une commande inconnue reçoit 😕 et la liste des
              commandes.
            </p>
          </article>
          <p class="signin-foot">Kentō {version} · par Sakuga</p>
        </main>
      </Document>
    )
  }
}
