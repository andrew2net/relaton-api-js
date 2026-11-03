# 07 — npm package `@relaton/api` (library + CLI)

Goal: third-party SDOs deploy by configuration only. The TS API is a
library; deployments are 3-line entries plus `relaton-api.yaml`.

## Done (rev 3)

- [x] `packages/relaton-api`: `createRelatonApi(config)` factory — the Hono
      app (REST + GraphQL + admin + landing) as a pure function of config.
- [x] Worker entry reduced to config + factory call; config sourced from
      the `API_CONFIG` var (JSON), validated with zod.
- [x] CLI skeleton: `relaton-api init` (scaffolds relaton-api.yaml, worker
      entry, D1 migrations), `relaton-api check` (validates config and
      index URLs).
- [x] `relaton-api deploy`: generates `worker/wrangler.jsonc` from the
      config (bindings, vars, custom-domain route, env:-resolved
      account id; `--dry-run` previews), applies the D1 migrations, and
      runs `wrangler deploy`.
- [x] `relaton-api ingest <flavor>`: mirrors the flavor's Pages machine
      index (manifest + shards, byte-for-byte, 64 files per request)
      into the API — pure TS; `--chunks DIR` posts the prebuilt ingest
      chunks the generated Ruby workflow produces and reconciles ghost
      rows afterwards.

## Remaining

- [x] Publish: `@relaton/api` ships the library + CLI + contract fixtures
      + migrations; `release.yml` publishes via npm trusted publishing
      (OIDC — the operator dispatches with the exact version; the
      Trusted Publisher registration on npmjs.com names this workflow).
      Consumers pin released versions (`npm pack @relaton/api@X.Y.Z`),
      never raw commits. The pubid grammar engine is consumed from the
      released `@pubid/pubid` (node-side harness cross-check; its
      parsanol runtime needs a real filesystem, so the worker keeps the
      corpus-pinned local key derivation).
- [ ] Owner: register the npm Trusted Publisher for `@relaton/api`
      (npmjs.com → org relaton → the package name → repository
      relaton/relaton-api-js, workflow `release.yml`), then dispatch the
      first release.
- [ ] Dogfood: second instance from pure config on workers.dev, zero code
      edits.

## Config schema (relaton-api.yaml)

```yaml
name: my-sdo-api
cloudflare: { account_id: env:CF_ACCOUNT_ID, zone: example-sdo.org,
              domain: api.example-sdo.org }
cache: { edge: true }
flavors:
  - id: mine
    index: https://github.com/my-sdo/relaton-data-mine/raw/main/index.zip
admin: { token_env: RELATON_API_ADMIN_TOKEN }
```

## Acceptance

SDO reaches a live API in ≤ 4 commands, zero code changes; api.relaton.org
itself deploys via the same package.
