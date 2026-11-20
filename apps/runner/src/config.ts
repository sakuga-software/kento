// The settings of the runner, read once from the environment at startup.
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProviderKind, PROVIDER_KINDS, type ProviderKind } from '@kento-review/protocol';

export type Config = {
  /** The web service, for example https://review.sakuga.dev. */
  kentoUrl: string;
  /** The secret to register when the runner has no token yet. */
  registrationToken: string | null;
  name: string;
  labels: string[];
  /** Holds runner.json: the id and the token of the runner, after its registration. */
  stateDir: string;
  /** Where the runner clones each job. Removed after each job. */
  workDir: string;
  /**
   * The runner's own provider: its key, or its own server (Ollama needs no key). `own` is the kind
   * that the runner calls without a key of the service, or null when it has neither.
   */
  provider: { kind: ProviderKind; baseUrl: string | undefined; apiKey: string | null; own: ProviderKind | null };
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** Throws a ConfigError that names every invalid variable. The message never holds a value. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];

  const kentoUrl = (env.KENTO_URL ?? '').trim().replace(/\/+$/, '');
  // HTTPS, except to this machine for a local test: the runner token travels in a header.
  if (!/^https:\/\/[^\s/@]+/.test(kentoUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(kentoUrl)) {
    problems.push('KENTO_URL must be an https:// URL');
  }

  const labels = (env.KENTO_RUNNER_LABELS ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.some((label) => !LABEL.test(label)) || labels.length > 20) {
    problems.push('KENTO_RUNNER_LABELS must be at most 20 labels of letters, digits, dots, dashes or underscores, separated by commas');
  }

  const name = (env.KENTO_RUNNER_NAME ?? '').trim() || hostname().slice(0, 100);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) problems.push('KENTO_RUNNER_NAME must be letters, digits, dots, dashes or underscores');

  const kind = (env.PROVIDER_KIND ?? 'openrouter').trim();
  if (!isProviderKind(kind)) problems.push(`PROVIDER_KIND must be one of ${PROVIDER_KINDS.join(', ')}`);

  const baseUrl = (env.PROVIDER_BASE_URL ?? '').trim() || undefined;
  // HTTPS: the key travels in a header. Ollama has no key, and often runs on this machine or on the
  // private network of the runner: HTTP is allowed for it only.
  const urlPattern = kind === 'ollama' ? /^https?:\/\/[^\s@]+$/ : /^https:\/\/[^\s@]+$/;
  if (baseUrl !== undefined && !urlPattern.test(baseUrl)) {
    problems.push(kind === 'ollama' ? 'PROVIDER_BASE_URL must be an http:// or https:// URL' : 'PROVIDER_BASE_URL must be an https:// URL');
  }
  const apiKey = env.PROVIDER_API_KEY?.trim() || null;
  if (kind === 'openai_compatible' && apiKey && !baseUrl) problems.push('PROVIDER_BASE_URL is required with PROVIDER_KIND=openai_compatible');

  if (problems.length > 0) throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);

  return {
    kentoUrl,
    registrationToken: env.KENTO_REGISTRATION_TOKEN?.trim() || null,
    name,
    labels,
    stateDir: (env.KENTO_STATE_DIR ?? '').trim() || '/var/lib/kento-runner',
    workDir: (env.KENTO_WORK_DIR ?? '').trim() || join(tmpdir(), 'kento-runner'),
    provider: { kind: kind as ProviderKind, baseUrl, apiKey, own: apiKey || kind === 'ollama' ? (kind as ProviderKind) : null },
  };
}
