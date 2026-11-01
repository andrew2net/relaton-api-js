# 04 — GraphQL mirroring the Relaton model

Status (2026-11-01): the model-faithful schema is live and REPLACED the
flat one. `src/routes/graphql.ts` mirrors the Relaton bibliographic
model — BibliographicItem with docids/titles (all languages)/dates/
contributors/relations/series/editions/languages/scripts/classifications/
status/doctype and the opt-in `xml` from the R2 blobs — reading the
lossless `data` JSON from storage v2. Filters (key/title/flavor/year/
doctype/status/contributor/relation{type,target}) hit the projection
tables through `searchDocumentPages`, the same SQL the v3 REST
collection uses; Relation.item traverses a relation target to its own
BibliographicItem. GraphiQL playground kept. Remaining: persisted
queries for relaton.org's explorer (P5).

Goal: the GraphQL schema mirrors relaton-models (the relaton-py
`BibliographicItem` shape used by bibxml.ietf.org is the reference), not a
flattened convenience schema.

## Schema core (model-faithful)

```graphql
type BibliographicItem {
  key: ID!
  flavor: String!
  docids: [DocID!]!
  titles: [LocalizedString!]!      # all languages/types
  dates: [BibliographicDate!]!
  contributors: [Contributor!]!    # org/person, roles, affiliations
  relations: [Relation!]!          # includes / partOf / updates ...
  series: [Series!]!
  editions: [String!]
  languages: [String!]! scripts: [String!]!
  classifications: [Classification!]!   # ICS etc.
  status: DocumentStatus doctype: String
  xml: String   # bibdata XML (R2) — opt-in field
}
type Query {
  document(key: ID!): BibliographicItem
  documents(key: String, title: String, flavor: String, year: Int,
            doctype: String, status: String, contributor: String,
            relation: RelationFilter, after: String, first: Int = 20):
            DocumentConnection!
  flavors: [Flavor!]!  version: Version!
}
```

## Tasks

- [x] Resolvers read `documents.data` (storage v2); filters hit projection
      tables via the same SQL the REST search uses.
- [x] Relation traversal (`relation: { type, target }`).
- [x] Replace current flat schema; keep GraphiQL playground.
- [ ] Persisted queries for relaton.org's explorer (later; P5).

## Acceptance

- Round-trip: any `data` JSON field reachable via GraphQL without loss.
- Cross-flavor queries (title search across all flavors) unchanged in power,
  richer in output.
