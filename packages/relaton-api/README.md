# @relaton/api

The Relaton bibliographic API: a deployable Cloudflare Worker application and a
Node CLI serving every [`relaton-data-*`](https://github.com/relaton) collection —
300,000+ bibliographic records for standards (ISO, IEC, IETF, ITU, NIST, IEEE,
W3C, 3GPP, …).

`api.relaton.org` itself runs this package.

## Surfaces

- **REST v3** — `/v3/documents/{key}` (content negotiation: JSON, Relaton XML,
  YAML; strong ETags, version-stamped edge caching), `/v3/documents`
  (key-ordered cursor paging with filters), `/v3/flavors`, `/v3/version`,
  RFC 9457 problem+json errors, OpenAPI 3.1 at `/openapi.json`.
- **GraphQL** — model-faithful `BibliographicItem` schema at `/graphql`.
- **MCP** — read-only server at `/mcp` (relaton_search / relaton_fetch /
  relaton_cite / relaton_create_record / relaton_verify).
- **lutaml cloud store** — `/collections`, `/collections/{c}/manifest`,
  `/collections/{c}/entries/{key}` (+ BibTeX / RIS / CSL-JSON / JSON-LD exports).
- **Search UI** — `/search` with facets, pubid component filters, FTS and
  optional semantic search.

## Library

```ts
import { createRelatonApi } from "@relaton/api";

const { app } = createRelatonApi({ name: "my-sdo-api" /*, ... */ });
```

The pubid key derivation ships with the package and is corpus-pinned against
the pubid ruby gem:

```ts
import { normKey, undatedKey, allPartsKey, deriveKeys, canonicalize } from "@relaton/api";
```

Identifier grammar extensions come from [`@pubid/pubid`](https://www.npmjs.com/package/@pubid/pubid).

## CLI

```sh
npx relaton-api init     # scaffold relaton-api.yaml + worker entry + migrations
npx relaton-api check    # validate config and index URLs
npx relaton-api deploy   # generate wrangler.jsonc, apply D1 migrations, deploy
npx relaton-api ingest <flavor>   # mirror a flavor's machine index into the API
```

## Contract fixtures

The executable API contract (`contract/run.mjs` + `contract/fixtures.json`)
ships in the package. Consumers replay a released version against a base URL:

```sh
npm pack @relaton/api@<version>
tar -xzf relaton-api-<version>.tgz package/contract
RELATON_API_BASE_URL=https://api.relaton.org node package/contract/run.mjs
```

`contract/README.md` records the versioning protocol.

## License

BSD-2-Clause. Part of the Relaton ecosystem (relaton.org).
