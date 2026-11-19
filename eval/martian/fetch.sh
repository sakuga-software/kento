#!/usr/bin/env bash
# Clone each repository of a subset without blobs, and fetch the base and head commits of each pull
# request by SHA. The subset is one JSON file, or several separated by commas, as for run.ts. The
# repositories of the internal bench are private: git needs credentials for github.com.
#
#     eval/martian/fetch.sh eval/martian/subset-ts.json <repos dir>
set -euo pipefail
IFS=, read -ra subsets <<< "$1"
repos=$2
mkdir -p "$repos"
jq -r '.[] | "\(.owner) \(.name) \(.base) \(.head)"' "${subsets[@]}" | while read -r owner name base head; do
  dir="$repos/${owner}__${name}"
  [ -d "$dir" ] || git clone -q --filter=blob:none --no-checkout "https://github.com/$owner/$name.git" "$dir"
  for sha in "$base" "$head"; do
    git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$dir" fetch -q --filter=blob:none origin "$sha"
  done
  # The review greps the source files at the head. In a clone without blobs, git fetches each one
  # on its own: fetch them in one batch.
  git -C "$dir" ls-tree -r "$head" | grep -E '\.(ts|tsx|mts|cts|js|jsx|mjs)$' | awk '{print $3}' |
    git -C "$dir" -c fetch.negotiationAlgorithm=noop fetch -q --no-tags --no-write-fetch-head --filter=blob:none origin --stdin
  echo "$owner/$name ${head:0:7}"
done
