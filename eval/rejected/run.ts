/**
 * REV-95. The case of a false positive that a person rejected with its cause. It measures, on the same
 * head, whether the defect comes back after the rejection and whether the score falls because of it.
 *
 *     node eval/rejected/run.ts                                   # without a model: the scripted answers
 *     OPENROUTER_API_KEY=... node eval/rejected/run.ts --model z-ai/glm-5.3 --runs 3
 *
 * The pull request: `readConfig` parses its input with a zod schema that bounds the port, then returns
 * the port. A reviewer that does not read the schema reports "the port is not validated" (a false
 * P1). The person rejects it: "false positive, the schema validates the value".
 *
 * Without a model, the engine gets the answers that models gave to such a case: the same finding, the
 * finding in other words one line off, the same title elsewhere in the file, and a real defect far
 * from it. Each one runs without and with the rejection. With `--model`, the model reviews the pull
 * request without the rejection, then again with the rejection of its first blocking finding; the
 * line says whether the model reported the defect again (before the deterministic net) and the two
 * scores.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { levelConfig, reviewPullRequest, type Answer, type Finding } from '../../packages/engine/src/index.ts';
import type { RejectedFinding } from '../../packages/protocol/src/index.ts';

const { values } = parseArgs({ options: { model: { type: 'string' }, runs: { type: 'string', default: '1' } } });

const PATH = 'src/config.ts';
const FILE = [
  'import { z } from "zod";',
  '',
  'const Schema = z.object({ port: z.number().int().min(1).max(65535), host: z.string() });',
  '',
  'export function readConfig(raw: unknown) {',
  '  const config = Schema.parse(raw);',
  '  return { port: config.port, host: config.host };',
  '}',
  '',
];
const PORT_LINE = FILE.findIndex((l) => l.includes('config.port')) + 1;
const CAUSE = 'false positive, the schema validates the value (int, min 1, max 65535)';

const repo = mkdtempSync(join(tmpdir(), 'bench-rejected-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'bench@example.com');
git('config', 'user.name', 'Bench');
writeFileSync(join(repo, 'README.md'), 'base\n');
git('add', '.');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
git('checkout', '-q', '-b', 'pr');
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, PATH), FILE.join('\n'));
git('add', '.');
git('commit', '-q', '-m', 'feat: read the config with its schema');
const head = git('rev-parse', 'HEAD');

const falseP1 = (over: Partial<Finding> = {}): Finding => ({
  path: PATH,
  start_line: PORT_LINE,
  line: PORT_LINE,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title: 'The port is not validated',
  scenario: 'A config with `port: 0` starts the server on a random port.',
  fix: 'Validate the port before returning it.',
  suggestion: '',
  ...over,
});
const answer = (findings: Finding[], score = 4): Answer => ({
  confidence_score: score,
  risk: 'Risk',
  summary: 'Summary',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});
const scripted = (reply: Answer) =>
  (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: body.model, provider: 'Scripted', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;

const rejectionOf = (f: Finding): RejectedFinding => ({ path: f.path, line: f.line, title: f.title, category: f.category, severity: f.severity, status: 'dismissed', reason: CAUSE, commit: head });
const near = (f: Finding, r: RejectedFinding) => f.path === r.path && Math.abs(f.line - r.line) <= 3;

const rows: string[] = [];
try {
  if (!values.model) {
    const realDefect = falseP1({ line: 3, start_line: 3, title: '`host` accepts an empty string', severity: 'minor', confidence: 80 });
    const cases: [string, Finding[]][] = [
      ['the same finding', [falseP1()]],
      ['in other words, one line off', [falseP1({ title: 'Port accepted without a check', line: PORT_LINE + 1, start_line: PORT_LINE + 1 })]],
      ['the same title, elsewhere in the file', [falseP1({ line: 1, start_line: 1 })]],
      ['a real defect far from it, with the false P1', [falseP1(), realDefect]],
    ];
    const rejected = [rejectionOf(falseP1())];
    rows.push('| answer of the model | findings without / with the rejection | blocking with | score without / with |', '|---|---|---|---|');
    for (const [name, findings] of cases) {
      const run = (withRejection: boolean) =>
        reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'none', fetch: scripted(answer(structuredClone(findings))), log: () => {}, ...(withRejection ? { rejected } : {}) });
      const [without, withIt] = [await run(false), await run(true)];
      rows.push(`| ${name} | ${without.findings.length} / ${withIt.findings.length} | ${withIt.findings.filter((f) => f.blocking).length} | ${without.score} / ${withIt.score} |`);
    }
  } else {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('--model needs OPENROUTER_API_KEY');
    rows.push('| run | blocking without | score without | reported again by the model | after the net | score with |', '|---|---|---|---|---|---|');
    const config = levelConfig('lite', { ...process.env, REVIEW_MODELS: values.model });
    for (let i = 1; i <= Number(values.runs); i++) {
      const without = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey, config, log: () => {} });
      const first = without.findings.find((f) => f.blocking) ?? without.findings[0];
      if (!first) {
        rows.push(`| ${i} | 0 | ${without.score} | no finding to reject | | |`);
        continue;
      }
      const rejected = [rejectionOf(first)];
      const withIt = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey, config, log: () => {}, rejected });
      const again = withIt.droppedAsRejected.length + withIt.findings.filter((f) => near(f, rejected[0]!)).length;
      const after = withIt.findings.filter((f) => near(f, rejected[0]!)).length;
      rows.push(`| ${i} | ${without.findings.filter((f) => f.blocking).length} | ${without.score} | ${again} | ${after} | ${withIt.score} |`);
    }
  }
  console.log(rows.join('\n'));
} finally {
  rmSync(repo, { recursive: true, force: true });
}
