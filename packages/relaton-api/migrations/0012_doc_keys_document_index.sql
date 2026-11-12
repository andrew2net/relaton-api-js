-- doc_keys is WITHOUT ROWID with PRIMARY KEY (key, document): deletes by
-- document (the reconcile rounds, the chunk deletes, the FK cascade)
-- cannot use the PK and full-scanned the table on every statement. Every
-- sibling child table got an idx_*_doc in 0008; doc_keys never did. This
-- index is what lets the bulk reconcile fit the D1 import gateway's
-- window (2026-11-12 iso legs: CPU-cap reset at 80 rounds x full scans).
CREATE INDEX IF NOT EXISTS idx_doc_keys_doc ON doc_keys (document);
