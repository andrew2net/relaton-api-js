-- Full-text search over identifiers, titles, and abstracts. External
-- content keeps the index in sync with ingest updates and the abstract/
-- status backfills via triggers; rows predating the triggers are filled
-- by the paged /admin/populate-fts walk.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  docid,
  title_en,
  abstract,
  content='documents',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, docid, title_en, abstract)
  VALUES (new.id, new.docid, new.title_en, new.abstract);
END;

CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, docid, title_en, abstract)
  VALUES ('delete', old.id, old.docid, old.title_en, old.abstract);
END;

CREATE TRIGGER documents_fts_au AFTER UPDATE OF docid, title_en, abstract ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, docid, title_en, abstract)
  VALUES ('delete', old.id, old.docid, old.title_en, old.abstract);
  INSERT INTO documents_fts(rowid, docid, title_en, abstract)
  VALUES (new.id, new.docid, new.title_en, new.abstract);
END;
