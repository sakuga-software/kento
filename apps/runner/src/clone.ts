// The clone of a pull request: a bare repository with the history of the base and the head and no
// blob, then the blobs of the head in one batch. No checkout, so no file of the pull request is
// written, and no hook or script of the pull request runs.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { redact } from './log.ts';

export type Checkout = {
  repoDir: string;
  /** The tip of the base branch, as the engine wants it. */
  base: string;
  head: string;
  remove(): Promise<void>;
};

/**
 * The environment of every git command of a job, and of the engine while it reads the clone (a
 * partial clone fetches a missing blob on demand, with the same header).
 *
 * The token goes in an HTTP header that git reads from the environment: never in a URL, a command
 * line or a file of the clone. Only the host of the clone URL gets it. The global and system
 * configurations are ignored, so no credential helper, URL rewrite or hook of the machine applies.
 */
export function gitEnvironment(cloneUrl: string, token: string, allowedProtocols = 'https'): Record<string, string> {
  const { origin } = new URL(cloneUrl);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const config: [string, string][] = [
    [`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
    ['core.hooksPath', '/dev/null'],
    ['protocol.allow', 'never'],
    ...allowedProtocols.split(':').map((p): [string, string] => [`protocol.${p}.allow`, 'always']),
  ];
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: allowedProtocols,
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Runs `fn` with these variables in process.env, and puts the previous values back after. The engine
 * runs git with process.env, so this is how its on-demand fetches get the header. A runner runs one
 * job at a time, so no other job sees the variables.
 */
export async function withEnvironment<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function run(cwd: string, env: Record<string, string>, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      // The message of a failed git command holds its stderr. It goes through redact, in case a
      // server echoed a credential.
      if (error) reject(new Error(redact(`git ${args[0]} failed (${error.code ?? error.signal}): ${stderr.trim().slice(-500)}`)));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

/**
 * The waits before the second and the third attempt of a clone. Just after a push, GitHub can
 * answer a fetch with « did not send all necessary objects »: the same fetch works seconds later.
 */
export const CLONE_RETRY_DELAYS_MS = [3_000, 10_000];

/**
 * The errors of git that a new attempt can fix: an incomplete pack, a cut connection, a 5xx of the
 * server. A refused token, a missing repository or a missing branch fail again: no new attempt.
 */
const TRANSIENT = [
  /did not send all necessary objects/i,
  /early EOF/i,
  /RPC failed/i,
  /remote end hung up unexpectedly/i,
  /unexpected disconnect/i,
  /Connection (?:reset|refused|timed out)/i,
  /Could not resolve host/i,
  /Operation timed out/i,
  /returned error: 5\d\d/i,
  /HTTP\/2 stream \d+ was not closed cleanly/i,
];

export function isTransientGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT.some((pattern) => pattern.test(message));
}

/**
 * Fetches the head commit and the base branch of a pull request into a new bare repository under
 * `workDir`: every commit and tree, and the blobs of the head only. The engine reads the base side
 * of the diff from blobs that git fetches in one batch when it diffs.
 *
 * After a transient error, a new attempt starts in a new directory, after each delay of
 * `retryDelaysMs`. An abort of `signal` stops the wait, and no new attempt starts.
 */
export async function clonePullRequest(options: {
  workDir: string;
  cloneUrl: string;
  headSha: string;
  baseRef: string;
  env: Record<string, string>;
  retryDelaysMs?: readonly number[];
  /** Whether a new attempt can fix the error. By default, `isTransientGitError`. */
  transient?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
  signal?: AbortSignal;
}): Promise<Checkout> {
  const delays = options.retryDelaysMs ?? CLONE_RETRY_DELAYS_MS;
  const transient = options.transient ?? isTransientGitError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await cloneOnce(options);
    } catch (error) {
      const delay = delays[attempt - 1];
      if (delay === undefined || !transient(error) || options.signal?.aborted) throw error;
      options.onRetry?.(attempt, error);
      await sleep(delay, undefined, { signal: options.signal });
    }
  }
}

async function cloneOnce(options: { workDir: string; cloneUrl: string; headSha: string; baseRef: string; env: Record<string, string> }): Promise<Checkout> {
  const repoDir = await mkdtemp(join(options.workDir, 'job-'));
  const remove = () => rm(repoDir, { recursive: true, force: true });
  try {
    const { env } = options;
    const baseTracking = `refs/remotes/origin/${options.baseRef}`;
    await run(repoDir, env, ['init', '--quiet', '--bare']);
    await run(repoDir, env, ['remote', 'add', 'origin', options.cloneUrl]);
    await run(repoDir, env, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--filter=blob:none',
      'origin',
      options.headSha,
      `+refs/heads/${options.baseRef}:${baseTracking}`,
    ]);
    // The engine greps the tree of the head. In a partial clone, git grep fetches each missing blob
    // on its own: 200 files make 200 fetches. One batch first makes that zero.
    const blobs = (await run(repoDir, env, ['ls-tree', '-r', '--format=%(objecttype) %(objectname)', options.headSha]))
      .split('\n')
      .filter((line) => line.startsWith('blob '))
      .map((line) => line.slice(5));
    if (blobs.length > 0) {
      await run(repoDir, env, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin', 'origin'], `${blobs.join('\n')}\n`);
    }
    const base = (await run(repoDir, env, ['rev-parse', '--verify', `${baseTracking}^{commit}`])).trim();
    return { repoDir, base, head: options.headSha, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
