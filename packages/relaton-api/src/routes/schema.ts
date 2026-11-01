import { Hono } from "hono";
import type { AppEnv } from "../env";
// The authoritative model schemas, generated from relaton/relaton's
// lutaml definitions and shipped in the `relaton` npm package (see its
// schema/manifest.json for the source pin). Served verbatim as the
// published contract for the JSON serialization (TODO.api/05).
import bibItemSchema from "relaton/schema/bib-item.schema.json";
import ietfItemSchema from "relaton/schema/ietf-item.schema.json";
import manifest from "relaton/schema/manifest.json";

const IMMUTABLE = "public, max-age=31536000, immutable";

export const schemaRoutes = new Hono<AppEnv>();

const SCHEMAS: Record<string, unknown> = {
  "relaton-bib-item.json": bibItemSchema,
  "relaton-ietf-item.json": ietfItemSchema,
};

schemaRoutes.get("/schema/:name", (c) => {
  const schema = SCHEMAS[c.req.param("name")];
  if (!schema) return c.json({ type: "about:blank", title: "Not Found", status: 404 }, 404);
  return c.body(JSON.stringify(schema), 200, {
    "Content-Type": "application/schema+json",
    "Cache-Control": IMMUTABLE,
  });
});

schemaRoutes.get("/schema", (c) =>
  c.json({
    package: "relaton",
    source: manifest.source,
    source_ref: manifest.ref,
    schemas: Object.keys(SCHEMAS).map((name) => `/schema/${name}`),
  }),
);
