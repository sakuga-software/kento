#!/usr/bin/env bash
# The check "Changeset" of a pull request (CONTRIBUTING.md, "Changesets"):
# 1. the pull request adds a changeset, a new file `.changeset/*.md`;
# 2. each changeset that it adds or changes is valid, and names `@kento-review/web` only, the
#    package of the changelog of Kentō. An empty changeset names no package, and passes.
# 3. no changeset asks for a `major` bump while the version is below 1.0 (CONTRIBUTING.md).
# Usage: check-changeset.sh <base>, where <base> is the commit that the pull request merges into.
# Run it at the root of the repository, after `pnpm install` (step 2 runs the changesets CLI).
set -euo pipefail

base=${1:?usage: check-changeset.sh <base commit>}
product='@kento-review/web'
how="Run \`pnpm changeset\`, choose $product, and commit the file that it writes in .changeset/. For a change that nobody who runs or uses Kentō sees (a test, the CI, a refactoring), run \`pnpm changeset --empty\` instead. See CONTRIBUTING.md, section \"Changesets\"."

# `--diff-filter=A`: a deleted or an edited changeset is not a new one. `--no-renames`: git sees a
# changeset that replaces a removed one as a rename, and it is a new one.
added=$(git diff --no-renames --diff-filter=A --name-only "$base" HEAD -- .changeset \
  | grep -E '^\.changeset/[^/]+\.md$' | grep -v -x -F '.changeset/README.md' || true)
if [ -z "$added" ]; then
  echo "::error title=No changeset::This pull request adds no changeset. $how"
  exit 1
fi
echo "New changesets:"
echo "$added"

plan=$(mktemp)
trap 'rm -f "$plan"' EXIT
if ! ./node_modules/.bin/changeset status --since="$base" --output="$plan"; then
  echo "::error title=Invalid changeset::The changesets CLI refused a changeset of this pull request: its error is above. $how"
  exit 1
fi

# The release plan lists each changeset added or changed since <base>, with the packages it names.
PRODUCT="$product" HOW="$how" node --input-type=module - "$plan" <<'EOF'
import { readFileSync } from 'node:fs'
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const version = JSON.parse(readFileSync('apps/web/package.json', 'utf8')).version
let failed = false
for (const changeset of plan.changesets) {
  if (Number(version.split('.')[0]) < 1 && changeset.releases.some((release) => release.type === 'major')) {
    failed = true
    console.log(`::error file=.changeset/${changeset.id}.md,title=Major bump::This changeset asks for a major bump, which would make Kentō 1.0.0. Before 1.0, a change that breaks something is a minor bump (CONTRIBUTING.md, section "Changesets").`)
  }
  const others = changeset.releases.map((release) => release.name).filter((name) => name !== process.env.PRODUCT)
  if (others.length > 0) {
    failed = true
    console.log(`::error file=.changeset/${changeset.id}.md,title=Wrong package::This changeset names ${others.join(', ')}. Name ${process.env.PRODUCT} only: the service and the runner share its version, and its CHANGELOG.md is the one of Kentō.`)
  }
}
process.exit(failed ? 1 : 0)
EOF
echo "The changesets are valid."
