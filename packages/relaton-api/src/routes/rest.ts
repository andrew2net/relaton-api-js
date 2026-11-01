import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { normalizeCode } from "pubid-ts";
import { findDocument } from "../lib/lookup";
import { searchDocuments } from "../lib/search";
import { logEvent } from "../lib/obs";

const QuerySchema = z.object({
  code: z.string().min(1).openapi({ example: "ISO 19115-1" }),
  year: z.string().optional().openapi({ example: "2014" }),
  all_parts: z.enum(["true", "false"]).optional(),
  keep_year: z.enum(["true", "false"]).optional(),
});

const documentRoute = createRoute({
  method: "get",
  path: "/api/v1/document",
  request: { query: QuerySchema },
  responses: {
    200: {
      description: "Relaton XML bibliographic record (bibdata)",
      content: { "text/xml": { schema: z.string() } },
    },
    400: { description: "Missing or invalid code parameter", content: { "text/plain": { schema: z.string() } } },
    404: { description: "Document not found", content: { "text/plain": { schema: z.string() } } },
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/api/v1/search",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ example: "risk assessment" }),
      flavor: z.string().optional().openapi({ example: "iso" }),
      doctype: z.string().optional().openapi({ example: "standard" }),
      status: z.string().optional(),
      publisher: z.string().optional().openapi({ example: "ISO", description: "Pubid component of the primary docidentifier" }),
      number: z.string().optional().openapi({ example: "9001", description: "Pubid component of the primary docidentifier" }),
      part: z.string().optional().openapi({ example: "1", description: "Pubid component of the primary docidentifier" }),
      edition: z.string().optional().openapi({ example: "3", description: "Pubid component of the primary docidentifier" }),
      in_abstract: z.enum(["true", "false"]).optional().openapi({ description: "Also match titles/docids/abstracts (LIKE-based)" }),
      yearFrom: z.coerce.number().int().optional(),
      yearTo: z.coerce.number().int().optional(),
      sort: z.enum(["relevance", "year_desc", "year_asc", "docid"]).optional(),
      page: z.coerce.number().int().min(0).optional(),
      size: z.coerce.number().int().min(10).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Documents matching the query, with facet counts",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            page: z.number(),
            size: z.number(),
            items: z.array(z.object({
              docid: z.string().nullable(),
              flavor: z.string(),
              year: z.number().nullable(),
              doctype: z.string().nullable(),
              status: z.string().nullable(),
              title: z.string().nullable(),
              html: z.string(),
              api: z.string(),
            })),
            facets: z.record(z.string(), z.array(z.object({ value: z.string(), count: z.number() }))),
          }),
        },
      },
    },
  },
});

const versionRoute = createRoute({
  method: "get",
  path: "/api/v1/version",
  request: {
    query: z.object({ format: z.enum(["text", "xml", "json"]).optional() }),
  },
  responses: {
    200: {
      description: "API and data versions",
      content: {
        "text/plain": { schema: z.string() },
        "text/xml": { schema: z.string() },
        "application/json": { schema: z.object({ release: z.string(), relaton: z.string() }) },
      },
    },
  },
});

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const restRoutes = new OpenAPIHono<AppEnv>();

restRoutes.openapi(documentRoute, async (c) => {
  const { code, year } = c.req.valid("query");
  const allParts = c.req.valid("query").all_parts === "true";

  const normalized = normalizeCode(code);
  if (!normalized) {
    return c.text("Bad request. Parameter 'code' is required.", 400);
  }

  const row = await findDocument(c.env.DB, {
    code: normalized,
    year: year && /^\d{4}$/.test(year) ? Number(year) : null,
    allParts,
  });
  if (!row) return c.text("Document not found.", 404);

  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) {
    logEvent("r2_miss", { r2_key: row.r2_key, flavor: row.flavor, docid: row.docid });
    return c.text("Document not found.", 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
});

restRoutes.openapi(searchRoute, async (c) => {
  const q = c.req.valid("query");
  const result = await searchDocuments(c.env.DB, {
    q: q.q,
    flavor: q.flavor,
    doctype: q.doctype,
    status: q.status,
    publisher: q.publisher,
    number: q.number,
    part: q.part,
    edition: q.edition,
    inAbstract: q.in_abstract === "true",
    yearFrom: q.yearFrom ?? null,
    yearTo: q.yearTo ?? null,
    sort: q.sort,
    page: q.page ?? 0,
    size: q.size ?? 25,
  });
  return c.json({
    total: result.total,
    page: result.page,
    size: result.size,
    items: result.items.map((d) => {
      const key = d.r2_key.slice(d.flavor.length + 1);
      return {
        docid: d.docid,
        flavor: d.flavor,
        year: d.year,
        doctype: d.doctype,
        status: d.status,
        title: d.title_en,
        html: `/collections/${d.flavor}/entries/${encodeURIComponent(key)}`,
        api: `/api/v1/document?code=${encodeURIComponent(d.docid ?? key)}`,
      };
    }),
    facets: result.facets,
  });
});

restRoutes.openapi(versionRoute, async (c) => {
  const format = c.req.valid("query").format ?? "text";
  const release = c.env.API_VERSION ?? "dev";
  const relaton = (await c.env.DB.prepare(`SELECT value FROM meta WHERE key = 'relaton_version'`).first<{ value: string }>())?.value ?? "data-repos";

  switch (format) {
    case "xml":
      return c.text(`<version><release>${escapeXml(release)}</release><relaton>${escapeXml(relaton)}</relaton></version>`, 200, { "Content-Type": "text/xml" });
    case "json":
      return c.json({ release, relaton });
    default:
      return c.text(`Release: ${release}, Relaton version: ${relaton}`);
  }
});
