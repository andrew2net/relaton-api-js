# 05 — Relaton JSON Schema (published contract for the JSON serialization)

Status (2026-11-01): shipped — the authoritative schemas live in the
`relaton` npm package (schema/bib-item.schema.json + ietf-item.schema.json,
generated from relaton/relaton lutaml, source pinned in schema/manifest.json),
and the API serves them at `/schema/relaton-{bib-item,ietf-item}.json`
(immutable, `application/schema+json`) with a `/schema` index carrying the
source pin. Deliberately parked: hard ingest-time rejection — the generated
v1.5 model schema (`additionalProperties: false`) rejects the v1.2-era
dataset dialects storage v2 legitimately serves (docid/id, format-titles),
so strict validation is a model-level ruling, not an API patch. Consumers
can validate today: `curl /schema/relaton-bib-item.json`.

Goal: a versioned JSON Schema for the API's JSON serialization, derived from
relaton-models, so consumers (SDOs, the site, CI) can validate responses.

## Tasks

- [x] Authoritative source picked: relaton/relaton lutaml → relaton-ts
      schema/*.schema.json (generated, source-pinned) — shipped in the
      package from 0.1.6.
- [x] Served at `/schema/relaton-{bib-item,ietf-item}.json` with a `/schema`
      index; the OpenAPI components reference stays follow-up.
- [ ] Validate v3 JSON responses against the schema in CI — parked with the
      model-level ruling on legacy-dialect acceptance (see status).

## Acceptance

- A consumer can `curl /v3/documents/rfc-8446 | validate relaton-1.5.json`.
- Ingest pipeline rejects schema-invalid documents before they reach D1.
