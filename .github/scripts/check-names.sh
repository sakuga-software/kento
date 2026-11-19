#!/usr/bin/env bash
# Fails when a tracked file of the work tree holds a name of a list: a private repository, an
# internal host, a person. The list is not in the repository. The Secrets workflow reads it from the
# secret PRIVATE_NAMES of the environment names-check (.github/workflows/secrets.yml).
#
#   .github/scripts/check-names.sh [--quiet] <list file>
#
# The list holds one name per line. A blank line or a line that starts with `#` does not count.
# Each name is a fixed string, matched case-insensitively:
# - a name of 6 characters or more matches anywhere, also inside a longer word (NAME_ID, nameLogin);
# - a shorter name matches only as a whole word, so that a short common word does not match
#   everywhere. Letters, digits and `_` make a word; `-`, `.` and `/` end it.
# The script reads the content of every tracked file, binary files too, and the tracked paths.
#
# Without --quiet, the script prints each line that holds a name. With --quiet (in CI, whose logs can
# be public), it prints only the path and the line number, and only the number of the paths that
# hold a name, so that the log never shows a name.
#
# Exit codes: 0 no name, 1 a name, 2 a usage error or a failure of git.
set -euo pipefail
export LC_ALL=C.UTF-8

quiet=false
if [ "${1:-}" = --quiet ]; then quiet=true; shift; fi
if [ $# -ne 1 ] || [ ! -r "$1" ]; then
  echo "usage: $0 [--quiet] <list file>" >&2
  exit 2
fi
if [ "$(git rev-parse --is-inside-work-tree 2> /dev/null)" != true ]; then
  echo "Not in the work tree of a git repository." >&2
  exit 2
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/check-names.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Remove the carriage returns, the spaces around each name, the blank lines and the comments.
tr -d '\r' < "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | { grep -v -e '^$' -e '^#' || true; } > "$work/all"
if [ ! -s "$work/all" ]; then
  echo "The list holds no name." >&2
  exit 2
fi
awk 'length($0) >= 6' "$work/all" > "$work/long"
awk 'length($0) < 6' "$work/all" > "$work/short"

# Runs grep or git grep, and keeps its status 1 (no match) apart from a failure (2 or more).
search() {
  local status=0
  "$@" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "$1 failed with the status $status." >&2
    exit 2
  fi
}

# The lines of stdin that hold a name.
match_lines() {
  local input="$work/input.$RANDOM"
  cat > "$input"
  if [ -s "$work/long" ]; then search grep -i -F -f "$work/long" "$input"; fi
  if [ -s "$work/short" ]; then search grep -i -w -F -f "$work/short" "$input"; fi
}

# `git grep` over the tracked files, with the options in "$@", once for each kind of name.
grep_tree() {
  if [ -s "$work/long" ]; then search git -c core.quotePath=false grep "$@" -i -F -f "$work/long"; fi
  if [ -s "$work/short" ]; then search git -c core.quotePath=false grep "$@" -i -w -F -f "$work/short"; fi
}

found=0

# The paths of the tracked files, not quoted, so that a name with an accent is seen as is.
if ! git -c core.quotePath=false ls-files > "$work/paths"; then
  echo "git ls-files failed." >&2
  exit 2
fi
match_lines < "$work/paths" | sort -u > "$work/bad-paths"
if [ -s "$work/bad-paths" ]; then
  found=1
  if $quiet; then
    echo "::error title=Private names::$(wc -l < "$work/bad-paths" | tr -d ' ') tracked paths hold a name of the list. Run the script without --quiet on your machine to see them."
  else
    sed 's/^/path: /' "$work/bad-paths"
  fi
fi

# The text files, line by line. `-I` skips the binary files, which the next step reads.
grep_tree -I -n | sort -u > "$work/lines"
# The files that hold a name, binary files too.
grep_tree -l | sort -u > "$work/files"
grep_tree -I -l | sort -u > "$work/text-files"
comm -23 "$work/files" "$work/text-files" > "$work/binary-files"

if [ -s "$work/lines" ] || [ -s "$work/binary-files" ]; then
  found=1
  if $quiet; then
    # A path that holds a name is counted above and not printed here.
    while IFS= read -r line; do
      at=${line%%:*}; rest=${line#*:}; number=${rest%%:*}
      if ! grep -q -x -F -e "$at" "$work/bad-paths"; then
        echo "::error file=$at,line=$number,title=Private names::This line holds a name of the list."
      fi
    done < "$work/lines"
    while IFS= read -r at; do
      if ! grep -q -x -F -e "$at" "$work/bad-paths"; then
        echo "::error file=$at,title=Private names::This binary file holds a name of the list."
      fi
    done < "$work/binary-files"
  else
    cat "$work/lines"
    sed 's/^/binary: /' "$work/binary-files"
  fi
fi

if [ "$found" -eq 1 ]; then
  echo "Replace each name with a neutral one (README.md, section CI)." >&2
  exit 1
fi
echo "No name of the list in the tracked files."
