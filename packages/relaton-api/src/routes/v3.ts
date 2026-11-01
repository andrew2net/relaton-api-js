import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { dump as dumpYaml } from "js-yaml";
import type { AppEnv } from "../env";
import { getDocument, getDocumentByLookupKey, pageSummaries, searchDocumentPages } from "../lib/storage2";
// Deep path: self-contained and extension-free, loadable under plain node
// as well as the bundler (same import discipline produce.ts uses).
import { normKey } from "pubid-ts/src/keys.ts";

// API v3 (TODO.api/03): the modern surface over the storage v2 loader —
// content negotiation, RFC 9457 problem+json errors, strong ETags with
// immutable edge caching, cursor pagination with Link headers. The v1
// routes stay until the cutover.
//
// R2 blob convention: the same key the v1 ingest wrote —
// `<flavor>/<file without .yaml>` holding bibdata XML.

const JSON_TYPE = "application/json";
const XML_TYPE = "application/relaton+xml";
const YAML_TYPE = "application/yaml";

const IMMUTABLE = "public, max-age=31536000, immutable";

function problem(c: any, status: number, title: string, detail?: string) {
  return c.json({ type: "about:blank", title, status, ...(detail ? { detail } : {}) }, status as 400, {
    "content-type": "application/problem+json",
  });
}

function negotiate(accept: string | undefined, format: string | undefined): string {
  if (format === "xml" || format === "yaml" || format === "json") {
    return { xml: XML_TYPE, yaml: YAML_TYPE, json: JSON_TYPE }[format];
  }
  const offered = (accept ?? "").split(",").map((t) => t.split(";")[0]!.trim().toLowerCase());
  if (offered.includes(XML_TYPE)) return XML_TYPE;
  if (offered.includes(YAML_TYPE)) return YAML_TYPE;
  return JSON_TYPE;
}

function blobKeyOf(flavor: string, file: string): string {
  return `${flavor}/${file.replace(/\.ya?ml$/, "")}`;
}

async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  return (header ?? "").split(",").map((t) => t.trim()).includes(etag);
}

function yamlOf(data: Record<string, unknown>): string {
  return dumpYaml(data, { lineWidth: -1 });
}

const keyRoute = createRoute({
  method: "get",
  path: "/v3/documents/{key}",
  request: {
    params: z.object({ key: z.string().min(1) }),
    query: z.object({ format: z.enum(["json", "xml", "yaml"]).optional() }),
  },
  responses: {
    200: { description: "The document in the negotiated representation", content: { "*/*": { schema: z.any() } } },
    304: { description: "Not modified (ETag match)" },
    404: { description: "Unknown key", content: { "application/problem+json": { schema: z.any() } } },
    406: { description: "XML requested but no bibdata XML is stored", content: { "application/problem+json": { schema: z.any() } } },
  },
});

const collectionRoute = createRoute({
  method: "get",
  path: "/v3/documents",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      flavor: z.string().optional(),
      year: z.coerce.number().int().optional(),
      doctype: z.string().optional(),
      status: z.string().optional(),
      q: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of documents, key-ordered, with a Link header when more remain",
      content: { "application/json": { schema: z.any() } },
    },
  },
});

const flavorsRoute = createRoute({
  method: "get",
  path: "/v3/flavors",
  responses: {
    200: {
      description: "Per-flavor coverage",
      content: { "application/json": { schema: z.any() } },
    },
  },
});

const versionRoute = createRoute({
  method: "get",
  path: "/v3/version",
  responses: {
    200: { description: "Release and model versions", content: { "application/json": { schema: z.any() } } },
  },
});

export const v3Routes = new OpenAPIHono<AppEnv>();

function decodeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined as unknown as string;
  }
}

function encodeCursor(key: string): string {
  return btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

v3Routes.openapi(keyRoute, async (c) => {
  const { key } = c.req.valid("param");
  const { format } = c.req.valid("query");
  // Exact key first; then the normalized lookup token (doc_keys carries
  // the dataset's normKey forms), so "rfc 8446" and "RFC-8446" resolve
  // like "RFC 8446" does — the site issue #26 complaint, on the v3 surface.
  const keyText = decodeURIComponent(key);
  const doc = (await getDocument(c.env.DB, keyText))
    ?? (await getDocumentByLookupKey(c.env.DB, normKey(keyText)));
  if (!doc) return problem(c, 404, "Not Found", `unknown key ${keyText}`);

  const type = negotiate(c.req.header("Accept"), format);
  let body: string;
  if (type === XML_TYPE) {
    const obj = await c.env.BUCKET.get(blobKeyOf(doc.flavor, doc.file));
    if (!obj) {
      return problem(c, 406, "Not Acceptable", `no bibdata XML stored for ${doc.key}`);
    }
    body = await obj.text();
  } else if (type === YAML_TYPE) {
    body = yamlOf(doc.data);
  } else {
    body = JSON.stringify(doc.data);
  }

  const etag = await etagOf(body);
  const caching = { ETag: etag, "Cache-Control": IMMUTABLE };
  if (ifNoneMatchSatisfied(c.req.header("If-None-Match"), etag)) {
    return c.body(null, 304, caching);
  }
  if (c.req.method === "HEAD") return c.body(null, 200, caching);
  return c.body(body, 200, { "Content-Type": type, ...caching });
});

v3Routes.openapi(collectionRoute, async (c) => {
  const q = c.req.valid("query");
  const limit = q.limit ?? 25;
  const cursor = decodeCursor(q.cursor);
  if (cursor === (undefined as unknown as string)) {
    return problem(c, 422, "Unprocessable Content", "cursor is not a valid token");
  }

  const rows = await searchDocumentPages(c.env.DB, {
    cursor, limit,
    flavor: q.flavor, year: q.year ?? null, doctype: q.doctype,
    status: q.status, q: q.q,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const { titleOf, primaryOf } = await pageSummaries(c.env.DB, page.map((r) => r.key));

  const items = page.map((r) => ({
    key: r.key,
    flavor: r.flavor,
    docid: primaryOf.get(r.key) ?? null,
    title: titleOf.get(r.key) ?? null,
    api: `/v3/documents/${encodeURIComponent(r.key)}`,
  }));

  const headers: Record<string, string> = {};
  if (hasMore && page.length) {
    const next = new URL(c.req.url);
    next.searchParams.set("cursor", encodeCursor(page[page.length - 1]!.key));
    next.searchParams.set("limit", String(limit));
    headers.Link = `<${next.pathname}${next.search}>; rel="next"`;
  }
  return c.json({ items, next_cursor: hasMore ? encodeCursor(page[page.length - 1]!.key) : null }, 200, headers);
});

v3Routes.openapi(flavorsRoute, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT flavor, repo, last_modified, indexed_at, doc_count FROM flavors_v2 ORDER BY flavor",
  ).all();
  return c.json({ flavors: results ?? [] });
});

v3Routes.openapi(versionRoute, async (c) => {
  const release = c.env.API_VERSION ?? "dev";
  const relaton = (await c.env.DB.prepare(`SELECT value FROM meta WHERE key = 'relaton_version'`).first<{ value: string }>())?.value ?? "data-repos";
  return c.json({ release, relaton });
});
