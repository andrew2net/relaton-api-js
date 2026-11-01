-- 0008: the UNIQUE (flavor, file) constraint on documents_v2 does not hold
-- against real datasets — relaton-data-iana's machine index maps several
-- keys to one file (sub-registry rows inside the registry document). A
-- document is identified by its key; the file is informational. SQLite
-- cannot drop a table constraint, so the tables are recreated; production
-- rows at this point are probe-era and rebuilt by re-ingest.
PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS doc_keys;
DROP TABLE IF EXISTS titles;
DROP TABLE IF EXISTS identifiers;
DROP TABLE IF EXISTS dates;
DROP TABLE IF EXISTS contributors;
DROP TABLE IF EXISTS relations;
DROP TABLE IF EXISTS classifications;
DROP TABLE IF EXISTS documents_v2;

CREATE TABLE documents_v2 (
  key TEXT PRIMARY KEY,          -- dataset-provided canonical id (e.g. "RFC 8446")
  flavor TEXT NOT NULL,
  file TEXT NOT NULL,            -- dataset-relative path (not unique)
  data TEXT NOT NULL,            -- full model JSON, lossless
  indexed_at TEXT NOT NULL
);
CREATE INDEX idx_documents_v2_flavor ON documents_v2(flavor);

CREATE TABLE doc_keys (
  key TEXT NOT NULL,
  document TEXT NOT NULL REFERENCES documents_v2(key) ON DELETE CASCADE,
  PRIMARY KEY (key, document)
) WITHOUT ROWID;

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
