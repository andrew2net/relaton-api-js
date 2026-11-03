import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { renderCollections, renderEntry, wantsHtml, findEntryRow } from "./cloudstore_ui";
import { renderNotFound } from "./ui/chrome";
import { renderSearchPage } from "./search";
import * as v2 from "../lib/search2";

// The lutaml cloud store contract (spike distilled from this API and
// generalized; see TODO.relaton-cloud-store item 3):
//
//   GET /collections                          → { collections: [...] }
//   GET /collections/{c}/manifest             → Manifest JSON
//   GET /collections/{c}/entries/{key}        → record bytes (404 = definitive)
//
// A collection is one relaton flavor. Entry keys are the documents' primary
// docidentifiers, exactly as listed in the manifest — clients never guess a
// mapping between the listing and the fetch paths.

interface FlavorRow {
  flavor: string;
  doc_count: number;
  last_modified: string | null;
  ingested_at: string;
}

interface EntryRow {
  docid: string | null;
  r2_key: string;
}

const collectionsRoute = createRoute({
  method: "get",
  path: "/collections",
  responses: {
    200: {
      description: "Collections published by this store (HTML for browsers, JSON for clients)",
      content: {
        "application/json": {
          schema: z.object({
            collections: z.array(z.object({ name: z.string(), count: z.number() })),
          }),
        },
        "text/html": { schema: z.string() },
      },
    },
  },
});

const manifestRoute = createRoute({
  method: "get",
  path: "/collections/{collection}/manifest",
  request: {
    params: z.object({ collection: z.string().min(1) }),
  },
  responses: {
    200: { description: "The collection manifest", content: { "application/json": { schema: z.any() } } },
    404: { description: "Unknown collection", content: { "text/plain": { schema: z.string() } } },
  },
});

const entryRoute = createRoute({
  method: "get",
  path: "/collections/{collection}/entries/{key}",
  request: {
    params: z.object({ collection: z.string().min(1), key: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "The record bytes (raw for clients, framed page for browsers)",
      content: {
        "text/plain": { schema: z.string() },
        "text/html": { schema: z.string() },
      },
    },
    404: { description: "No such entry (definitive)", content: { "text/plain": { schema: z.string() } } },
  },
});

function contentTypeFor(key: string): string {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".xml")) return "text/xml";
  return "application/yaml";
}

export const cloudStoreRoutes = new OpenAPIHono<AppEnv>();

cloudStoreRoutes.openapi(collectionsRoute, async (c) => {
  // Browsers get the browsable index; API clients keep the JSON contract.
  if (wantsHtml(c.req.header("Accept"))) {
    return c.html(await renderCollections(c.env.DB), 200, {
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    });
  }

  const collections = (await v2.searchReady(c.env.DB))
    ? (await v2.listFlavors(c.env.DB)).map((f) => ({ name: f.flavor, count: f.doc_count }))
    : ((await c.env.DB.prepare("SELECT flavor, doc_count FROM flavors ORDER BY flavor")
      .all<FlavorRow>()).results ?? []).map((f) => ({ name: f.flavor, count: f.doc_count }));

  return c.json({ collections });
});

// Citation files: BibTeX, RIS, and CSL-JSON downloads for one record.
//
// One static route per format, not a dot-param (`export.:format`): hono's
// RegExpRouter drops a dot-param route from the merged GET regex once any
// other GET pattern is added, so a bare `app.get("/zzz/:x")` elsewhere in
// the app 404s every export. Static suffixes merge cleanly and keep the
// same URLs.
const EXPORT_FORMATS: Record<string, { ext: string; type: string }> = {
  bib: { ext: "bib", type: "application/x-bibtex" },
  ris: { ext: "ris", type: "application/x-research-info-systems" },
  "csl.json": { ext: "csl.json", type: "application/json" },
  jsonld: { ext: "jsonld", type: "application/ld+json" },
};

for (const exportFormat of Object.keys(EXPORT_FORMATS)) {
  cloudStoreRoutes.get(`/collections/:collection/entries/:key/export.${exportFormat}`, async (c) => {
    const collection = c.req.param("collection");
    const key = c.req.param("key");
    const format = exportFormat;
    const spec = EXPORT_FORMATS[format]!;

    const row = await findEntryRow(c.env.DB, collection, key);
    if (!row) return c.text(`no such entry: ${key}`, 404);
    const obj = await c.env.BUCKET.get(row.r2_key);
    if (!obj) return c.text(`no such entry: ${key}`, 404);
    const body = await obj.text();

    const { parse, fromXml, toBibtex, toRis, toCslJson, toJsonLd } = await import("relaton");
    // Collections store YAML (the data repos' format) or XML (bibxml builds):
    // XML goes through the loose DOM parser, everything else through the
    // sniffing validator, so exports work over either storage form.
    const parsed = body.trimStart().startsWith("<") ? fromXml(body) : parse(body);
    if (!parsed.ok) return c.text("record could not be parsed for export", 502);
    const slug = row.docid?.replace(/[^A-Za-z0-9]+/g, "") || "relaton";

    const content = format === "bib" ? toBibtex(parsed.item)
      : format === "ris" ? toRis(parsed.item)
      : format === "jsonld" ? toJsonLd(parsed.item)
      : toCslJson(parsed.item);
    return c.text(content, 200, {
      "content-type": spec.type + "; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}.${spec.ext}"`,
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    });
  });
}

// Browsable collection page: the shared search engine scoped to one flavor.
cloudStoreRoutes.get("/collections/:collection", async (c) => {
  const collection = c.req.param("collection");
  const onV2 = await v2.searchReady(c.env.DB);
  const flavor = onV2
    ? (await v2.listFlavors(c.env.DB)).some((f) => f.flavor === collection)
    : Boolean(await c.env.DB.prepare("SELECT flavor FROM flavors WHERE flavor = ?").bind(collection).first());
  if (!flavor) {
    if (wantsHtml(c.req.header("Accept"))) {
      return c.html(renderNotFound({
        heading: "No such collection",
        detail: `${collection} is not one of the indexed collections.`,
        actions: [
          { label: "Browse the collections", href: "/collections" },
          { label: "Search everything", href: "/search" },
        ],
      }), 404, { "cache-control": "no-store" });
    }
    return c.text(`unknown collection: ${collection}`, 404);
  }
  const html = await renderSearchPage(c.env, c.env.DB, new URL(c.req.url), {
    scopeFlavor: collection,
    title: collection,
    activeNav: "collections",
  });
  return c.html(html, 200, {
    "cache-control": "public, max-age=60, stale-while-revalidate=3600",
  });
});

cloudStoreRoutes.openapi(manifestRoute, async (c) => {
  const collection = c.req.param("collection");
  const onV2 = await v2.searchReady(c.env.DB);

  interface FlavorMeta { doc_count: number; last_modified: string | null; stamp: string }
  let meta: FlavorMeta;
  let entries: { key: string; docid: string | null }[];
  if (onV2) {
    const flavor = (await v2.listFlavors(c.env.DB)).find((f) => f.flavor === collection);
    if (!flavor) return c.text(`unknown collection: ${collection}`, 404);
    meta = { doc_count: flavor.doc_count, last_modified: flavor.last_modified, stamp: flavor.indexed_at };
    const { results } = await c.env.DB.prepare(
      "SELECT file, docid FROM documents_search WHERE flavor = ? ORDER BY file",
    ).bind(collection).all<{ file: string; docid: string | null }>();
    entries = (results ?? []).map((d) => ({ key: v2.entryKeyOf(d.file), docid: d.docid }));
  } else {
    const flavor = await c.env.DB.prepare(
      "SELECT flavor, doc_count, last_modified, ingested_at FROM flavors WHERE flavor = ?",
    ).bind(collection).first<FlavorRow>();
    if (!flavor) {
      return c.text(`unknown collection: ${collection}`, 404);
    }
    meta = { doc_count: flavor.doc_count, last_modified: flavor.last_modified, stamp: flavor.ingested_at };
    const { results } = await c.env.DB.prepare(
      "SELECT r2_key, docid FROM documents WHERE flavor = ? ORDER BY r2_key",
    ).bind(collection).all<EntryRow>();
    entries = (results ?? []).map((d) => ({
      key: d.r2_key.slice(collection.length + 1).replace(/^data\//, ""),
      docid: d.docid,
    }));
  }

  const generated = meta.last_modified ?? meta.stamp;
  const manifest = {
    version: 1,
    generated,
    count: entries.length,
    shards: 0,
    entries: entries.map((d) => ({
      key: d.key,
      metadata: d.docid ? { docid: d.docid } : {},
    })),
  };
  const etag = `"${collection}-v1-${generated}-${manifest.count}"`;

  return c.json(manifest, 200, { etag, "cache-control": "public, max-age=3600" });
});

cloudStoreRoutes.openapi(entryRoute, async (c) => {
  const collection = c.req.param("collection");
  const key = c.req.param("key");

  // Browsers get a framed record page (?raw=1 links the bytes); API
  // clients keep the raw response.
  if (wantsHtml(c.req.header("Accept")) && !c.req.query("raw")) {
    // Record pages are the heaviest HTML on the site (R2 fetch + parse +
    // full render), so the edge caches them for the freshness window.
    // The variant marker keeps the cache key distinct from the raw bytes.
    const variantUrl = new URL(c.req.url);
    variantUrl.searchParams.set("v", "html");
    // caches.default is a Cloudflare extension absent from the DOM lib types.
    const edge = (caches as unknown as { default: Cache }).default;
    try {
      const hit = await edge.match(new Request(variantUrl, { method: "GET" }));
      if (hit) return hit;
    } catch { /* cache unavailable in this runtime — render normally */ }

    const page = await renderEntry(
      c.env.DB, collection, key, false,
      (r2Key) => c.env.BUCKET.get(r2Key),
    );
    if (!page) {
      const bare = key.replace(/^data\//, "");
      return c.html(renderNotFound({
        heading: "No such record",
        detail: `${collection} has no entry ${bare}. Records appear here when the dataset is ingested.`,
        actions: [
          { label: `Search for ${bare}`, href: `/search?q=${encodeURIComponent(bare)}` },
          { label: `Browse ${collection}`, href: `/collections/${encodeURIComponent(collection)}` },
          { label: "All collections", href: "/collections" },
        ],
      }), 404, { "cache-control": "no-store" });
    }
    if ("html" in page) {
      // Record pages change only on ingest; a five-minute freshness window
      // with background revalidation keeps repeat visits instant.
      const res = c.html(page.html, 200, {
        "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      });
      try {
        c.executionCtx.waitUntil(edge.put(new Request(variantUrl, { method: "GET" }), res.clone()));
      } catch { /* same as above */ }
      return res;
    }
    return c.text(page.body, 200, {
      "content-type": page.contentType,
      etag: `"${collection}/${key}"`,
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    });
  }

  const row = await findEntryRow(c.env.DB, collection, key);
  if (!row) {
    return c.text(`no such entry: ${key}`, 404);
  }

  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) {
    console.error(`cloud store: R2 miss for ${row.r2_key} (collection=${collection}, key=${key})`);
    return c.text(`no such entry: ${key}`, 404);
  }

  const body = await obj.text();
  return c.text(body, 200, {
    "content-type": contentTypeFor(row.r2_key),
    etag: `"${collection}/${key}"`,
    "cache-control": "public, max-age=300, stale-while-revalidate=86400",
  });
});
