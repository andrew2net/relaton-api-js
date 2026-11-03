#!/usr/bin/env bash
# Rebuilds documents_search (the query-side v2 projection) from the stored
# documents_v2 JSON, walking the paged /admin/build-search route until
# exhausted. No flavor argument: the walk is key-ordered across flavors.
# Requires ADMIN_TOKEN in the environment.
set -euo pipefail
BASE_URL="${BASE_URL:-https://api.relaton.org}"
LIMIT="${LIMIT:-300}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"

cursor=""
total=0
while :; do
  url="$BASE_URL/admin/build-search?limit=$LIMIT"
  [ -n "$cursor" ] && url="$url&cursor=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$cursor")"
  resp=$(curl -s -X POST "$url" -H "Authorization: Bearer $ADMIN_TOKEN")
  next=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('nextCursor') or '')" <<<"$resp" 2>/dev/null || true)
  scanned=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('scanned', 0))" <<<"$resp" 2>/dev/null || echo 0)
  total=$((total + scanned))
  echo "cursor=${cursor:0:30} scanned=$scanned total=$total"
  [ -n "$next" ] || break
  cursor=$next
done
echo "build-search complete: $total rows"
