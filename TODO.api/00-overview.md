# 00 — Relaton API master plan

Status: active (2026-10-28, rev 3: status refresh after the index-v2 and
machine-index rollout; phase files 01-06 and 09-10 restored from the
`todo-01-progress` tree). Each phase has its own file (`{n}-{name}.md`).

## Principles (rulings from this session)

1. **No legacy API support.** `/api/v1/*` is removed (410 for one release).
   v3 semantics replace it.
2. **Structured data, never smushed.** D1 stores each document as its full
   model JSON; queries hit mechanical projections and dataset-provided
   lookup keys. No lossy flattening.
3. **Identifier semantics live in the datasets, not the API** (relaton#109
   pattern). The API imports keys as opaque tokens.
4. **Three-repo decomposition** (rev 2, supersedes the single-hub plan):
   - `relaton/relaton-api-js` → publishes npm `@relaton/api` (library +
     CLI); ships the contract artifacts (OpenAPI 3.1 + JSON Schema +
     conformance fixtures). Current `-workers` repo, repurposed.
   - `relaton/relaton-api-ruby` → gem `relaton-api` (Rack app); history via
     `git subtree split` from the old repo; conformance CI against the
     published spec.
   - `relaton/api.relaton.org` → pure deployment/configuration repo
     (relaton-api.yaml, 3-line entries, workflows, secrets, this TODO tree).
5. **Third-party SDOs deploy by configuration only** — either stack, from
   published packages. Deploy = config diff; rollback = version pin.

## Code-quality constitution (applies to every repo, enforced in review)

- Model-driven, semantically-driven: code mirrors the Relaton model; wire
  names come from mappings, never hand-rolled serialization.
- OCP: new flavor / serialization / key source = new config or registry
  entry, never a switch statement edit.
- MECE + DRY: each concern in exactly one place; three similar lines beat a
  wrong abstraction.
- Performance: edge caching by default; D1 queries hit indexes; no
  per-request derivation.
- Ruby: **autoload only** within the library (autoloads declared in the
  immediate parent namespace's file, created if absent) — never
  `require_relative`/`require` of our own files; never `send` to private
  methods; never `instance_variable_set/get`; never `respond_to?` typing.
- Specs throughout: every package ships conformance/contract tests; no
  behavior without a spec.

## Phase map

| # | File | Phase | Status |
|---|---|---|---|
| 01 | 01-ietf-unified-dataset.md | IETF dataset (#109) | dataset shipped as index-v2; API import switch pending |
| 02 | 02-storage-v2.md | D1 schema v2 | **live and rolling out** (schema + ingest-v2/reconcile-v2 + producer shipped; fleet rollout in progress — see 02 status) |
| 03 | 03-api-v3.md | v3 surface | **done** — v3 is the only REST surface on both stacks; /api/v1 removed 2026-11-02 (contract v2.0.0 v3-only) |
| 04 | 04-graphql-model.md | model-typed GraphQL | **live** (replaced the flat schema; filters share the v3 SQL; relation traversal) |
| 05 | 05-json-schema.md | JSON Schema contract | **live** (`/schema` serves the package-shipped schemas; strict ingest validation parked on a model ruling) |
| 06 | 06-index-contract-all-flavors.md | index rollout | **in progress** (machine index v2 live; dataset alias keys imported and bare-variant derivation made structural — relaton-api-js#87/#88, relaton#395; query side pending) |
| 07 | 07-npm-package.md | `@relaton/api` | **in progress** (library + CLI init/check/deploy/ingest done; npm publish + dogfood instance pending) |
| 08 | 08-repo-decomposition.md | three-repo split | **in progress** (repos live: relaton-api-js + relaton-api-ruby + deployment; remaining: v1-table cleanup in the Worker — /search + /collections still read the v1 documents table — and the dogfood instance) |
| 09 | 09-site-integration.md | relaton.org on v3 | **live** (v3 demo with format negotiation, v3-first API page, per-flavor query links) |
| 10 | 10-observability-ops.md | ops | **live in-repo** (AE datapoints, structured logs, rate-limit hook, runbook; dashboard/cron-export activation is deployment-side) |
| 11 | 11-ruby-gem.md | `relaton-api` gem | **live on rubygems** (3.0.x via trusted publishing; v1+v3 surfaces; contract held in CI) |
| 12 | 12-conformance-suite.md | shared contract tests | **done** — contract v2.0.0 (12 fixtures, v3-only), versioned and SHA-pinned in the Ruby CI per contract/README.md; daily production drift alarm |
| 13 | 13-code-quality-refactor.md | constitution applied | **in progress** (tools autoload refactor done; TS pass done) |
| 14 | 14-key-semantics.md | key derivation | resolved |

## Current state (2026-10-28)

Production: https://api.relaton.org on the `api-relaton-org` Worker (D1 v1 +
R2). REST is still `/api/v1/{document,search,version}`, alongside the
cloud-store collections, `/graphql`, and the machine-index contract
(`/:flavor/index/manifest.json` + `shard-NNNNN.json`). Component search
(publisher/number/part/edition) is live.

The all-parts family builder explored on the `all-parts-family` and
`combined` branches was not adopted: main answers all_parts from stored
aggregate rows (`allparts_norm`). The plan files from those branches are
restored here.
