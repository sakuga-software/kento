#!/usr/bin/env bash
# The test of check-names.sh, on small repositories of made-up names. It needs no secret, so it
# runs on every pull request, from a fork too.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/check-names.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
fail() { echo "not ok: $1" >&2; exit 1; }
# Runs the script with "$@", and puts its output in $out and its status in $status.
run() { status=0; out=$("$script" "$@" 2>&1) || status=$?; }

# A long name (6 characters or more) and a short one.
printf '# a comment\n\n  zebrafox  \r\nyak\n' > "$root/list.txt"
git init -q "$root/repo"
cd "$root/repo"
mkdir docs code
echo 'the host Zebrafox-7.example.com is down' > docs/a.md
echo 'yakking and yaks are other words' > docs/b.md
echo 'clean' > docs/yak.txt
printf 'const ZEBRAFOX_ID = 1\n' > code/constant.ts
printf 'let zebrafoxLogin = 1\n' > code/camel.ts
printf "let id = 'PRRT_kwDOzebrafox13'\n" > code/node-id.ts
printf 'let repo = "zebrafox2"\n' > code/digit.ts
printf 'a yak-1 runner\n' > code/short.ts
printf 'PNG\0\0\1zebrafox\0' > docs/picture.png
git add -A

run --quiet "$root/list.txt"
[ "$status" -eq 1 ] || fail "a name in a file fails the check (status $status)"
for at in docs/a.md code/constant.ts code/camel.ts code/node-id.ts code/digit.ts code/short.ts; do
  grep -q -F "file=$at,line=1," <<< "$out" || fail "the quiet output gives the path and the line of $at"
done
grep -q -F 'file=docs/picture.png,title=' <<< "$out" || fail "a binary file is read too"
grep -q -F '1 tracked paths hold a name' <<< "$out" || fail "the quiet output counts the paths that hold a name"
! grep -q -i -e zebrafox -e yak <<< "$out" || fail "the quiet output shows no name"
! grep -q -F 'docs/b.md' <<< "$out" || fail "a short name inside a longer word is no match"

run "$root/list.txt"
[ "$status" -eq 1 ] || fail "the verbose check fails too (status $status)"
grep -q -F 'docs/a.md:1:the host Zebrafox-7.example.com is down' <<< "$out" || fail "the verbose output shows the line"
grep -q -F 'path: docs/yak.txt' <<< "$out" || fail "the verbose output shows the path"
grep -q -F 'binary: docs/picture.png' <<< "$out" || fail "the verbose output names the binary file"

git rm -q --cached docs/a.md docs/yak.txt docs/picture.png code/*.ts
run --quiet "$root/list.txt"
[ "$status" -eq 0 ] || fail "a tree with no name passes (status $status)"

printf '# only a comment\n' > "$root/empty.txt"
run --quiet "$root/empty.txt"
[ "$status" -eq 2 ] || fail "an empty list is an error (status $status)"

cd "$root"
run --quiet "$root/list.txt"
[ "$status" -eq 2 ] || fail "outside a git repository, the check fails (status $status)"
grep -q -F 'Not in the work tree' <<< "$out" || fail "outside a git repository, the check says why"

# A git whose `grep` fails with the status 128, as with "dubious ownership".
cd "$root/repo"
git add -A
mkdir "$root/bin"
real_git=$(command -v git)
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && exit 128; done\nexec "%s" "$@"\n' "$real_git" > "$root/bin/git"
chmod +x "$root/bin/git"
status=0; out=$(PATH="$root/bin:$PATH" "$script" --quiet "$root/list.txt" 2>&1) || status=$?
[ "$status" -eq 2 ] || fail "a failure of git grep fails the check (status $status)"

echo 'not an index' > .git/index
run --quiet "$root/list.txt"
[ "$status" -eq 2 ] || fail "a failure of git fails the check (status $status)"

echo "ok: check-names.sh"
