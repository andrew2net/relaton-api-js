# Contract fixtures (TODO.api/12)

One executable contract, dependency-free: `run.mjs` replays
`fixtures.json` against a base URL and exits non-zero on drift.

```sh
npm run test:contract                                    # against production
RELATON_API_BASE_URL=http://127.0.0.1:8787 npm run test:contract
node packages/relaton-api/contract/run.mjs "3GPP"        # one fixture by name substring
```

Assertions pin the stable contract surface only: status, content-type,
and pinned identifiers. Titles, dates and counts drift with the datasets
and must not be pinned here. `run.mjs` is plain node with no imports
beyond `node:`, so the Ruby gem's CI can execute the same file against
its own implementation.

`.github/workflows/contract.yml` runs the set daily against production
and is `workflow_call`-able, so the deployment repo's post-deploy smoke
can invoke it with its own `base_url`.

## Versioning and pinning

`fixtures.json` carries a `version` field, and the runner prints it — a
CI log names the exact contract a suite was held to. This repository
always runs the fixtures from its working tree; consumers consume
**released code**, never a moving checkout:

- The fixtures ship inside the published `@relaton/api` npm package
  (`contract/run.mjs` + `contract/fixtures.json`). A fixture change here
  is followed by an `@relaton/api` release (`release.yml`, npm trusted
  publishing) — raw commit URLs are never a distribution channel.
- **relaton-api-ruby's CI** extracts the contract from a released
  version (`npm pack @relaton/api@X.Y.Z`) and runs it against
  production; bumping that version is a deliberate PR there, driven by
  a release here.
- **The deployment smoke** (`contract.yml` `workflow_call`) runs from
  the caller's checkout, so it is pinned by whichever ref the caller
  checks out.

Protocol for a fixture change here: bump `version` (patch for additive
fixtures, minor for tightened assertions, major for a breaking change),
merge, release the package, then raise the version-bump PR in each
consumer repo.
