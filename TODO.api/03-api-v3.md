# 03 — API v3: modern HTTP surface (no legacy)

Status (2026-11-01): v3 live on the Workers stack over the storage v2
loader — `src/routes/v3.ts`: `/v3/documents/{key}` (Accept negotiation
for application/json | application/relaton+xml | application/yaml,
`format` override, strong SHA-256 ETag + immutable Cache-Control,
If-None-Match → 304, HEAD), `/v3/documents` (key-ordered cursor paging
with Link headers; flavor/year/doctype/status/q filters; 422
problem+json on a bad cursor), `/v3/flavors` and `/v3/version` from
storage v2, RFC 9457 problem+json errors throughout, XML streamed from
the R2 blobs (406 when none stored). OpenAPI 3.1 descriptions ride the
zod-openapi routes. The cutover landed 2026-11-02: `/api/v1/*` removed from BOTH stacks
(relaton-api-js#117, relaton-api-ruby#9) and the contract moved to
v2.0.0 — twelve fixtures, all v3, each verified live. Remaining:
edge-cache purge on re-ingest; the Worker's /search and /collections
pages still read the v1 tables (the storage unification pass).

Goal: replace `/api/v1/*` entirely. RFC 9457 errors, content negotiation,
edge caching, cursor pagination, navigable relations.

## Surface

```
GET  /v3/documents/{key}    one document by canonical key ("RFC 8446",
                            "std:66" → same record)
                            Accept: application/json (default) |
                            application/relaton+xml | application/yaml
                            ETag, Cache-Control: public, max-age=31536000,
                            immutable per key-version → edge cached
GET  /v3/documents          search: key, title, flavor, year, doctype,
                            status, contributor, relation; cursor + limit;
                            Link headers; include=relations
GET  /v3/flavors            coverage: per-flavor counts + index versions
GET  /v3/version
GET  /openapi.json /docs    OpenAPI 3.1 contract
POST /graphql               see 04-graphql-model.md
```

## Tasks

- [ ] Implement v3 routes (Hono + zod-openapi) over storage v2 loader.
- [ ] Content negotiation: JSON from `data`; XML streamed from R2; YAML
      serialization of `data`.
- [ ] Edge caching: cache API / Cache-Control + ETag; purge strategy on
      re-ingest (key-version bump).
- [ ] problem+json errors (404 unknown key, 422 invalid params); HEAD
      support.
- [ ] Remove `/api/v1/*` routes and compat tests; new contract test suite.
- [ ] OpenAPI 3.1 descriptions + examples for every param/serialization.
- [ ] API_VERSION → 3.0.0 reporting from package version.

## Acceptance

- Repeat fetch of same key served from edge (verifiable via `cf-cache-status`).
- All v3 routes documented in `/docs`; examples executable.
- `/api/v1` returns 410 Gone (one release), then removed.
