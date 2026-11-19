# Security policy

## Report a vulnerability

Do not open a public issue, pull request or discussion for a vulnerability.

Report it privately on GitHub: in the **Security** tab of this repository, click **Report a
vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Only the maintainers see the report.

Give, as far as you can:

- the affected part (`apps/web`, `apps/runner`, `packages/engine`, `packages/protocol`) and the
  commit or release;
- what an attacker can do, and what they need first (an account, an installation of the App, a
  runner, a write access to a repository);
- the steps to reproduce it, or a proof of concept;
- your suggestion of a fix, if you have one.

Do not send real secrets, private code or personal data in the report. Test only on an instance
that you run yourself, never on an instance of someone else.

What happens next:

1. A maintainer acknowledges the report. We aim to do it within 5 working days.
2. We confirm or refute the issue, and tell you our assessment of its severity.
3. We fix it in the temporary private fork of the advisory, then publish a release and the advisory
   together. We credit you in the advisory, unless you ask us not to.

Keep the issue private until the advisory is published. If we do not answer within 90 days, you may
disclose it.

## Supported versions

Only the latest release of the web service and of the runner gets security fixes. Kentō has no
long-term support branch.

## In scope

- The webhook: the check of its signature, and what an event can make the service do.
- The sign-in of the screens, the sessions, the roles, and the forms.
- The runner API: registration, claims, leases, and the installation token given with a job.
- The keys of the model providers: see [docs/threat-model.md](docs/threat-model.md).
- What the model reads: a prompt injection in a pull request that makes Kentō approve, resolve a
  thread of a person, or leak data from another repository.

Out of scope: a finding that the model gets wrong (a false positive or a missed defect) is a bug,
not a vulnerability. Report it in a public issue.

## The master key

The keys of the providers that the Settings screen stores are encrypted with `KENTO_SECRETS_KEY`.
[docs/threat-model.md](docs/threat-model.md) explains what it protects.

- Generate: `openssl rand -base64 32` (44 characters). Store it in a password manager, and in the
  environment of the `web` service as `KENTO_SECRETS_KEY`. It never goes in git, in an issue or in a
  chat.
- Without it, the screen refuses to store a key (a provider whose key stays on the runner can still
  be added), and no job of a provider with a key runs.
- The log `startup.secrets` gives the id of the master key (16 hex characters of a hash), never the key.

**Rotation:**

1. Generate a new key. Set `KENTO_SECRETS_PREVIOUS_KEYS` to the current key and `KENTO_SECRETS_KEY`
   to the new one, then restart `web`. New keys use the new master key; old ones still decrypt.
2. In the container of `web` (directory `/repo/apps/web`): `node app/providers/rotate-keys.ts`
   (counts, writes nothing), then `node app/providers/rotate-keys.ts --apply`. It prints
   `rotated N, failed 0`.
3. Run the first command again: `0 to rotate`. Then remove `KENTO_SECRETS_PREVIOUS_KEYS` and restart
   `web`.

A lost master key cannot be recovered: every admin must type the keys of their providers again.
