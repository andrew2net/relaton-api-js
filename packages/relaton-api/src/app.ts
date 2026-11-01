import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { parseConfig, type RelatonApiConfig } from "./config";
import type { AppEnv } from "./env";
import { adminRoutes } from "./routes/admin";
import { restRoutes } from "./routes/rest";
import { v3Routes } from "./routes/v3";
import { cloudStoreRoutes } from "./routes/cloudstore";
import { machineIndexRoutes } from "./routes/machine_index";
import { graphqlRoute } from "./routes/graphql";
import { renderHome } from "./routes/home";
import { renderCreatePage, renderCreatePreview, type CreatePayload } from "./routes/create";
import { METANORMA_ICON_DARK_BG, METANORMA_ICON_LIGHT_BG } from "./assets/metanorma";
import { renderSearchPage } from "./routes/search";
import { renderVerifyPage } from "./routes/verify";
import { renderAiPage } from "./routes/ai";
import { handleMcp } from "./routes/mcp";

const LLMS_TXT = `# Relaton API — bibliographic data for standards documents

Relaton aggregates the relaton-data-* repositories: 300,000+ bibliographic
records for standards (ISO, IEC, IETF/BCP/RFC, ITU, NIST, IEEE, W3C, 3GPP,
IHO, OGC, …) with identifier parsing that matches the pubid gem.

## HTTP API (read-only, no auth)
- GET /api/v1/document?code=RFC+8446 — one record as Relaton XML (params: code, year, all_parts, keep_year)
- GET /api/v1/search?q=…&flavor=…&doctype=…&status=…&yearFrom=…&yearTo=…&sort=relevance|year_desc|year_asc|docid&page=0&size=25 — search with facet counts
- GET /api/v1/verify?code=10.17487/RFC8446 — live DOI (CrossRef) / ISBN (OpenLibrary) resolution
- GET /collections — browsable collections; /collections/{flavor}/entries/{key} — record pages
- OpenAPI spec: /openapi.json — reference UI: /docs — GraphQL: /graphql

## MCP server
- URL: https://api.relaton.org/mcp (Streamable HTTP, JSON-RPC 2.0, public, read-only)
- Tools: relaton_search, relaton_fetch (yaml|xml|json), relaton_cite (Metanorma anchor + AsciiBib block),
  relaton_create_record, relaton_verify
- Prompt: cite-in-metanorma — the full find/cite/verify workflow for editing Metanorma documents

## Citing in Metanorma
Records are cited by anchor: <<ANCHOR>> or cite:[ANCHOR] in the text, with the
AsciiBib block (path-style, per relaton.org/specs/asciibib) pasted under a
[bibliography] heading. Every record page exposes both with copy buttons.
Field semantics: relaton.org/model — serializations: relaton.org/specs/relaton-yaml.

## Record model
Records are Relaton bibliographic items (relaton.org/model); the TypeScript
implementation with zod schemas and YAML/XML/AsciiBib serializers is
relaton-ts (github.com/relaton/relaton-api-js, packages/relaton-ts).
`;

export function createApp(configInput: unknown = {}) {
  const config: RelatonApiConfig = parseConfig(configInput);
  const app = new OpenAPIHono<AppEnv>();

  app.doc31(config.paths.openapi, (c) => ({
    openapi: "3.1.0",
    info: {
      title: config.name,
      version: c.env.API_VERSION ?? "dev",
      description:
        "Bibliographic data for technical standards, aggregated across relaton-data-* repositories.",
    },
    servers: [{ url: "https://api.relaton.org" }],
  }));

  app.get(config.paths.docs, (c) => c.html(`<!doctype html>
<html>
  <head>
    <title>${config.name}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <scalar-api-reference url="${config.paths.openapi}"></scalar-api-reference>
  </body>
</html>`));

  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }));

  app.get("/", async (c) =>
    c.html(await renderHome(c.env.DB, c.env.API_VERSION ?? "dev", config.name), 200, {
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    }));

  app.get("/assets/metanorma-icon-dark-bg.svg", (c) =>
    c.body(METANORMA_ICON_DARK_BG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" }));
  app.get("/assets/metanorma-icon-light-bg.svg", (c) =>
    c.body(METANORMA_ICON_LIGHT_BG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" }));
  app.get("/search", async (c) =>
    c.html(await renderSearchPage(c.env, c.env.DB, new URL(c.req.url)), 200, {
      // Search is query-dependent; a one-minute window absorbs paging clicks.
      "cache-control": "public, max-age=60, stale-while-revalidate=3600",
    }));
  app.get("/verify", async (c) => c.html(await renderVerifyPage(c.req.query("code"))));
  app.get("/ai", (c) => c.html(renderAiPage()));
  app.get("/llms.txt", (c) => c.text(LLMS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" }));
  app.post("/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const req = body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      const result = await handleMcp(c.env as never, {
        jsonrpc: req.jsonrpc ?? "2.0",
        id: req.id ?? null,
        method: req.method ?? "",
        params: req.params,
      });
      return c.json({ jsonrpc: "2.0", id: req.id ?? null, result });
    } catch (e) {
      return c.json({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: String(e) } });
    }
  });
  app.get("/mcp", (c) => c.text("Relaton MCP server — POST JSON-RPC 2.0 here (Streamable HTTP, stateless). See /ai for setup.", 405, { Allow: "POST" }));
  app.get("/create", (c) => c.html(renderCreatePage()));
  app.post("/create/preview", async (c) => {
    const payload = await c.req.json<CreatePayload>().catch(() => ({}));
    return c.json(renderCreatePreview(payload));
  });


  app.route("/", restRoutes);
  app.route("/", v3Routes);
  app.route("/", machineIndexRoutes);
  app.route("/", cloudStoreRoutes);
  app.route("/", adminRoutes);
  app.all(config.paths.graphql, graphqlRoute());

  app.notFound((c) => c.text("Resource doesn't exist.", 404));

  // Surface the actual error so debugging doesn't require tail.
  app.onError((err, c) => {
    console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.text(`Internal server error: ${err.message}`, 500);
  });

  return app;
}
