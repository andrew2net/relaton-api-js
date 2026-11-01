-- 0007: storage v2 (TODO.api/02) — the document unit is the model's JSON.
-- v1 tables (documents/docids/flavors) stay live until re-ingest; the
-- cutover migration drops them and renames these into place.

CREATE TABLE documents_v2 (
  key TEXT PRIMARY KEY,          -- dataset-provided canonical id (e.g. "RFC 8446")
  flavor TEXT NOT NULL,
  file TEXT NOT NULL,            -- dataset-relative path
  data TEXT NOT NULL,            -- full model JSON, lossless
  indexed_at TEXT NOT NULL,
  UNIQUE (flavor, file)
);

-- Dataset-provided lookup tokens, imported verbatim — never derived here.
CREATE TABLE doc_keys (
  key TEXT NOT NULL,
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  PRIMARY KEY (key, document)
) WITHOUT ROWID;

-- Mechanical projections of `data`, regenerable at any time.
CREATE TABLE titles (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  lang TEXT,
  type TEXT,
  text TEXT NOT NULL
);
CREATE INDEX idx_titles_doc ON titles(document);

CREATE TABLE identifiers (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  type TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_identifiers_doc ON identifiers(document);

CREATE TABLE dates (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  type TEXT,
  on_date TEXT
);
CREATE INDEX idx_dates_doc ON dates(document);

CREATE TABLE contributors (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  role TEXT,
  name TEXT,
  org_abbrev TEXT
);
CREATE INDEX idx_contributors_doc ON contributors(document);

CREATE TABLE relations (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  type TEXT,
  target TEXT
);
CREATE INDEX idx_relations_doc ON relations(document);

CREATE TABLE classifications (
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  type TEXT,
  value TEXT NOT NULL
);
CREATE INDEX idx_classifications_doc ON classifications(document);

CREATE TABLE flavors_v2 (
  flavor TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  last_modified TEXT,
  indexed_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL DEFAULT 0
);
