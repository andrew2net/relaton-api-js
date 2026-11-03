-- Ingest generation marker: every ingest chunk stamps the rows it wrote,
-- so a post-wave reconcile can delete rows whose file_path was not seen
-- by the current generation (ghost rows from renamed/churned documents
-- -- ietf's expired internet-drafts alone doubled its row count).
ALTER TABLE documents ADD COLUMN ingested_at TEXT;
CREATE INDEX idx_documents_flavor_ingested ON documents (flavor, ingested_at);
