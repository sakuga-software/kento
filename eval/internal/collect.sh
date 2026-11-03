#!/usr/bin/env bash
# The review comments of the repositories of the org since a date, one JSON array a repository.
#   eval/internal/collect.sh <out dir> <since, ISO date> <repo>...
set -euo pipefail
out=$1 since=$2
shift 2
mkdir -p "$out"
for repo in "$@"; do
  gh api --paginate "repos/sakuga-software/$repo/pulls/comments?per_page=100&since=$since" | jq -s add > "$out/$repo.json"
  echo "$repo: $(jq length "$out/$repo.json") comments"
done
