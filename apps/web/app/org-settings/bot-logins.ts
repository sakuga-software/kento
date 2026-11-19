// The logins of the bots that an org trusts, as a person writes them in the settings or in
// KENTO_DEFAULT_TRUSTED_BOTS. Pure functions with no import: `loadConfig` reads them at startup,
// before the names of the instance are installed.

export const MAX_TRUSTED_BOTS = 20
/** A login of a GitHub App bot: the slug of the App (39 characters at most), then `[bot]`. */
export const BOT_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})\[bot\]$/

/**
 * A list of bot logins, one per line or separated by commas, lowercase. `renovate` becomes
 * `renovate[bot]`: a person is never a trusted bot. The form of the settings and the variable
 * KENTO_DEFAULT_TRUSTED_BOTS read it. The error never holds more than 60 characters of the text.
 */
export function parseBotLogins(text: string): { ok: true; value: string[] } | { ok: false; error: string } {
  let logins = text
    .split(/[\s,]+/)
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
    .map((login) => (login.endsWith('[bot]') ? login : `${login}[bot]`))
  let unique = [...new Set(logins)]
  if (unique.length > MAX_TRUSTED_BOTS) return { ok: false, error: `${MAX_TRUSTED_BOTS} bots at most.` }
  let wrong = unique.find((login) => !BOT_LOGIN.test(login))
  if (wrong) {
    return {
      ok: false,
      error: `"${wrong.slice(0, 60)}" is not the login of a bot. A bot login is the name of a GitHub App followed by [bot], for example renovate[bot].`,
    }
  }
  return { ok: true, value: unique }
}
