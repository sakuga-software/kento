/**
 * The kinds of failure of one review of the bench (REV-109). A review fails when it gives no
 * findings and an error. A truncated review hit the output cap of the model: its JSON is cut.
 */
export type FailureRow = {
  findings: readonly unknown[];
  error?: string;
  model?: string;
  truncated?: boolean;
  stop_reason?: string;
  usage?: { stop_reason?: string };
};

export type FailureKind = 'error' | 'truncated' | null;

/** The engine gives the `stop_reason` in the message of a JSON that does not parse (providers.ts). */
const CUT = /stop_reason (max_tokens|length)\b/;

export function failureKind(row: FailureRow): FailureKind {
  if (row.findings.length > 0 || !row.error) return null;
  const stopReason = row.stop_reason ?? row.usage?.stop_reason;
  if (row.truncated === true || stopReason === 'max_tokens' || CUT.test(row.error)) return 'truncated';
  return 'error';
}

/** A review that a model other than the asked one gave: the first model failed. */
export function fellBack(row: FailureRow, model: string): boolean {
  return Boolean(row.model) && !row.model!.startsWith(model);
}

export function failureCounts(rows: readonly FailureRow[], model?: string) {
  const kinds = rows.map(failureKind);
  return {
    errors: kinds.filter((kind) => kind === 'error').length,
    truncated: kinds.filter((kind) => kind === 'truncated').length,
    fallbacks: model ? rows.filter((row) => fellBack(row, model)).length : 0,
  };
}
