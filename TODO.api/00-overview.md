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
| 02 | 02-storage-v2.md | D1 schema v2 | pending |
| 03 | 03-api-v3.md | v3 surface | pending (v1 routes live; OpenAPI docs shipped) |
| 04 | 04-graphql-model.md | model-typed GraphQL | pending (flat schema live) |
| 05 | 05-json-schema.md | JSON Schema contract | pending |
| 06 | 06-index-contract-all-flavors.md | index rollout | **in progress** (machine index v2 live; dataset alias keys imported and bare-variant derivation made structural — relaton-api-js#87/#88, relaton#395; query side pending) |
| 07 | 07-npm-package.md | `@relaton/api` | **in progress** (library + CLI init/check/deploy/ingest done; npm publish + dogfood instance pending) |
| 08 | 08-repo-decomposition.md | three-repo split | **in progress** (repo renamed; relaton-api-ruby created 2026-10-28 with Lambda-era founding history + the v3-subset Rack implementation; deployment repo conversion pending) |
| 09 | 09-site-integration.md | relaton.org on v3 | pending (site now Astro) |
| 10 | 10-observability-ops.md | ops | pending |
| 11 | 11-ruby-gem.md | `relaton-api` gem | pending |
| 12 | 12-conformance-suite.md | shared contract tests | **in progress** (fixtures + node runner shipped 2026-10-29, relaton-api-js#90; daily production drift alarm; ruby CI replays the same set) |
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
