/**
 * The scoring profiles of Martian (offline/README.md, "Scoring profiles"). A profile names the
 * categories of golden comments that count. A finding that matches only golden comments outside the
 * profile is "matched-excluded": it counts neither as found nor as a false positive.
 */
const STRICT = ['bug', 'security', 'concurrency', 'data', 'api'];
const CORE = [...STRICT, 'perf', 'test_gap', 'doc_defect'];
const ALL = [...CORE, 'style', 'speculative'];
export const PROFILES = { strict: STRICT, core: CORE, all: ALL } as const;
export type Profile = keyof typeof PROFILES;

/** A row that the judge scored: the category of each golden comment, and the golden comments that each finding matches. */
export type ScoredRow = { categories: string[]; matches: number[][] };

export type ProfileMetrics = {
  recall: number;
  precision: number;
  f1: number;
  /** The golden comments of the profile that one finding or more matches. */
  found: number;
  golden: number;
  /** The findings that count: all of them, less the matched-excluded ones. */
  findings: number;
  /** The findings that match one golden comment of the profile or more. */
  true_findings: number;
  matched_excluded: number;
};

/**
 * Recall counts golden comments, as Martian does. Precision counts findings: two findings on one
 * golden comment are two true findings.
 */
export function profileMetrics(rows: readonly ScoredRow[], profile: Profile): ProfileMetrics {
  const inProfile = new Set<string>(PROFILES[profile]);
  let found = 0, golden = 0, findings = 0, trueFindings = 0, excluded = 0;
  for (const row of rows) {
    const counts = row.categories.map((category) => inProfile.has(category));
    golden += counts.filter(Boolean).length;
    found += new Set(row.matches.flat().filter((index) => counts[index])).size;
    for (const match of row.matches) {
      if (match.some((index) => counts[index])) trueFindings++;
      else if (match.length) {
        excluded++;
        continue;
      }
      findings++;
    }
  }
  const recall = found / Math.max(golden, 1);
  const precision = trueFindings / Math.max(findings, 1);
  return {
    recall,
    precision,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    found,
    golden,
    findings,
    true_findings: trueFindings,
    matched_excluded: excluded,
  };
}

/**
 * KNT-111. The rows as a review would publish them with a minimum confidence: the findings below it
 * go, with their matches. A row without `confidences` (a file written before KNT-111) gives null.
 */
export function atMinConfidence<R extends ScoredRow & { confidences?: number[] }>(rows: readonly R[], minimum: number): R[] | null {
  if (!rows.every((row) => Array.isArray(row.confidences) && row.confidences.length === row.matches.length)) return null;
  return rows.map((row) => ({ ...row, matches: row.matches.filter((_, i) => row.confidences![i] >= minimum) }));
}
