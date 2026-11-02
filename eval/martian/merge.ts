export type Located = { path: string; start_line: number; line: number; severity: string; confidence: number };
const SEVERITY_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 };
/** Two findings name one defect when they are on the same file, at most this number of lines apart. */
const SAME_DEFECT_LINES = 3;

/**
 * The findings of several reviews of one pull request, without duplicates. The finding with the
 * highest severity, then the highest confidence, stays. This compares the place only: two different
 * defects on near lines of one file become one.
 */
export function mergeSamples<F extends Located>(samples: F[][]): { findings: F[]; merged: number } {
  const all = samples.flat().sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || b.confidence - a.confidence);
  const kept: F[] = [];
  for (const f of all) {
    const near = (k: F) => k.path === f.path && f.start_line - SAME_DEFECT_LINES <= k.line && k.start_line - SAME_DEFECT_LINES <= f.line;
    if (!kept.some(near)) kept.push(f);
  }
  return { findings: kept, merged: all.length - kept.length };
}
