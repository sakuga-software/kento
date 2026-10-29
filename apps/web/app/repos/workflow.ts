// Reads the workflows of a repository and tells which review workflow it still runs, for the
// « Mode » column of the Repos screen. Text only: no YAML parser, no network.

export type WorkflowMode = 'none' | 'reusable' | 'copy'

export interface WorkflowFile {
  /** `.github/workflows/sakuga-review.yml` */
  path: string
  text: string
}

export interface DetectedWorkflow {
  mode: WorkflowMode
  /** The file of the workflow; null with `none`. */
  path: string | null
  /** The ref after `review.yml@` (`stable`, a SHA); null unless `reusable`. */
  ref: string | null
}

/** A job that calls the workflow of sakuga-review: `uses: sakuga-software/sakuga-review/.github/workflows/review.yml@stable`. */
const CALL = /^\s*(?:-\s*)?uses:\s*['"]?sakuga-software\/sakuga-review\/\.github\/workflows\/review\.yml@([A-Za-z0-9._/-]+)/m

/** The script that the job of `review.yml` runs: a copy of the job names it (fruitback, boo). */
const SCRIPT = /review\/sakuga-review\.ts/

/** `review.yml` itself, in sakuga-review: a reusable workflow, not a caller. */
const WORKFLOW_CALL = /^\s*workflow_call\s*:/m

/**
 * The review workflow of a repository: a caller of `review.yml` first, then a copy of its job. A
 * file that GitHub only runs as a reusable workflow (`on: workflow_call`) is neither: it is
 * `review.yml` in sakuga-review itself.
 */
export function detectWorkflow(files: readonly WorkflowFile[]): DetectedWorkflow {
  let sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (let file of sorted) {
    let call = CALL.exec(file.text)
    if (call) return { mode: 'reusable', path: file.path, ref: call[1]! }
  }
  for (let file of sorted) {
    if (SCRIPT.test(file.text) && !WORKFLOW_CALL.test(file.text)) return { mode: 'copy', path: file.path, ref: null }
  }
  return { mode: 'none', path: null, ref: null }
}

/** A workflow file of GitHub Actions: `.yml` or `.yaml`. */
export function isWorkflowFile(name: string): boolean {
  return /\.ya?ml$/i.test(name)
}
