-- The reconcile's stale-row scans (bulk import file and the worker route)
-- filter documents_v2 by (flavor, indexed_at); without this index a
-- flavor-wide DELETE walks every row of the flavor per statement, and the
-- D1 import endpoint's gateway kills the whole file at ~60s ("Upstream
-- service unavailable [code: 7009]", 2026-11-12 iso legs).
CREATE INDEX IF NOT EXISTS documents_v2_flavor_indexed_at
  ON documents_v2 (flavor, indexed_at);
