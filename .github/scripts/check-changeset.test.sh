#!/usr/bin/env bash
# The test of check-changeset.sh, on a small workspace with the packages and the config of Kentō.
# It runs the changesets CLI of the repository: run `pnpm install` first.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
script="$repo/.github/scripts/check-changeset.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
fail() { echo "not ok: $1" >&2; echo "$out" >&2; exit 1; }
# Runs the script on the commits since the base, and puts its output in $out and its status in $status.
run() { status=0; out=$("$script" "$base" 2>&1) || status=$?; }
commit() { git add -A && git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m "$1"; }
changeset() { printf -- '---\n%b---\n\n%s\n' "$1" "$2" > ".changeset/$3.md"; }

cd "$root"
git init -q
ln -s "$repo/node_modules" node_modules
mkdir -p .changeset apps/web apps/runner packages/engine packages/protocol
cp "$repo/.changeset/config.json" .changeset/
echo '# Changesets' > .changeset/README.md
printf 'packages:\n  - apps/*\n  - packages/*\n' > pnpm-workspace.yaml
echo '{ "name": "kento", "private": true }' > package.json
for package in apps/web apps/runner packages/engine packages/protocol; do
  echo "{ \"name\": \"@kento-review/${package#*/}\", \"version\": \"0.1.0\", \"private\": true }" > "$package/package.json"
done
changeset '"@kento-review/web": patch\n' 'An old change.' old-change
commit 'main'
base=$(git rev-parse HEAD)

echo 'change' > apps/web/a.ts
commit 'a change with no changeset'
run
[ "$status" -eq 1 ] || fail "a pull request with no changeset fails (status $status)"
grep -q -F 'title=No changeset' <<< "$out" || fail "the error says that the changeset is missing"
grep -q -F 'pnpm changeset --empty' <<< "$out" || fail "the error gives the command of an empty changeset"

git rm -q .changeset/old-change.md
echo '# Changesets, read me' > .changeset/README.md
commit 'remove a changeset and edit the README'
run
[ "$status" -eq 1 ] || fail "a removed changeset or an edited README is no changeset (status $status)"

changeset '"@kento-review/web": patch\n' 'Fix a thing.' fix-a-thing
commit 'a changeset of the product'
run
[ "$status" -eq 0 ] || fail "a changeset of @kento-review/web passes (status $status)"

changeset '' 'Only the CI.' only-the-ci
commit 'an empty changeset'
run
[ "$status" -eq 0 ] || fail "an empty changeset passes (status $status)"

changeset '"@kento-review/runner": patch\n' 'A change of the runner.' runner-change
commit 'a changeset of the runner'
run
[ "$status" -eq 1 ] || fail "a changeset of another package fails (status $status)"
grep -q -F 'file=.changeset/runner-change.md,title=Wrong package' <<< "$out" || fail "the error names the changeset of the wrong package"
git rm -q .changeset/runner-change.md

changeset '"@kento-review/nothing": patch\n' 'A package that is not in the workspace.' unknown
commit 'a changeset of an unknown package'
run
[ "$status" -eq 1 ] || fail "a changeset of an unknown package fails (status $status)"
grep -q -F 'title=Invalid changeset' <<< "$out" || fail "the error says that the changeset is invalid"
git rm -q .changeset/unknown.md

changeset '"@kento-review/web": huge\n' 'A bump that does not exist.' wrong-bump
commit 'a changeset with a wrong bump'
run
[ "$status" -eq 1 ] || fail "a changeset with a wrong bump fails (status $status)"
git rm -q .changeset/wrong-bump.md

commit 'the wrong changesets are gone'
run
[ "$status" -eq 0 ] || fail "the valid changesets pass again (status $status)"

echo "ok: check-changeset.sh"
