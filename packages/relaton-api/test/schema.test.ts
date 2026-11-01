import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// The /schema routes (TODO.api/05): the model schemas shipped in the
// `relaton` npm package, served verbatim as the published contract for
// the JSON serialization.
describe("GET /schema", () => {
  it("indexes the served schemas with their source pin", async () => {
    const res = await SELF.fetch("http://localhost/schema");
    expect(res.status).toBe(200);
    const body = await res.json<{ package: string; source: string; schemas: string[] }>();
    expect(body.package).toBe("relaton");
    expect(body.source).toBe("relaton/relaton");
    expect(body.schemas).toEqual(["/schema/relaton-bib-item.json", "/schema/relaton-ietf-item.json"]);
  });

  it("serves the bib-item schema as an immutable JSON Schema", async () => {
    const res = await SELF.fetch("http://localhost/schema/relaton-bib-item.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/schema+json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const schema = await res.json<{ $schema: string; $defs: Record<string, unknown> }>();
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.$defs).toHaveProperty("Relaton_Bib_Item");
  });

  it("serves the ietf-item schema and 404s unknown names", async () => {
    const res = await SELF.fetch("http://localhost/schema/relaton-ietf-item.json");
    expect(res.status).toBe(200);
    await res.text();

    const missing = await SELF.fetch("http://localhost/schema/nope.json");
    expect(missing.status).toBe(404);
  });
});
