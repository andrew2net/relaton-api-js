import { createSchema, createYoga } from "graphql-yoga";
import type { Context, Handler } from "hono";
import type { AppEnv, Env } from "../env";
import {
  getDocument,
  getDocumentByLookupKey,
  pageSummaries,
  scalarText,
  searchDocumentPages,
  type StorageV2Doc,
} from "../lib/storage2";
import { normKey } from "pubid-ts/src/keys.ts";

// The model-faithful GraphQL schema (TODO.api/04): it mirrors the Relaton
// bibliographic model, reading the lossless `data` JSON from storage v2 —
// all titles/languages, dates, contributors, relations, classifications —
// not a flattened convenience shape. Filters hit the projection tables
// through the same SQL the v3 REST collection uses.
const typeDefs = /* GraphQL */ `
  type Query {
    document(key: ID!): BibliographicItem
    documents(
      key: String
      title: String
      flavor: String
      year: Int
      doctype: String
      status: String
      contributor: String
      relation: RelationFilter
      after: String
      first: Int = 20
    ): DocumentConnection!
    flavors: [Flavor!]!
    version: Version!
  }

  type BibliographicItem {
    key: ID!
    flavor: String!
    docids: [DocID!]!
    titles: [LocalizedString!]!
    dates: [BibliographicDate!]!
    contributors: [Contributor!]!
    relations: [Relation!]!
    series: [Series!]!
    editions: [String!]
    languages: [String!]!
    scripts: [String!]!
    classifications: [Classification!]!
    status: DocumentStatus
    doctype: String
    xml: String
  }

  type DocID {
    content: String
    type: String
    primary: Boolean
  }

  type LocalizedString {
    content: String
    language: String
    script: String
    type: String
  }

  type BibliographicDate {
    type: String
    on: String
    from: String
    to: String
  }

  type Contributor {
    role: String
    organization: Organization
    person: Person
  }

  type Organization {
    name: String
    abbreviation: String
    url: String
  }

  type Person {
    name: String
    affiliation: [String!]!
  }

  type Relation {
    type: String
    target: String
    item: BibliographicItem
  }

  type Series {
    title: String
    abbreviation: String
  }

  type Classification {
    type: String
    value: String
  }

  type DocumentStatus {
    stage: String
    substage: String
  }

  input RelationFilter {
    type: String
    target: String
  }

  type Flavor {
    flavor: String!
    repo: String!
    docCount: Int!
    lastModified: String
    indexedAt: String!
  }

  type Version {
    release: String!
    relaton: String!
  }

  type DocumentConnection {
    edges: [DocumentEdge!]!
    pageInfo: PageInfo!
  }

  type DocumentEdge {
    node: BibliographicItem!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }
`;

interface ModelListField {
  content?: unknown;
  type?: string;
  language?: string[] | string;
  script?: string[] | string;
  primary?: boolean;
}

const asArray = <T>(value: T | T[] | undefined | null): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const asStringArray = (value: unknown): string[] =>
  asArray(value as string | string[]).map(String);

function listEntries(raw: unknown): ModelListField[] {
  if (typeof raw === "string") return [{ content: raw }];
  return asArray(raw as ModelListField | ModelListField[]);
}

function listField(data: Record<string, unknown>, name: string): ModelListField[] {
  return listEntries(data[name]);
}

function scalarContent(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const content = (entry as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (content && typeof content === "object" && typeof (content as { content?: unknown }).content === "string") {
      return (content as { content: string }).content;
    }
  }
  return null;
}

function blobKeyOf(flavor: string, file: string): string {
  return `${flavor}/${file.replace(/\.ya?ml$/, "")}`;
}

function encodeCursor(key: string): string {
  return btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): string | null {
  try {
    return atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

// The model projection of one stored document: every GraphQL field reads
// `data` (or the projections via SQL), never a flattened column.
const bibliographicItemFields = {
  key: (doc: StorageV2Doc) => doc.key,
  flavor: (doc: StorageV2Doc) => doc.flavor,
  docids: (doc: StorageV2Doc) => {
    // v1.5 names the field `docidentifier` with `content`; v1.2-era
    // datasets name it `docid` with `id`.
    const raw = (doc.data.docidentifier ?? doc.data.docid) as unknown;
    return listEntries(raw).map((d) => ({
      content: scalarContent((d as { content?: unknown }).content ?? (d as { id?: unknown }).id),
      type: d.type ?? null,
      primary: d.primary === true,
    }));
  },
  titles: (doc: StorageV2Doc) =>
    listField(doc.data, "title").map((t) => ({
      content: scalarContent(t),
      language: asStringArray(t.language)[0] ?? null,
      script: asStringArray(t.script)[0] ?? null,
      type: t.type ?? "main",
    })),
  dates: (doc: StorageV2Doc) => asArray(doc.data.date),
  contributors: (doc: StorageV2Doc) =>
    asArray(doc.data.contributor).map((c) => ({
      role: asArray((c as { role?: unknown }).role as never[])[0] ?? null,
      organization: (c as { organization?: unknown }).organization ?? null,
      person: (c as { person?: unknown }).person ?? null,
    })),
  relations: (doc: StorageV2Doc) => asArray(doc.data.relation),
  series: (doc: StorageV2Doc) =>
    asArray(doc.data.series).map((s) => ({
      title: scalarContent((s as { title?: unknown }).title) ?? null,
      abbreviation: (s as { abbreviation?: unknown }).abbreviation ?? null,
    })),
  editions: (doc: StorageV2Doc) => asStringArray(doc.data.edition),
  languages: (doc: StorageV2Doc) => asStringArray(doc.data.language),
  scripts: (doc: StorageV2Doc) => asStringArray(doc.data.script),
  classifications: (doc: StorageV2Doc) => asArray(doc.data.classification),
  status: (doc: StorageV2Doc) => {
    const status = doc.data.status;
    if (!status || typeof status !== "object") return null;
    const stage = (status as { stage?: unknown }).stage;
    const substage = (status as { substage?: unknown }).substage;
    const scalar = (v: unknown): string | null => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const s = v as { value?: unknown; content?: unknown };
        return typeof s.value === "string" ? s.value : typeof s.content === "string" ? s.content : null;
      }
      return null;
    };
    return { stage: scalar(stage), substage: scalar(substage) };
  },
  doctype: (doc: StorageV2Doc) => (typeof doc.data.doctype === "string" ? doc.data.doctype : null),
  xml: async (doc: StorageV2Doc, _a: unknown, ctx: GqlContext) => {
    const obj = await ctx.env.BUCKET.get(blobKeyOf(doc.flavor, doc.file));
    return obj ? await obj.text() : null;
  },
};

interface GqlContext {
  env: Env;
}

interface RelationFilterInput {
  type?: string | null;
  target?: string | null;
}

interface DocumentsArgs {
  key?: string | null;
  title?: string | null;
  flavor?: string | null;
  year?: number | null;
  doctype?: string | null;
  status?: string | null;
  contributor?: string | null;
  relation?: RelationFilterInput | null;
  after?: string | null;
  first?: number | null;
}

const resolvers = {
  Query: {
    document: async (_p: unknown, args: { key: string }, ctx: GqlContext) =>
      (await getDocument(ctx.env.DB, args.key))
      ?? (await getDocumentByLookupKey(ctx.env.DB, normKey(args.key))),

    documents: async (_p: unknown, args: DocumentsArgs, ctx: GqlContext) => {
      const first = Math.min(Math.max(args.first ?? 20, 1), 100);
      const after = args.after ? decodeCursor(args.after) : null;
      const rows = await searchDocumentPages(ctx.env.DB, {
        cursor: after,
        limit: first,
        flavor: args.flavor,
        year: args.year,
        doctype: args.doctype,
        status: args.status,
        title: args.title ?? args.key,
        contributor: args.contributor,
        relationType: args.relation?.type ?? null,
        relationTarget: args.relation?.target ?? null,
      });
      const hasNextPage = rows.length > first;
      const page = rows.slice(0, first);
      const { titleOf, primaryOf } = await pageSummaries(ctx.env.DB, page.map((r) => r.key));
      const docs = await Promise.all(page.map((r) => getDocument(ctx.env.DB, r.key)));
      const edges = docs
        .filter((d): d is StorageV2Doc => d !== null)
        .map((doc) => ({
          node: { ...doc, _title: titleOf.get(doc.key), _primary: primaryOf.get(doc.key) },
          cursor: encodeCursor(doc.key),
        }));
      return {
        edges,
        pageInfo: {
          hasNextPage,
          endCursor: edges.length ? edges[edges.length - 1]?.cursor : null,
        },
      };
    },

    flavors: async (_p: unknown, _a: unknown, ctx: GqlContext) => {
      const { results } = await ctx.env.DB.prepare(
        "SELECT flavor, repo, last_modified, indexed_at, doc_count FROM flavors_v2 ORDER BY flavor",
      ).all<{ flavor: string; repo: string; last_modified: string | null; indexed_at: string; doc_count: number }>();
      return (results ?? []).map((f) => ({
        flavor: f.flavor,
        repo: f.repo,
        docCount: f.doc_count,
        lastModified: f.last_modified,
        indexedAt: f.indexed_at,
      }));
    },

    version: async (_p: unknown, _a: unknown, ctx: GqlContext) => {
      const row = await ctx.env.DB.prepare(
        "SELECT value FROM meta WHERE key = 'relaton_version'",
      ).first<{ value: string }>();
      return { release: ctx.env.API_VERSION ?? "dev", relaton: row?.value ?? "data-repos" };
    },
  },

  BibliographicItem: bibliographicItemFields,

  Relation: {
    target: (relation: { bibitem?: { docidentifier?: { content?: string }[] }; target?: string }) =>
      relation.bibitem?.docidentifier?.[0]?.content ?? relation.target ?? null,
    item: async (relation: { bibitem?: { docidentifier?: { content?: string }[] }; target?: string }, _a: unknown, ctx: GqlContext) => {
      const target = relation.bibitem?.docidentifier?.[0]?.content ?? relation.target;
      return target ? getDocument(ctx.env.DB, target) : null;
    },
  },

  Organization: {
    name: (org: { name?: unknown }) => scalarText(org.name),
    abbreviation: (org: { abbreviation?: unknown }) => scalarText(org.abbreviation),
    url: (org: { url?: unknown }) => scalarText(org.url),
  },

  Contributor: {
    role: (contributor: { role: unknown }) =>
      scalarText(asArray(contributor.role as never[])[0]),
    person: (contributor: { person?: { name?: { completename?: unknown } } }) => {
      const person = contributor.person;
      if (!person) return null;
      return {
        name: scalarContent(person.name?.completename),
        affiliation: asArray(person.name && (person.name as { affiliation?: unknown }).affiliation).map(String),
      };
    },
  },
};

export function graphqlRoute(): Handler<AppEnv> {
  const yoga = createYoga<{ env: Env }>({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
  });
  return (c: Context<AppEnv>) => yoga(c.req.raw, { env: c.env });
}
