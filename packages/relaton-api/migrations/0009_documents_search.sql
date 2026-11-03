-- 0009: the query-side projection of storage v2 (TODO.api/03 remaining
-- item). The v1 `documents` table was the live search/collections/MCP
-- store; this table carries the same query shape, derived mechanically
-- from documents_v2.data at ingest — one row per document, no producer
-- change. FTS5 rides the same external-content pattern as 0003.
CREATE TABLE documents_search (
  key TEXT PRIMARY KEY REFERENCES documents_v2(key) ON DELETE CASCADE,
  flavor TEXT NOT NULL,
  file TEXT NOT NULL,            -- dataset-relative path (entry keys strip the extension)
  docid TEXT,                    -- primary docidentifier raw
  title TEXT,                    -- main (en-preferred) title
  year INTEGER,                  -- published date year
  doctype TEXT,
  status TEXT,                   -- status.stage
  abstract TEXT,
  norm TEXT NOT NULL,            -- lookup tokens (pubid derivation, same as v1)
  undated_norm TEXT NOT NULL,
  allparts_norm TEXT NOT NULL,
  publisher TEXT,                -- pubid components of the primary docid
  number TEXT,
  part TEXT,
  edition TEXT,
  embedded_at TEXT               -- vector re-embed cursor (admin/embed-search)
);

CREATE INDEX idx_ds_norm ON documents_search (norm);
CREATE INDEX idx_ds_undated ON documents_search (undated_norm, year DESC);
CREATE INDEX idx_ds_allparts ON documents_search (allparts_norm);
CREATE INDEX idx_ds_flavor ON documents_search (flavor, year DESC);
CREATE INDEX idx_ds_pubnum ON documents_search (publisher, number);

CREATE VIRTUAL TABLE documents_search_fts USING fts5(
  docid,
  title,
  abstract,
  content='documents_search',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER documents_search_fts_ai AFTER INSERT ON documents_search BEGIN
  INSERT INTO documents_search_fts(rowid, docid, title, abstract)
  VALUES (new.rowid, new.docid, new.title, new.abstract);
END;

CREATE TRIGGER documents_search_fts_ad AFTER DELETE ON documents_search BEGIN
  INSERT INTO documents_search_fts(documents_search_fts, rowid, docid, title, abstract)
  VALUES ('delete', old.rowid, old.docid, old.title, old.abstract);
END;

CREATE TRIGGER documents_search_fts_au AFTER UPDATE OF docid, title, abstract ON documents_search BEGIN
  INSERT INTO documents_search_fts(documents_search_fts, rowid, docid, title, abstract)
  VALUES ('delete', old.rowid, old.docid, old.title, old.abstract);
  INSERT INTO documents_search_fts(rowid, docid, title, abstract)
  VALUES (new.rowid, new.docid, new.title, new.abstract);
END;
