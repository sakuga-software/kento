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
 * A share, or « n = 9 of 10 » under 10 closed findings, with what it is made of for a screen reader
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
            : `: ${precision.closed} closed ${plural(precision.closed, 'finding')}, the precision shows from ${PRECISION_MIN}`}
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
            {precision.closed} closed
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
          Precision · last {PRECISION_DAYS} days
        </h2>
        <div class="precision-grid">
          <div class="card precision-card">
            <h3 class="precision-card-title">Organization</h3>
            <PrecisionValue precision={total} large />
            <p class="hint">
              {total.rate === null
                ? `It shows from ${PRECISION_MIN} closed findings (fixed or dismissed).`
                : `${precisionCounts(total)}: the share of the closed findings that a push fixed.`}
            </p>
            <h3 class="precision-card-title">By pass</h3>
            <ul class="precision-list">
              <li class="precision-row">
                <span class="precision-name">Single pass</span>
                <span class="precision-figures">
                  <PrecisionValue precision={total} />
                  <span class="hint precision-n" aria-hidden="true">
                    {total.closed} closed
                  </span>
                </span>
              </li>
            </ul>
            <p class="hint">One pass per review for now. Each pass will have its own row when a review runs several.</p>
          </div>

          <div class="card precision-card">
            <h3 class="precision-card-title">By repo</h3>
            {report.repos.length === 0 ? (
              <p class="hint">No closed finding over {PRECISION_DAYS} days.</p>
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
                {more} other {plural(more, 'repo')}: <a href={routes.repos.href()}>their precision is in Repos</a>.
              </p>
            ) : null}
          </div>

          <div class="card precision-card">
            <h3 class="precision-card-title">By rule</h3>
            {report.rules.length === 0 ? (
              <p class="hint">No closed finding comes from a rule over {PRECISION_DAYS} days.</p>
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
            <h3 class="precision-card-title">Dismissal reasons</h3>
            {report.reasons.length === 0 && report.unreasoned === 0 ? (
              <p class="hint">No dismissed finding over {PRECISION_DAYS} days.</p>
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
                    <span class="precision-name">No reason</span>
                    <span class="precision-value">{report.unreasoned}</span>
                  </li>
                ) : null}
              </ul>
            )}
            {report.reasons.length > 0 ? (
              <p class="hint">Counted over {PRECISION_DAYS} days. Each link shows all the dismissed findings with this reason, with no date limit.</p>
            ) : null}
            {report.reasonCount > report.reasons.length ? (
              <p class="hint">
                And {report.reasonCount - report.reasons.length} other {plural(report.reasonCount - report.reasons.length, 'reason')}:{' '}
                <a href={findingsHref({ view: 'dismissed' })}>see the dismissed findings</a>.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    )
  }
}
