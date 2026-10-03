#!/usr/bin/env bash
# Clone each repository of a subset without blobs, and fetch the base and head commits of each pull
# request by SHA. The internal repositories are private: git needs credentials for github.com.
#
#     eval/martian/fetch.sh eval/martian/subset-ts.json <repos dir>
set -euo pipefail
subset=$1
repos=$2
mkdir -p "$repos"
jq -r '.[] | "\(.owner) \(.name) \(.base) \(.head)"' "$subset" | while read -r owner name base head; do
  dir="$repos/${owner}__${name}"
  [ -d "$dir" ] || git clone -q --filter=blob:none --no-checkout "https://github.com/$owner/$name.git" "$dir"
  for sha in "$base" "$head"; do
    git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$dir" fetch -q --filter=blob:none origin "$sha"
  done
  echo "$owner/$name ${head:0:7}"
done
