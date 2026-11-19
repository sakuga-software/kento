// The names of one Kentō instance on GitHub and on its screens: the command of the comments, the
// check of a review, the image of the runner and the bots that a new org trusts. `loadConfig` reads
// them from the environment, and `server.ts` installs them with `setInstance` before it serves a
// request. The defaults are the names of the first instance, so an instance without these variables
// behaves as before.
//
// They are settings of the process, as the other variables are. They live here and not in each
// dependency object: the parser of the commands and the texts of the bot and of the screens are pure
// functions, and dozens of them name the command.

export interface Instance {
  /**
   * The names after `@` that start a command in a comment, lowercase, without `@`. The first one is
   * the name that the answers, the review and the screens show. The other ones are aliases.
   */
  commandNames: readonly [string, ...string[]]
  /** The name of the check run of a review. A required check of a branch rule names it. */
  checkName: string
  /** The image of the runner, without a tag, in the `docker run` of the Runners screen. */
  runnerImage: string
  /** The lowercase `name[bot]` logins that a new org trusts. An admin changes them in the settings of the org. */
  defaultTrustedBots: readonly string[]
}

export const DEFAULT_INSTANCE: Instance = Object.freeze({
  commandNames: Object.freeze(['kento-review', 'sakuga-review']) as unknown as readonly [string, ...string[]],
  checkName: 'Sakuga Review',
  runnerImage: 'ghcr.io/sakuga-software/kento-runner',
  defaultTrustedBots: Object.freeze(['sakuga-agent[bot]']),
})

/**
 * The check run that tells a pull request that the cost limit of its org stopped its review. It has
 * its own name, never the one of `checkName`: a required review check then stays missing.
 */
export const CAP_CHECK_NAME = 'Kentō · cap'

let current: Instance = DEFAULT_INSTANCE

/** The names of this instance. */
export function instance(): Instance {
  return current
}

/** Installs the names of the instance. `server.ts` calls it once, at startup; a test restores `DEFAULT_INSTANCE` after it. */
export function setInstance(next: Instance): void {
  current = next
}

/** The name of the command in the texts, without `@`: `kento-review`. */
export function commandName(): string {
  return current.commandNames[0]
}

/** The command as a person writes it, with `@` and its arguments: `mention('reject <cause>')` is `@kento-review reject <cause>`. */
export function mention(rest = ''): string {
  return rest === '' ? `@${commandName()}` : `@${commandName()} ${rest}`
}
