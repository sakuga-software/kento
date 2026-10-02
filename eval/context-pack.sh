#!/bin/bash
# context-pack.sh <base sha> > pack.md
# Builds the first message of a review: the diff, then the new version of each
# reviewed file. Run it from the repository root, on the head commit.
set -euo pipefail
BASE=$1
HEAD=$(git rev-parse HEAD)
MAX_FILE_LINES=1500
SKIP='(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$|\.snap$|(^|/)(dist|build|\.next|\.react-router)/|drizzle/migrations/meta/|\.(png|jpe?g|gif|webp|svg|ico|pdf|woff2?|ttf|zip|tgz)$'

reviewed=()
skipped=()
while IFS=$'\t' read -r added removed path; do
  if [[ "$path" =~ $SKIP ]]; then skipped+=("$path: generated or binary"); continue; fi
  if [[ "$added" != "-" && $((added + removed)) -gt 1000 ]]; then skipped+=("$path: more than 1000 changed lines"); continue; fi
  reviewed+=("$path")
done < <(git diff --numstat "$BASE...$HEAD")

echo "# Pull request range $BASE...$HEAD"
echo
echo "## Commits"
echo
git log --format='- %h %s' "$BASE..$HEAD"
echo
if [ ${#skipped[@]} -gt 0 ]; then
  echo "## Not reviewed"
  echo
  printf -- '- %s\n' "${skipped[@]}"
  echo
fi
for doc in CLAUDE.md AGENTS.md; do
  if [ -f "$doc" ] && [ "$(wc -l < "$doc")" -le 400 ]; then
    echo "## $doc"; echo; cat "$doc"; echo
  fi
done
echo "## Diff"
echo
echo "Each hunk shows the whole function around the change. A test file shows three lines of context."
echo
echo '```diff'
for f in "${reviewed[@]}"; do
  if [[ "$f" =~ (\.test\.|\.spec\.|/tests?/|__tests__/) ]]; then
    git diff -U3 "$BASE...$HEAD" -- "$f"
  else
    git diff -W "$BASE...$HEAD" -- "$f"
  fi
done
echo '```'
