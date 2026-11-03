-- 0002: searchable abstracts
-- Abstracts are extracted from the stored records at ingest time and
-- searched with LIKE (opt-in via the API's in_abstract flag). An FTS5
-- table can replace the LIKE scan when volume demands it.

ALTER TABLE documents ADD COLUMN abstract TEXT;
