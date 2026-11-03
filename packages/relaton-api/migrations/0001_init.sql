-- 0001: initial schema for the relaton document index

CREATE TABLE flavors (
  flavor TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  last_modified TEXT,
  ingested_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  flavor TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'document',
  r2_key TEXT NOT NULL,
  docid TEXT,
  norm TEXT NOT NULL,
  undated_norm TEXT NOT NULL,
  allparts_norm TEXT NOT NULL,
  year INTEGER,
  published TEXT,
  title_en TEXT,
  doctype TEXT,
  status TEXT,
  UNIQUE (flavor, file_path, kind)
);

CREATE INDEX idx_documents_norm ON documents (norm);
CREATE INDEX idx_documents_undated ON documents (undated_norm, year DESC);
CREATE INDEX idx_documents_allparts ON documents (allparts_norm);
CREATE INDEX idx_documents_flavor ON documents (flavor, year DESC);
CREATE INDEX idx_documents_title ON documents (title_en);

CREATE TABLE docids (
  norm TEXT NOT NULL,
  raw TEXT NOT NULL,
  type TEXT,
  document_id INTEGER NOT NULL,
  PRIMARY KEY (norm, document_id)
) WITHOUT ROWID;

CREATE INDEX idx_docids_document ON docids (document_id);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
