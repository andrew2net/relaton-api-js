-- 0010: retire the v1 storage (TODO.api/03 storage unification). The v1
-- tables fed /search, /collections, and MCP before documents_search
-- (0009) took over; the fleet backfill (build-search) and the engine
-- component walk have filled the v2 projection, so the v1 store, its FTS
-- and its docids are dead weight. Historical migrations 0001-0006 stay in
-- the tree for fresh-database replay; this migration drops their tables.
DROP TRIGGER IF EXISTS documents_fts_ai;
DROP TRIGGER IF EXISTS documents_fts_ad;
DROP TRIGGER IF EXISTS documents_fts_au;
DROP TABLE IF EXISTS documents_fts;
DROP TABLE IF EXISTS docids;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS flavors;
