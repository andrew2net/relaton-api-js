-- 0005: pubid component columns for the cross-flavor component search
-- (publisher / number / part / edition), populated by the ingest pipeline
-- from each record's primary docidentifier.
ALTER TABLE documents ADD COLUMN publisher TEXT;
ALTER TABLE documents ADD COLUMN number TEXT;
ALTER TABLE documents ADD COLUMN part TEXT;
ALTER TABLE documents ADD COLUMN edition TEXT;

CREATE INDEX idx_documents_publisher_number ON documents (publisher, number);
