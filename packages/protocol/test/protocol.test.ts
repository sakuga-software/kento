import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaimRequest, parseHeartbeatRequest, parseJob, parseRegisterRequest, parseResultRequest, type Job, type ReviewPayload } from '../src/index.ts';

const SHA = 'a'.repeat(40);

const job = (): Job => ({
  id: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b11',
  attempt: 1,
  kind: 'review',
  level: 'lite',
  repo: { fullName: 'sakuga-software/sakuga-review', cloneUrl: 'https://github.com/sakuga-software/sakuga-review.git' },
  pullRequest: { number: 28, headSha: SHA, baseRef: 'main' },
  installationToken: { token: 'ghs_x', expiresAt: '2026-10-28T18:00:00Z' },
  leaseExpiresAt: '2026-10-28T17:02:00.123Z',
  provider: null,
});

const review = (): ReviewPayload => ({
  level: 'lite',
  base: SHA,
  head: 'b'.repeat(40),
  score: 4,
  verdict: 'COMMENT',
  model: 'anthropic/claude-haiku-5.5',
  provider: 'Anthropic',
  costUsd: 0.0123,
  promptTokens: 1000,
  completionTokens: 200,
  summary: 'Résumé',
  risk: 'Faible',
  diagram: null,
  deeperReview: null,
  findings: [
    {
      path: 'a.ts',
      start_line: 1,
      line: 2,
      severity: 'major',
      category: 'bug',
      confidence: 90,
      title: 't',
      scenario: 's',
      fix: 'f',
      suggestion: '',
      anchor: 2,
      blocking: true,
      suggestion_range: [1, 2],
    },
  ],
  notReviewed: [],
  skipped: [],
});

test('a valid job, register, claim and result pass', () => {
  assert.deepEqual(parseJob(job()), { ok: true, value: job() });
  assert.equal(parseRegisterRequest({ name: 'runners-host', labels: ['linux', 'x64'], version: '0.1.0' }).ok, true);
  assert.equal(parseClaimRequest({ hasProviderKey: false }).ok, true);
  assert.deepEqual(parseResultRequest({ outcome: 'done', attempt: 1, review: review() }), { ok: true, value: { outcome: 'done', attempt: 1, review: review() } });
  assert.equal(parseResultRequest({ outcome: 'failed', attempt: 2, reason: 'clone failed' }).ok, true);
  assert.deepEqual(parseHeartbeatRequest({ attempt: 2 }), { ok: true, value: { attempt: 2 } });
});

test('a result with a wrong score, an extra key or a missing key fails, with the path of each problem', () => {
  const bad = { outcome: 'done', attempt: 1, review: { ...review(), score: 6, extra: 1 } } as Record<string, unknown>;
  delete (bad.review as Record<string, unknown>).model;
  const checked = parseResultRequest(bad);
  assert.equal(checked.ok, false);
  assert.deepEqual(!checked.ok && checked.errors.sort(), ['$.review.extra: is not allowed', '$.review.model: is required', '$.review.score: must be from 1 to 5']);
});

test('a result with an unknown outcome, a bad finding or too many findings fails', () => {
  assert.equal(parseResultRequest({ outcome: 'maybe' }).ok, false);
  assert.equal(parseResultRequest(null).ok, false);
  assert.equal(parseResultRequest([]).ok, false);
  const badFinding = review();
  (badFinding.findings[0] as Record<string, unknown>).severity = 'blocker';
  assert.deepEqual(parseResultRequest({ outcome: 'done', attempt: 1, review: badFinding }), {
    ok: false,
    errors: ['$.review.findings[0].severity: must be one of critical, major, minor'],
  });
  const many = review();
  many.findings = Array.from({ length: 101 }, () => review().findings[0]!);
  assert.equal(parseResultRequest({ outcome: 'done', attempt: 1, review: many }).ok, false);
  assert.equal(parseResultRequest({ outcome: 'failed', attempt: 1, reason: '' }).ok, false);
});

test('a heartbeat or a result without a valid attempt fails: the service fences each claim with it', () => {
  for (const attempt of [undefined, 0, -1, 1.5, '1', 1001]) {
    const value = attempt === undefined ? {} : { attempt };
    assert.equal(parseHeartbeatRequest(value).ok, false, String(attempt));
    assert.equal(parseResultRequest({ outcome: 'failed', reason: 'x', ...value }).ok, false, String(attempt));
    assert.equal(parseJob({ ...job(), attempt }).ok, false, String(attempt));
  }
});

test('a job with a clone URL that is not HTTPS, or a base that looks like an option, fails', () => {
  for (const cloneUrl of ['http://github.com/a/b.git', 'file:///etc', 'ext::sh -c x', 'https://user:pw@github.com/a/b.git']) {
    const j = job();
    j.repo.cloneUrl = cloneUrl;
    assert.equal(parseJob(j).ok, false, cloneUrl);
  }
  for (const baseRef of ['--upload-pack=x', 'a b', 'a:b', '']) {
    const j = job();
    j.pullRequest.baseRef = baseRef;
    assert.equal(parseJob(j).ok, false, baseRef);
  }
  const j = job();
  j.pullRequest.headSha = 'HEAD';
  assert.equal(parseJob(j).ok, false);
});
