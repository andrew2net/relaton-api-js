#!/usr/bin/env bash
# Embeds documents_search rows (docid + title + abstract) into the
# Vectorize index keyed by { key, flavor } metadata, walking the paged
# /admin/embed-search route until exhausted. Resumable by cursor and by
# the embedded_at column (re-runs skip completed rows).
# Requires ADMIN_TOKEN in the environment.
set -euo pipefail
BASE_URL="${BASE_URL:-https://api.relaton.org}"
LIMIT="${LIMIT:-100}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"

cursor=""
total=0
while :; do
  url="$BASE_URL/admin/embed-search?limit=$LIMIT"
  [ -n "$cursor" ] && url="$url&cursor=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$cursor")"
  resp=$(curl -s -X POST "$url" -H "Authorization: Bearer $ADMIN_TOKEN")
  next=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('nextCursor') or '')" <<<"$resp" 2>/dev/null || true)
  embedded=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('embedded', 0))" <<<"$resp" 2>/dev/null || echo 0)
  total=$((total + embedded))
  echo "cursor=${cursor:0:30} embedded=$embedded total=$total"
  [ -n "$next" ] || break
  cursor=$next
done
echo "embed-search complete: $total vectors"
