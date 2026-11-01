# api.relaton.org (Cloudflare Workers)

TypeScript rewrite of the Relaton public API, served entirely from Cloudflare
(Workers + D1 + R2). Replaces the Ruby/AWS Lambda deployment. Any organization
can deploy its own instance of this API — see [Deploying your own](#deploying-your-own).

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Landing page with live coverage stats and a search demo |
| `GET /api/v1/document?code=&year=&all_parts=&keep_year=` | Relaton XML bibdata — same contract as the Ruby API (relaton gem `use_api` clients and the relaton.org `<ApiDemo />` both call this) |
| `GET /api/v1/version?format=text\|xml\|json` | API + data versions |
| `GET /openapi.json`, `GET /docs` | OpenAPI 3.1 spec + Scalar UI |
| `POST /graphql` | GraphQL across all flavors (`document`, `documents(code/flavor/title/year/doctype, first/after)`, `flavors`, `version`); GraphiQL playground at GET `/graphql` |
| `GET /{flavor}/index/manifest.json`, `GET /{flavor}/index/shard-NNNNN.json` | The machine-index contract — the same bytes the relaton-data-* Pages sites publish, mirrored into R2 at ingest (`tools/sync_machine_index.sh`). A relaton `ShardSource` treats this host as just another index host: base-URL swap, ETag/`If-None-Match` revalidation, a missing shard is a definitive not-found (api-js#14) |
| `POST /admin/ingest/:flavor` | Chunked ingestion (Bearer `ADMIN_TOKEN`) |

The public API is read-only and requires no authentication.

## Architecture

- **Worker** (`src/`): Hono + `@hono/zod-openapi` (REST/OpenAPI), `graphql-yoga`
  (GraphQL). Pure lookup layer — no document conversion at request time.
- **D1**: the cross-flavor index. `documents` rows carry normalized lookup
  keys (`norm`, `undated_norm`, `allparts_norm`); `docids` holds every
  identifier variant including pubid-canonical ones.
- **R2**: full bibdata XML per document at `<flavor>/<path>`, produced by the
  Ruby relaton gem at ingestion time so responses are byte-compatible with
  the old API.
- **`packages/pubid-ts`**: TypeScript port of the pubid identifier parser.
  Query codes are canonicalized with it (update_codes rules + grammar +
  canonical render). Validated against a golden corpus generated from Ruby
  pubid over real docids — 100% canonical/year parity
  (`packages/pubid-ts/test/corpus.json`, regenerate with `tools/gen_corpus.rb`).
- **Ingestion** (`tools/`): Ruby (relaton + pubid gems) walks a
  `relaton-data-*` checkout, converts YAML or IETF bibxml into bibdata XML,
  extracts lookup keys and pubid-canonical variants, emits JSON chunks;
  `post_chunks.sh` uploads them through the admin endpoint (idempotent
  upserts, resumable via `.posted-*` markers). `tools/backfill.sh` runs all
  local clones; `.github/workflows/ingest.yml` keeps data fresh on a schedule.

## Development

```sh
npm install
npm run dev              # wrangler dev on :8787 (local D1/R2 state)
npm test                 # vitest (workers pool) + pubid-ts corpus parity
npm run typecheck
npm run db:migrate:local # apply migrations/ to local D1
```

Local secrets go in `.dev.vars` (gitignored):

```
ADMIN_TOKEN=<random string, e.g. openssl rand -hex 32>
```

## Deploying your own

Everything runs on Cloudflare's free-tier-eligible stack. You need: a
Cloudflare account, the wrangler CLI (`npm i -g wrangler`), and this repo.

### 1. Cloudflare API token

Create a custom token at dash.cloudflare.com → My Profile → **API Tokens →
Create Token → Custom Token**, then export it:

```sh
export CLOUDFLARE_API_TOKEN=<token>   # keep out of shells/logs where possible
export CLOUDFLARE_ACCOUNT_ID=<account id>
```

Required permissions:

| Scope | Permission | Why |
|---|---|---|
| Account → Workers Scripts | Edit | Deploy the Worker |
| Account → D1 | Edit | Create/migrate the index database |
| Account → Workers R2 Storage | Edit | Bibdata blob bucket (activate R2 once in the dashboard) |
| Account → Workers KV Storage | Edit | Optional |
| Account → Workers Tail | Read | `wrangler tail` debugging |
| Account → Account Settings | Read | Wrangler account resolution |
| Zone (your domain) → Workers Routes | Edit | Attach a custom domain |
| Zone (your domain) → DNS | Edit | DNS record for the custom domain |

No Cloudflare token is needed for the public API itself — only for deploys,
ingestion, and DNS. The ingest endpoint authenticates with `ADMIN_TOKEN`,
which is just a random string you generate yourself (`openssl rand -hex 32`).

### 2. Create resources and deploy

```sh
npx wrangler d1 create <name>          # put the printed database_id in wrangler.jsonc
npx wrangler r2 bucket create <bucket> # bucket name goes in wrangler.jsonc
npx wrangler d1 migrations apply <name> --remote
echo "<your admin token>" | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy                    # live at https://<worker>.<subdomain>.workers.dev
```

`API_VERSION` in `wrangler.jsonc` `vars` controls what `/api/v1/version` reports.

### 3. Custom domain

With the zone on the same Cloudflare account, a Workers route takes
precedence over existing origin DNS, so no records need to change:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone_id>/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"pattern": "api.example.org/*", "script": "<worker-name>"}'
```

(If the hostname has no DNS record yet, add any proxied record — e.g.
`A 192.0.2.1` proxied — and attach the route as above.) Rollback is deleting
the route.

### 4. Load data

```sh
cd tools
bundle install   # see RELATON_GEM/PUBID_GEM below
bundle exec ruby build_ingest.rb -r /path/to/relaton-data-iso -f iso -o out/iso
./post_chunks.sh out/iso https://<your-host> <ADMIN_TOKEN>
```

Ingest supports three source shapes: relaton YAML v1.5 (`docidentifier`),
legacy v1.2 (`docid`/`id`, via the gem's HashParserV1), and IETF bibxml
(`<reference>`). Re-posting is idempotent. The Ruby side needs the relaton v3
APIs and the pubid monorepo; if the released gems are too old, point the
Gemfile at git sources:

```sh
export RELATON_GEM=git:https://github.com/relaton/relaton#main
export PUBID_GEM=git:https://github.com/pubid/pubid#main
```

### 5. CI (GitHub Actions)

| Setting | Kind | Used by |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | `deploy` — typecheck, tests, D1 migrations, `wrangler deploy` on push to main |
| `CLOUDFLARE_ACCOUNT_ID` | secret | `deploy` |
| `CLOUDFLARE_ADMIN_TOKEN` | secret | `ingest` — weekly rebuild+post of every `relaton-data-*` flavor |
| `RELATON_GEM` | variable | `ingest` — gem source (git URL or released version constraint) |
| `PUBID_GEM` | variable | `ingest` |

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo <org>/<repo> --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ADMIN_TOKEN --repo <org>/<repo> --body "$ADMIN_TOKEN"
gh variable set RELATON_GEM --repo <org>/<repo> --body "git:https://github.com/relaton/relaton#main"
```

## Compatibility notes

- Error semantics match the Ruby API: 400 missing `code`, 404 not found;
  any non-200 is a miss for gem clients.
- Identifier matching follows pubid semantics: query codes are
  canonicalized (update_codes rewrites, stages/supplements/directives
  grammar) before lookup, with copublisher and scope-wrapper fallbacks.
- `all_parts` returns the latest member of the family rather than a
  synthesized "(all parts)" record (known deviation, can be generated at
  ingest later).
- Undated queries return the latest edition's stored XML (the gem also
  stripped the year from the returned document; we serve it as stored).

## Observability

Every served response writes one Analytics Engine datapoint (dataset
`relaton_api_requests`): index = collapsed route label, blobs = method /
key / flavor, doubles = status and duration in ms. Query it with
[Workers Analytics SQL](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/)
— p50/p95 latency per route:

```sql
SELECT index, percentile(double_2, 50), percentile(double_2, 95), count(*)
FROM relaton_api_requests
WHERE _timestamp > NOW() - INTERVAL '1' DAY
GROUP BY index ORDER BY count(*) DESC;
```

Structured logs are single-line JSON (`{"event": ...}`) readable in
`wrangler tail --format json` and Workers Logs. `r2_miss` is the
alert-worthy event — after a flavor's ingest it should sit at ~0; a
sustained nonzero rate means the D1 rows and the R2 blobs have diverged
(re-run the flavor's ingest). `route_unmatched` logs every 404 so gaps
in the surface surface in the logs.

Rate limiting: the worker reads an optional `RATE_LIMITER` rate-limit
binding and applies it to the public write endpoints (`/mcp`,
`/create/preview`); reads stay unlimited (they are pure GETs over
D1/R2). To enable, add the binding in `wrangler.jsonc`:

```jsonc
"unsafe": { "bindings": [{
  "name": "RATE_LIMITER", "type": "ratelimit",
  "namespace_id": "1001",
  "simple": { "limit": 100, "period": 10 }
}] }
```

## Status

`GET /v3/flavors` is the public health signal: per-flavor coverage (repo,
index timestamp, doc count). A flavor row with a stale `indexed_at` or a
dropped count means its ingest wave did not finish — re-run
`relaton-api ingest <flavor> --v2`.

## Runbook

- **Rollback** — `npx wrangler rollback list` / `npx wrangler rollback <version>`; a bad deploy is reverted without touching D1/R2.
- **Re-ingest a flavor** — `relaton-api ingest <flavor> --v2` (live producer; resumable with `--from-chunk N`, probeable with `--limit`). The wave's reconcile deletes rows it never re-stamped, so a partial run is safe; only a *completed* wave stamps `final`.
- **Rotate ADMIN_TOKEN** — `npx wrangler secret put ADMIN_TOKEN`, then mirror it in the consuming deployment's secret store (`gh secret set` there). The admin routes reject on mismatch; reads are unaffected.
- **D1 backup/export** — `npx wrangler d1 export api-relaton-org --remote --output dump.sql` (schedule with a cron workflow; Time Travel covers the last 30 days for point-in-time restores).
