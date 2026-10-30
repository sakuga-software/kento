import type { Handle } from 'remix/component'

import { PRECISION_DAYS, PRECISION_MIN, precisionLabel, type Precision, type PrecisionReport } from '../findings/precision.ts'
import { pageRoutes as routes } from '../routes.ts'
import { findingsHref } from './findings.tsx'
import { plural } from './format.ts'

/** The name of a repository without its owner, when the owner is the org on screen. A name with no owner stays whole. */
export function shortName(fullName: string, org: string): string {
  let slash = fullName.indexOf('/')
  return slash > 0 && fullName.slice(0, slash).toLowerCase() === org.toLowerCase() ? fullName.slice(slash + 1) : fullName
}

/** « 41 fixed · 9 dismissed »: what the share is made of. */
export function precisionCounts(precision: Precision): string {
  return `${precision.fixed} fixed · ${precision.dismissed} dismissed`
}

/**
 * A share, or « n = 9 sur 10 » under 10 closed findings, with what it is made of for a screen reader
 * and in its title.
 */
export function PrecisionValue(handle: Handle<{ precision: Precision; large?: boolean }>) {
  return () => {
    let { precision, large } = handle.props
    let measured = precision.rate !== null
    return (
      <span class={`precision-value${large ? ' precision-large' : ''}${measured ? '' : ' precision-pending'}`} title={precisionCounts(precision)}>
        {precisionLabel(precision)}
        <span class="visually-hidden">
          {measured
            ? ` (${precisionCounts(precision)})`
            : ` : ${precision.closed} ${plural(precision.closed, 'finding clos', 'findings clos')}, la précision s’affiche à partir de ${PRECISION_MIN}`}
        </span>
      </span>
    )
  }
}

/** One line of a group: its name, its share and its count. */
function GroupRow(handle: Handle<{ name: string; href: string; precision: Precision; label?: string }>) {
  return () => {
    let { name, href, precision, label } = handle.props
    return (
      <li class="precision-row">
        <a class="precision-name" href={href} title={label ?? name}>
          {name}
        </a>
        <span class="precision-figures">
          <PrecisionValue precision={precision} />
          <span class="hint precision-n" aria-hidden="true">
            {precision.closed} {plural(precision.closed, 'clos', 'clos')}
          </span>
        </span>
      </li>
    )
  }
}

/**
 * The precision of the org over 30 days, by repository, by pass and by rule, and the reasons of its
 * dismissed findings (REV-18). Each group links to its findings.
 */
export function PrecisionSection(handle: Handle<{ report: PrecisionReport; org: string }>) {
  return () => {
    let { report, org } = handle.props
    let { org: total } = report
    let more = report.repoCount - report.repos.length
    return (
      <section class="precision" aria-labelledby="precision-title">
        <h2 id="precision-title" class="section-title">
          Précision · {PRECISION_DAYS} derniers jours
        </h2>
        <div class="precision-grid">
          <div class="card precision-card">
            <h3 class="precision-card-title">Organisation</h3>
            <PrecisionValue precision={total} large />
            <p class="hint">
              {total.rate === null
                ? `Elle s’affiche à partir de ${PRECISION_MIN} findings clos (fixed ou dismissed).`
                : `${precisionCounts(total)} : la part des findings clos qu’un push a corrigés.`}
            </p>
            <h3 class="precision-card-title">Par passe</h3>
            <ul class="precision-list">
              <li class="precision-row">
                <span class="precision-name">Passe unique</span>
                <span class="precision-figures">
                  <PrecisionValue precision={total} />
                  <span class="hint precision-n" aria-hidden="true">
                    {total.closed} clos
                  </span>
                </span>
              </li>
            </ul>
            <p class="hint">Une passe par review pour l’instant : les passes multiples auront chacune leur ligne.</p>
          </div>

          <div class="card precision-card">
            <h3 class="precision-card-title">Par repo</h3>
            {report.repos.length === 0 ? (
              <p class="hint">Aucun finding clos sur {PRECISION_DAYS} jours.</p>
            ) : (
              <ul class="precision-list">
                {report.repos.map((repo) => (
                  <GroupRow
                    name={shortName(repo.fullName, org)}
                    label={repo.fullName}
                    href={findingsHref({ view: 'closed', repoId: repo.id })}
                    precision={repo}
                  />
                ))}
              </ul>
            )}
            {more > 0 ? (
              <p class="hint">
                {more} {plural(more, 'autre repo', 'autres repos')} : <a href={routes.repos.href()}>leur précision est dans Repos</a>.
              </p>
            ) : null}
          </div>

          <div class="card precision-card">
            <h3 class="precision-card-title">Par règle</h3>
            {report.rules.length === 0 ? (
              <p class="hint">Aucun finding clos ne vient d’une règle sur {PRECISION_DAYS} jours.</p>
            ) : (
              <ul class="precision-list">
                {report.rules.map((rule) => (
                  <GroupRow
                    name={rule.title}
                    label={rule.repo ? `${rule.title} (${rule.repo})` : `${rule.title} (org)`}
                    href={findingsHref({ view: 'closed', ruleId: rule.id })}
                    precision={rule}
                  />
                ))}
              </ul>
            )}
          </div>

          <div class="card precision-card">
            <h3 class="precision-card-title">Motifs des dismissed</h3>
            {report.reasons.length === 0 && report.unreasoned === 0 ? (
              <p class="hint">Aucun finding dismissed sur {PRECISION_DAYS} jours.</p>
            ) : (
              <ul class="precision-list">
                {report.reasons.map((reason) => (
                  <li class="precision-row">
                    <a class="precision-name" href={findingsHref({ view: 'dismissed', reason: reason.reason })} title={reason.reason}>
                      {reason.reason}
                    </a>
                    <span class="precision-value">{reason.count}</span>
                  </li>
                ))}
                {report.unreasoned > 0 ? (
                  // No link: the list cannot filter on an empty reason.
                  <li class="precision-row">
                    <span class="precision-name">Sans motif</span>
                    <span class="precision-value">{report.unreasoned}</span>
                  </li>
                ) : null}
              </ul>
            )}
            {report.reasons.length > 0 ? (
              <p class="hint">Compté sur {PRECISION_DAYS} jours ; chaque lien montre tous les findings dismissed de ce motif, sans limite de date.</p>
            ) : null}
            {report.reasonCount > report.reasons.length ? (
              <p class="hint">
                Et {report.reasonCount - report.reasons.length} {plural(report.reasonCount - report.reasons.length, 'autre motif', 'autres motifs')} :{' '}
                <a href={findingsHref({ view: 'dismissed' })}>voir les dismissed</a>.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    )
  }
}
