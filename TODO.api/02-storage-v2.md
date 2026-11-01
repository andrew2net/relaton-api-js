# 02 — Storage v2: structured documents in D1

Status (2026-11-01): slices 1-2 shipped — `migrations/0007_storage_v2.sql`
(`documents_v2`/`doc_keys`/six projection tables/`flavors_v2`, v1 stays
live until cutover), `POST /admin/ingest-v2/:flavor` (rows carry the
lossless model JSON + dataset-provided keys; projections are rebuilt
mechanically from `data` server-side, so a projection change needs no
producer change), the `src/lib/storage2.ts` loader
(`getDocument`/`getDocumentByLookupKey`), `POST /admin/reconcile-v2/
:flavor`, and the producer: `src/ingest/produce.ts` walks a flavor's
Pages machine index, loads each dataset document, and yields chunks the
CLI posts live (`relaton-api ingest <flavor> --v2`, `--from-chunk`/
`--limit`/`--chunk-size`; a truncated wave never stamps `final`, so the
ghost cleanup cannot eat unreached rows). pubid-ts's internal imports
carry explicit `.ts`/`with { type: "json" }` forms so plain node can run
the CLI. Remaining: the full re-ingest run per flavor, v3 routes over
the loader, then the v1 cutover.

Goal: stop smushing. The document unit is the model's JSON; queries hit
mechanical projections and dataset-provided keys. No lossy columns.

## Schema

```sql
-- canonical unit: full model JSON (from dataset YAML), lossless
CREATE TABLE documents (
  key TEXT PRIMARY KEY,          -- dataset-provided canonical id (e.g. "RFC 8446")
  flavor TEXT NOT NULL,
  file TEXT NOT NULL,            -- dataset-relative path
  data TEXT NOT NULL,            -- full model JSON
  indexed_at TEXT NOT NULL,
  UNIQUE (flavor, file)
);

-- dataset-provided lookup tokens (imported, never derived)
CREATE TABLE doc_keys (
  key TEXT NOT NULL,             -- opaque token (uppercase, whitespace-stripped)
  document TEXT NOT NULL REFERENCES documents(key) ON DELETE CASCADE,
  PRIMARY KEY (key, document)
) WITHOUT ROWID;

-- mechanical projections of `data` (regenerable at any time)
titles(doc, lang, type, text); identifiers(doc, raw, type, primary);
dates(doc, type, on); contributors(doc, role, name, org_abbrev);
relations(doc, type, target); classifications(doc, type, value) -- ICS, etc.
```

R2 keeps precomputed bibdata XML per document (for the XML serialization).

## Tasks

- [ ] migrations/0002_storage_v2.sql (new tables; drop v1 `documents`/
      `docids`/`flavors` columns in 0003 after cutover).
- [ ] Ingest v2: import dataset index entries → `doc_keys` + summary; store
      `data` JSON; build projections mechanically from JSON (one Ruby
      projector in tools/); YAML→XML to R2 (unchanged).
- [ ] Loader service in Worker: `getDocument(key)` reads `data`, parses
      lazily, typed accessors shared by REST + GraphQL.
- [ ] Re-ingest all flavors from datasets (one pass, same posting machinery).
- [ ] Delete: v1 norm/undated/allparts derivation from Worker (`src/lib/
      normalize.ts`, `lookup.ts` key logic), `title_en`-style columns.

## Acceptance

- Every GraphQL field backed by structured data (all titles/languages,
  relations, contributors), zero string-flattened columns in the schema.
- Flavors whose datasets ship #109 indexes import keys verbatim; API-side
  key derivation code count: zero lines for those flavors.
- Full re-ingest of ~400k docs completes with existing chunk tooling.
