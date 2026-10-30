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

test('a finding can carry a fingerprint of 16 hexadecimal characters, and nothing else in that key', () => {
  const withPrint = review();
  withPrint.findings[0].fingerprint = '0123456789abcdef';
  assert.equal(parseResultRequest({ outcome: 'done', attempt: 1, review: withPrint }).ok, true);
  withPrint.findings[0].fingerprint = '0123456789ABCDEF';
  assert.deepEqual(parseResultRequest({ outcome: 'done', attempt: 1, review: withPrint }), {
    ok: false,
    errors: ['$.review.findings[0].fingerprint: has a wrong format'],
  });
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

const resolveJob = (): Job => ({
  ...job(),
  kind: 'resolve',
  resolve: {
    threads: [
      {
        id: 'PRRT_kwDO',
        path: 'src/a.ts',
        line: 12,
        comments: [{ id: 1001, author: 'sakuga-review', isBot: true, body: 'La somme soustrait.', commit: SHA }],
      },
    ],
    open: 3,
    waiting: 1,
  },
});

test('a claim says which kinds of job the runner runs; a runner of an earlier release says nothing', () => {
  assert.deepEqual(parseClaimRequest({ hasProviderKey: true }), { ok: true, value: { hasProviderKey: true } });
  assert.deepEqual(parseClaimRequest({ hasProviderKey: true, kinds: ['review', 'resolve'] }), {
    ok: true,
    value: { hasProviderKey: true, kinds: ['review', 'resolve'] },
  });
  assert.equal(parseClaimRequest({ hasProviderKey: true, kinds: ['deploy'] }).ok, false);
});

test('a resolve job carries its threads; a review job carries none', () => {
  assert.deepEqual(parseJob(resolveJob()), { ok: true, value: resolveJob() });
  const threads = (resolveJob() as Extract<Job, { kind: 'resolve' }>).resolve;
  assert.equal(parseJob({ ...job(), resolve: threads }).ok, false);
  const { resolve: _, ...withoutThreads } = resolveJob() as any;
  assert.equal(parseJob(withoutThreads).ok, false);
  const tooMany = resolveJob() as any;
  tooMany.resolve.threads = Array.from({ length: 21 }, () => tooMany.resolve.threads[0]);
  assert.equal(parseJob(tooMany).ok, false);
});

test('a resolved result passes with its verdicts, and fails with an unknown verdict', () => {
  const resolved = {
    outcome: 'resolved',
    attempt: 1,
    resolve: {
      level: 'lite',
      head: SHA,
      model: 'anthropic/claude-haiku-5.5',
      provider: 'Anthropic',
      costUsd: 0.004,
      promptTokens: 900,
      completionTokens: 100,
      open: 3,
      waiting: 1,
      held: 1,
      threads: [{ id: 'PRRT_kwDO', verdict: 'fixed', reply: 'Corrigé.', changed: true }],
    },
  };
  assert.deepEqual(parseResultRequest(resolved), { ok: true, value: resolved });
  assert.equal(parseResultRequest({ ...resolved, resolve: { ...resolved.resolve, model: null, held: 0, threads: [] } }).ok, true);
  assert.equal(parseResultRequest({ ...resolved, resolve: { ...resolved.resolve, threads: [{ id: 'x', verdict: 'maybe', reply: '', changed: null }] } }).ok, false);
});

// --- providers (REV-11) ------------------------------------------------------------------------

const PROVIDER = { id: '7f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', kind: 'anthropic', apiKey: 'sk-ant-x', baseUrl: null, models: ['claude-opus-5-5'] };

test('a job with providers: each kind, the key of the service, a runner-held provider', () => {
  assert.ok(parseJob({ ...job(), providers: [PROVIDER] }).ok);
  assert.ok(parseJob({ ...job(), providers: [{ ...PROVIDER, id: 'service', kind: 'openrouter', models: ['anthropic/claude-haiku-5.5'] }] }).ok);
  assert.ok(parseJob({ ...job(), providers: [{ ...PROVIDER, kind: 'ollama', apiKey: null, baseUrl: 'http://gpu.lan:11434', models: ['qwen3:32b'] }] }).ok);
  assert.ok(parseJob({ ...job(), providers: [{ ...PROVIDER, kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', models: [] }] }).ok);
});

test('a job: a provider with a wrong id, kind, URL or model is refused', () => {
  const refused = (provider: object) => assert.equal(parseJob({ ...job(), providers: [provider] }).ok, false, JSON.stringify(provider));
  refused({ ...PROVIDER, id: 'org-1' });
  refused({ ...PROVIDER, kind: 'bedrock' });
  refused({ ...PROVIDER, baseUrl: 'ftp://x' });
  refused({ ...PROVIDER, baseUrl: 'https://user:pass@x' });
  refused({ ...PROVIDER, models: ['--help'] });
  refused({ ...PROVIDER, models: ['a b'] });
  refused({ ...PROVIDER, extra: true });
  // The key of the first release is an OpenRouter key only: an earlier runner reads it as such.
  assert.equal(parseJob({ ...job(), provider: { kind: 'anthropic', apiKey: 'k' } }).ok, false);
});

test('a claim says its features and its own provider; an earlier claim has neither', () => {
  assert.ok(parseClaimRequest({ hasProviderKey: true, kinds: ['review'], features: ['providers'], ownProvider: 'ollama' }).ok);
  assert.ok(parseClaimRequest({ hasProviderKey: false, features: ['providers'], ownProvider: null }).ok);
  assert.ok(parseClaimRequest({ hasProviderKey: false }).ok);
  assert.equal(parseClaimRequest({ hasProviderKey: false, features: ['teleport'] }).ok, false);
  assert.equal(parseClaimRequest({ hasProviderKey: false, ownProvider: 'bedrock' }).ok, false);
});

test('a result: the status of a refused key, and where the cost comes from', () => {
  assert.ok(parseResultRequest({ outcome: 'failed', attempt: 1, reason: 'Anthropic answered 401', providerStatus: 401 }).ok);
  assert.ok(parseResultRequest({ outcome: 'failed', attempt: 1, reason: 'clone failed', providerStatus: null }).ok);
  assert.equal(parseResultRequest({ outcome: 'failed', attempt: 1, reason: 'x', providerStatus: 42 }).ok, false);
  assert.ok(parseResultRequest({ outcome: 'done', attempt: 1, review: { ...review(), costSource: 'unknown', costUsd: 0 } }).ok);
  assert.equal(parseResultRequest({ outcome: 'done', attempt: 1, review: { ...review(), costSource: 'guess' } }).ok, false);
});

test('a job carries the models of the config of its repository, or none (REV-12)', () => {
  assert.ok(parseClaimRequest({ hasProviderKey: true, features: ['providers', 'models'], ownProvider: null }).ok);
  const models = { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: 'z-ai/glm-5.3' };
  assert.deepEqual(parseJob({ ...job(), models }), { ok: true, value: { ...job(), models } });
  assert.ok(parseJob({ ...job(), models: { provider: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b11', model: 'claude-sonnet-5-5', fallback: null } }).ok);
  // A job without the key: what a runner without the feature gets.
  assert.deepEqual(parseJob(job()), { ok: true, value: job() });
  // A model is never an option of a command, nor holds a space; a provider is `service` or an id.
  assert.equal(parseJob({ ...job(), models: { ...models, model: '-x' } }).ok, false);
  assert.equal(parseJob({ ...job(), models: { ...models, fallback: 'a b' } }).ok, false);
  assert.equal(parseJob({ ...job(), models: { ...models, provider: 'openrouter' } }).ok, false);
  assert.equal(parseJob({ ...job(), models: { provider: 'service', model: 'x' } }).ok, false);
});

// --- rules (REV-19) ---------------------------------------------------------------------------

const RULE = {
  id: '5d0e6c1a-8b7f-4e2d-9c3b-1f2a3b4c5d6e',
  scope: 'repo',
  title: 'Toute migration drizzle a un index pour chaque FK',
  text: 'Chaque clé étrangère ajoutée par une migration a son index.',
  paths: ['**/migrations/**'],
  severityFloor: 'major',
};

test('a job carries the rules of its repository and of its org, with the feature rules (REV-19)', () => {
  assert.ok(parseClaimRequest({ hasProviderKey: true, features: ['providers', 'models', 'rules'], ownProvider: null }).ok);
  const rules = [RULE, { ...RULE, id: '6e1f7d2b-9c8a-4f3e-8d4c-2a3b4c5d6e7f', scope: 'org', paths: [], severityFloor: null }];
  assert.deepEqual(parseJob({ ...job(), rules }), { ok: true, value: { ...job(), rules } });
  assert.ok(parseJob({ ...job(), rules: [] }).ok);
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, id: 'R1' }] }).ok, false, 'the id of a rule is the uuid of the service');
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, scope: 'diff' }] }).ok, false);
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, severityFloor: 'info' }] }).ok, false);
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, title: '' }] }).ok, false);
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, text: 'x'.repeat(4001) }] }).ok, false);
  assert.equal(parseJob({ ...job(), rules: [{ ...RULE, paths: Array(21).fill('a/**') }] }).ok, false);
  assert.equal(parseJob({ ...job(), rules: Array(51).fill(RULE) }).ok, false);
});

test('a finding may cite a rule by its id; a finding of an earlier runner, with no rule_id, still passes (REV-19)', () => {
  // A runner already deployed sends findings without `rule_id`: the service still takes them.
  const earlier = review();
  assert.ok(!('rule_id' in earlier.findings[0]!));
  assert.deepEqual(parseResultRequest({ outcome: 'done', attempt: 1, review: earlier }), { ok: true, value: { outcome: 'done', attempt: 1, review: earlier } });
  const cited = review();
  cited.findings[0]!.rule_id = RULE.id;
  assert.ok(parseResultRequest({ outcome: 'done', attempt: 1, review: cited }).ok);
  for (const ruleId of ['R1', null, '', 42]) {
    const bad = { ...review(), findings: [{ ...review().findings[0]!, rule_id: ruleId }] };
    assert.equal(parseResultRequest({ outcome: 'done', attempt: 1, review: bad }).ok, false, String(ruleId));
  }
});
