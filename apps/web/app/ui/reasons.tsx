// The reasons that the service, the runner and GitHub write in English, as the screens show them:
// what happened and what to do, in French. The stored reasons and the answers of the webhook and of
// the runner API stay in English: logs, tests and the runner read them.

import type { Handle } from 'remix/component'

import { sanitizeReason } from '../publish/failure.ts'

/** A reason in words. `raw`: the text of the service, shown under « Détails techniques », or null. */
export interface Reason {
  /** What happened, from a lowercase letter, with no final period. */
  text: string
  /** What to do, as whole sentences. Empty when there is nothing to do. */
  action: string
  raw: string | null
}

/** The names that the adapters of the engine give to a provider (packages/engine/src/providers.ts). */
const PROVIDER_NAMES = 'OpenRouter|Anthropic|Ollama|The OpenAI-compatible server'
/** « ProviderError: <name> <what> », at the start of the error of the model. */
const PROVIDER_ERROR = (what: string) => new RegExp(`^ProviderError: (?:${PROVIDER_NAMES}) ${what}`)

const TIMES: Record<number, string> = { 1: 'une fois', 2: 'deux fois', 3: 'trois fois' }

/** What a provider status means for a job, and what to do. */
function providerStatus(status: number): Omit<Reason, 'raw'> {
  if (status === 401 || status === 403) {
    return { text: `le provider a refusé la clé, code ${status}`, action: 'Remplacez la clé dans Réglages, ou PROVIDER_API_KEY sur le runner, puis relancez.' }
  }
  if (status === 404) return { text: 'le provider ne connaît pas le modèle demandé, code 404', action: 'Vérifiez l’id du modèle dans la config du repo, puis relancez.' }
  if (status === 429) return { text: 'le provider limite le nombre d’appels, code 429', action: 'Relancez dans quelques minutes, ou relevez la limite chez le provider.' }
  if (status >= 500) return { text: `le provider est indisponible ou surchargé, code ${status}`, action: 'Relancez dans quelques minutes.' }
  return { text: `le provider a refusé la demande, code ${status}`, action: 'Lisez les détails techniques, puis vérifiez le modèle dans la config du repo.' }
}

/**
 * The reason of a failed job. The service writes « lease expired N times » and « the provider « X »
 * refused its key (N): … »; the runner sends the message of its error (apps/runner/src/job.ts, the
 * engine). Any other reason is unknown, and its text goes under « Détails techniques ».
 */
export function jobReason(reason: string | null, runnerName: string | null): Reason {
  let trimmed = reason?.trim() ?? ''
  if (!trimmed) return { text: 'aucune raison enregistrée', action: 'Relancez la review. Si elle échoue encore, lisez les logs du runner.', raw: null }
  let lease = /^lease expired (\d+) times?$/.exec(trimmed)
  if (lease) {
    let n = Number(lease[1])
    return {
      text: `le runner a cessé de répondre pendant le job ${TIMES[n] ?? `${n} fois`}${runnerName ? `, en dernier ${runnerName}` : ''}`,
      action: 'Vérifiez sur l’écran Runners qu’un runner est en ligne, puis relancez.',
      raw: null,
    }
  }
  let raw = sanitizeReason(trimmed)
  let refused = /^the provider « (.+) » refused its key \((\d{3})\)/.exec(trimmed)
  if (refused) return { text: `le provider « ${refused[1]} » a refusé sa clé, code ${refused[2]}`, action: 'Remplacez sa clé dans Réglages, puis relancez.', raw }
  let known = ((): Omit<Reason, 'raw'> | null => {
    // The steps of the service at the claim (app/runner/controller.ts).
    if (trimmed.startsWith('installation token: ')) {
      return { text: 'GitHub n’a pas donné de token pour ce repo', action: 'Vérifiez que l’App GitHub est toujours installée sur ce repo, puis relancez.' }
    }
    if (trimmed.startsWith('review threads: ')) return { text: 'Kentō n’a pas pu lire les fils de la PR sur GitHub', action: 'Relancez dans quelques minutes.' }
    if (trimmed.startsWith('rules: ')) return { text: 'Kentō n’a pas pu lire les règles du repo', action: 'Relancez dans quelques minutes.' }
    if (/^the provider « .+ » is not of the org of the runner$/.test(trimmed)) {
      return { text: 'le provider de la config appartient à une autre organisation que le runner', action: 'Choisissez un provider de cette organisation dans la config du repo, puis relancez.' }
    }
    if (/^the provider « .+ » needs a trusted runner$/.test(trimmed)) {
      return { text: 'la clé de ce provider ne va qu’à un runner de confiance', action: 'Marquez un runner de confiance sur l’écran Runners, puis relancez.' }
    }
    if (/^the key of the provider « .+ » cannot be decrypted/.test(trimmed)) {
      return { text: 'la clé du provider ne se déchiffre pas avec la clé maître du service', action: 'Remplacez la clé dans Réglages, ou vérifiez KENTO_SECRETS_KEY sur le service.' }
    }
    if (/^no model key\b/.test(trimmed)) {
      return { text: 'le runner n’a pas de clé pour ce provider', action: 'Donnez-lui PROVIDER_KIND et PROVIDER_API_KEY, ou marquez-le de confiance sur l’écran Runners.' }
    }
    if (/^clone failed\b/.test(trimmed)) return { text: 'le runner n’a pas pu cloner le repo', action: 'Vérifiez que l’App GitHub a toujours accès à ce repo, puis relancez.' }
    if (/^the service refused the review\b/.test(trimmed)) {
      return { text: 'le service a refusé le résultat du runner', action: 'Mettez le runner à la version que montre l’écran Runners, puis relancez.' }
    }
    if (/^the provider \S+ needs a base URL$/.test(trimmed)) return { text: 'le provider n’a pas d’URL', action: 'Ajoutez son URL dans Réglages, puis relancez.' }
    if (/^no model is set for the provider \S+ at this level$|^the provider \S+ that the config chose is not in the job$|^the job names no provider$/.test(trimmed)) {
      return { text: 'la config du repo désigne un provider ou un modèle que le job n’a pas', action: 'Choisissez le provider et les modèles de ce niveau dans la config du repo, puis relancez.' }
    }
    // The engine wraps the error of the last model (`askJson` in packages/engine/src/model.ts):
    // « no model gave a usable answer: ProviderError: <name> … » or « …: TimeoutError: … ». Each
    // pattern reads the start of that error, never a word of the answer body that follows it.
    let model = /^no model gave a usable answer: (.*)$/s.exec(trimmed)?.[1] ?? null
    let status = model === null ? /^provider: (\d{3})\b/.exec(trimmed) : PROVIDER_ERROR('answered (\\d{3})\\b').exec(model)
    if (status) return providerStatus(Number(status[1]))
    if (model === null) return null
    if (/^TimeoutError\b/.test(model)) {
      return { text: 'le modèle n’a pas répondu à temps', action: 'Relancez dans quelques minutes, ou choisissez un modèle plus rapide dans la config du repo.' }
    }
    if (PROVIDER_ERROR('gave (?:no JSON object|JSON that does not parse)').test(model)) {
      return { text: 'le modèle a donné une réponse illisible', action: 'Relancez. Si l’échec revient, choisissez un autre modèle dans la config du repo.' }
    }
    if (PROVIDER_ERROR('declined the request\\b').test(model)) {
      return { text: 'le provider a refusé de traiter cette PR', action: 'Relancez avec un autre modèle, choisi dans la config du repo.' }
    }
    return null
  })()
  return { ...(known ?? { text: 'le runner a renvoyé une erreur que Kentō ne connaît pas', action: 'Lisez les détails techniques, puis relancez.' }), raw }
}

const COST_PERIOD: Record<string, string> = { daily: 'quotidien', monthly: 'mensuel' }
const TRIGGER_TEXT: Record<string, string> = { push: 'à chaque push', ready: 'au passage en « Ready for review »', command: 'à la demande' }
const UNTRUSTED_BOT = 'Ajoutez-le aux bots de confiance pour qu’il déclenche une review.'
const REPLAY = 'Rejouez-la depuis la page de l’App.'
const INVALID = 'Ouvrez-la dans « Recent Deliveries », sur la page de l’App, pour lire ce que GitHub a envoyé.'

/** The reasons of the webhook (app/github/events.ts, app/db/webhook-store.ts, app/commands/handler.ts). */
const DELIVERY_REASONS: [RegExp, (m: RegExpExecArray) => Omit<Reason, 'raw'>][] = [
  [/^draft pull request$/, () => ({ text: 'PR en brouillon, sans review avant son passage en « Ready for review »', action: '' })],
  [/^pushed by an untrusted bot$/, () => ({ text: 'push d’un bot hors des bots de confiance', action: UNTRUSTED_BOT })],
  [/^opened by an untrusted bot$/, () => ({ text: 'PR ouverte par un bot hors des bots de confiance', action: UNTRUSTED_BOT })],
  [/^command of an untrusted bot$/, () => ({ text: 'commande d’un bot hors des bots de confiance', action: UNTRUSTED_BOT })],
  [/^pull request from a fork$/, () => ({ text: 'PR venue d’un fork, sans review automatique', action: 'Une personne qui écrit sur le repo peut lancer @kento-review.' })],
  [/^pull request (?:is )?closed$/, () => ({ text: 'PR fermée', action: '' })],
  [/^event (\S+) is not handled$/, (m) => ({ text: `événement ${m[1]}, que Kentō ne traite pas`, action: '' })],
  [/^pull_request action (\S+) creates no job$/, (m) => ({ text: `action ${m[1]} de la PR, sans review`, action: '' })],
  [/^issue_comment action (\S+) gives no command$/, (m) => ({ text: `commentaire ${m[1] === 'edited' ? 'modifié' : m[1] === 'deleted' ? 'supprimé' : m[1]}, sans commande`, action: '' })],
  [/^installation(?:_repositories)? action (\S+) is not handled$/, (m) => ({ text: `action ${m[1]} de l’installation, que Kentō ne traite pas`, action: '' })],
  [/^comment is not on a pull request$/, () => ({ text: 'commentaire hors d’une PR', action: '' })],
  [/^comment is not a command$/, () => ({ text: 'commentaire sans commande @kento-review', action: '' })],
  [/^comment of the App itself$/, () => ({ text: 'commentaire de Kentō lui-même', action: '' })],
  [/^(?:comment|delivery) already created a job$|^head already had a review job$/, () => ({ text: 'déjà traité, sans second job', action: '' })],
  [/^repository is not enabled: the workflow keeps the command$/, () => ({ text: 'repo non activé, le workflow GitHub garde la commande', action: '' })],
  [/^repository is not enabled$/, () => ({ text: 'repo non activé', action: 'Activez-le sur l’écran Repos pour qu’il reçoive des reviews.' })],
  [/^unknown repository$/, () => ({ text: 'repo inconnu de Kentō', action: 'Ajoutez-le à l’installation de l’App sur GitHub.' })],
  [/^installation is suspended$/, () => ({ text: 'installation suspendue sur GitHub', action: 'Réactivez-la dans les réglages de l’installation sur GitHub.' })],
  [/^GitHub App is not configured$/, () => ({ text: 'le service n’a pas d’App GitHub', action: 'Renseignez GITHUB_APP_ID et GITHUB_APP_PRIVATE_KEY sur le service.' })],
  [/^commands are not configured$/, () => ({ text: 'le service ne lit pas les commandes', action: 'Renseignez GITHUB_APP_ID et GITHUB_APP_PRIVATE_KEY sur le service.' })],
  [/^commenter cannot write to the repository$/, () => ({ text: 'l’auteur du commentaire n’a pas le droit d’écrire sur le repo', action: '' })],
  [/^no changed file under the paths of the config$/, () => ({ text: 'aucun fichier modifié sous les chemins de la config', action: '' })],
  [/^trigger of the config is (\S+)$/, (m) => ({ text: `la config du repo lance ses reviews ${TRIGGER_TEXT[m[1]!] ?? m[1]}`, action: '' })],
  [/^(daily|monthly) cost limit of the org is reached$/, (m) => ({ text: `plafond ${COST_PERIOD[m[1]!]} de l’organisation atteint`, action: 'Un admin le relève dans « Plafond de coût », plus haut.' })],
  [/^monthly cost limit of the repository is reached$/, () => ({ text: 'limite mensuelle du repo atteinte', action: 'Un admin la relève dans la config du repo.' })],
]

/**
 * The reason of a webhook delivery, or null when it has none. A reason of 500 is the error of the
 * service; a reason of 400 says that GitHub sent what the service cannot read.
 */
export function deliveryReason(delivery: { status: number; outcome: string; reason: string | null }): Reason | null {
  let reason = delivery.reason?.trim() ?? ''
  if (delivery.outcome === 'failed' || delivery.status >= 500) {
    return { text: 'Kentō n’a pas traité la livraison', action: REPLAY, raw: reason ? sanitizeReason(reason) : null }
  }
  if (delivery.outcome === 'invalid' || delivery.status === 400) {
    // The same content gets the same 400: a replay changes nothing.
    return { text: 'GitHub a envoyé un contenu que Kentō ne lit pas', action: INVALID, raw: reason ? sanitizeReason(reason) : null }
  }
  if (!reason) return null
  for (let [pattern, words] of DELIVERY_REASONS) {
    let match = pattern.exec(reason)
    if (match) return { ...words(match), raw: null }
  }
  return { text: 'raison que Kentō ne traduit pas', action: '', raw: sanitizeReason(reason) }
}

/** The error of the read of the App on GitHub (app/org-settings/app-status.ts). */
export function appStatusReason(error: string): Reason {
  let raw = sanitizeReason(error)
  let status = Number(/\banswered (\d{3})\b/.exec(error)?.[1] ?? 0)
  if (status === 401) return { text: 'GitHub a refusé la clé de l’App, code 401', action: 'Vérifiez GITHUB_APP_ID et GITHUB_APP_PRIVATE_KEY sur le service.', raw }
  if (status === 403) return { text: 'GitHub refuse l’accès à l’App, code 403', action: 'Vérifiez les permissions de l’App sur GitHub, puis rechargez la page.', raw }
  if (status === 404) return { text: 'GitHub ne trouve pas l’installation de l’App, code 404', action: 'Réinstallez l’App sur l’organisation, puis rechargez la page.', raw }
  if (status >= 500) return { text: `GitHub est indisponible, code ${status}`, action: 'Rechargez la page dans quelques minutes.', raw }
  return { text: 'GitHub ne répond pas sur l’App', action: 'Rechargez la page dans quelques minutes.', raw }
}

/** The reason as one sentence: « Text. Action. » */
export function reasonSentence(reason: Reason): string {
  let text = `${reason.text.charAt(0).toUpperCase()}${reason.text.slice(1)}.`
  return reason.action ? `${text} ${reason.action}` : text
}

/** The text of the service, folded under « Détails techniques ». Nothing when there is none. */
export function TechDetails(handle: Handle<{ raw: string | null }>) {
  return () =>
    handle.props.raw ? (
      <details class="tech-details">
        <summary>Détails techniques</summary>
        <code class="mono">{handle.props.raw}</code>
      </details>
    ) : null
}
