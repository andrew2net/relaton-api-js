import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../packages/relaton-api/migrations/0001_init.sql?raw";

const XML = (id: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<bibdata type="standard"><docidentifier type="ISO" primary="true">${id}</docidentifier><title language="en" script="Latn" type="main">Sample document ${id}</title></bibdata>`;

const normOf = (s: string) => s.toUpperCase().replace(/\s+/g, "");
const undatedOf = (n: string) => n.replace(/:(\d{4})(?=[^-]*$)/, "");
const allPartsOf = (n: string) => undatedOf(n).replace(/-\d+[A-Z]?$/, "");

function doc(
  file: string,
  docid: string,
  year: number,
  title: string,
) {
  const norm = normOf(docid);
  return [
    env.DB.prepare(
      `INSERT INTO documents
         (flavor, file_path, kind, r2_key, docid, norm, undated_norm, allparts_norm, year, published, title_en, doctype, status)
       VALUES ('iso', ?1, 'document', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'standard', NULL)`,
    ).bind(
      file, `iso/${file.replace(/\.yaml$/, "")}`, docid, norm,
      undatedOf(norm), allPartsOf(norm), year, `${year}-01-01`, title,
    ),
    env.DB.prepare(
      `INSERT INTO docids (norm, raw, type, document_id)
       SELECT ?1, ?2, 'ISO', id FROM documents WHERE flavor = 'iso' AND file_path = ?3`,
    ).bind(norm, docid, file),
  ];
}

beforeAll(async () => {
  const statements = schemaSql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    ...doc("data/iso-19115-1-2014.yaml", "ISO 19115-1:2014", 2014, "Geographic information - Metadata - Part 1"),
    ...doc("data/iso-19115-1-2018.yaml", "ISO 19115-1:2018", 2018, "Geographic information - Metadata - Part 1"),
    ...doc("data/iso-19115-2.yaml", "ISO 19115-2:2019", 2019, "Geographic information - Metadata - Part 2"),
    ...doc("data/iec-31010.yaml", "IEC 31010:2019", 2019, "Risk management - Risk assessment techniques"),
    env.DB.prepare(
      `INSERT INTO flavors (flavor, repo, last_modified, ingested_at, doc_count)
       VALUES ('iso', 'relaton/relaton-data-iso', NULL, '2026-08-16T00:00:00Z', 3)`,
    ),
  ]);
  await env.BUCKET.put("iso/data/iso-19115-1-2014", XML("ISO 19115-1:2014"));
  await env.BUCKET.put("iso/data/iso-19115-1-2018", XML("ISO 19115-1:2018"));
  await env.BUCKET.put("iso/data/iso-19115-2", XML("ISO 19115-2:2019"));
  await env.BUCKET.put("iso/data/iec-31010", XML("IEC 31010:2019"));
});

describe("GET /api/v1/document", () => {
  it("returns XML for exact code with year", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO%2019115-1:2014");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const body = await res.text();
    expect(body).toContain("ISO 19115-1:2014");
  });

  it("returns latest edition for undated code", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO%2019115-1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ISO 19115-1:2018");
  });

  it("honours the year parameter", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO%2019115-1&year=2014");
    expect(await res.text()).toContain("ISO 19115-1:2014");
  });

  it("all_parts matches the family", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO%2019115&all_parts=true");
    expect(res.status).toBe(200);
  });

  it("normalizes dashes, nbsp and scope wrappers", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO(ISO%C2%A019115%E2%80%931:2014)");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ISO 19115-1:2014");
  });

  it("falls back to last publisher for slash-qualified codes", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO/IEC%2031010");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("IEC 31010");
  });

  it("canonicalizes pubid variants before matching", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents
           (flavor, file_path, kind, r2_key, docid, norm, undated_norm, allparts_norm, year, published, title_en, doctype, status)
         VALUES ('iso', 'data/awi-iwa-47.yaml', 'document', 'iso/data/awi-iwa-47', 'AWI IWA 47', 'AWIIWA47', 'AWIIWA47', 'AWIIWA', 2026, '2026-01-01', 'IWA test', 'standard', NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO docids (norm, raw, type, document_id)
         SELECT 'AWIIWA47', 'AWI IWA 47', 'canonical', id FROM documents WHERE flavor = 'iso' AND file_path = 'data/awi-iwa-47.yaml'`,
      ),
    ]);
    await env.BUCKET.put("iso/data/awi-iwa-47", XML("AWI IWA 47"));

    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO/AWI%20IWA%2047");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("AWI IWA 47");
  });

  it("returns 400 without code and 404 for unknown", async () => {
    expect((await SELF.fetch("http://localhost/api/v1/document")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/v1/document?code=ISO%2099999")).status).toBe(404);
  });

  it("sends CORS headers", async () => {
    const res = await SELF.fetch("http://localhost/api/v1/document?code=ISO%2019115-1");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/v1/version", () => {
  it("supports text, xml and json formats", async () => {
    const text = await (await SELF.fetch("http://localhost/api/v1/version")).text();
    expect(text).toMatch(/^Release: /);
    const xml = await (await SELF.fetch("http://localhost/api/v1/version?format=xml")).text();
    expect(xml).toContain("<release>");
    const json = await (await SELF.fetch("http://localhost/api/v1/version?format=json")).json();
    expect(json).toHaveProperty("release");
    expect(json).toHaveProperty("relaton");
  });
});

describe("POST /graphql", () => {
  it("resolves document with identifiers and xml", async () => {
    const res = await SELF.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ document(code: "ISO 19115-1") { docid flavor year title identifiers { raw type } xml } }`,
      }),
    });
    const { data } = await res.json<{ data: unknown }>();
    expect(data).toMatchObject({
      document: {
        docid: "ISO 19115-1:2018",
        flavor: "iso",
        year: 2018,
        title: expect.stringContaining("Geographic information"),
        identifiers: expect.arrayContaining([expect.objectContaining({ raw: "ISO 19115-1:2018" })]),
        xml: expect.stringContaining("<bibdata"),
      },
    });
  });

  it("searches across flavors by code and title with pagination", async () => {
    const res = await SELF.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ documents(code: "ISO 19115-1", first: 1) { edges { node { docid year } } pageInfo { hasNextPage endCursor } } }`,
      }),
    });
    const json = await res.json<{ data: { documents: { edges: { node: { docid: string } }[]; pageInfo: { hasNextPage: boolean } } } }>();
    expect(json.data.documents.edges).toHaveLength(1);
    expect(json.data.documents.pageInfo.hasNextPage).toBe(true);

    const titleRes = await SELF.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ documents(title: "Metadata") { edges { node { docid } } } }`,
      }),
    });
    const titleJson = await titleRes.json<{ data: { documents: { edges: { node: { docid: string } }[] } } }>();
    expect(titleJson.data.documents.edges.length).toBeGreaterThanOrEqual(2);
  });
});

describe("admin ingest", () => {
  it("rejects without token", async () => {
    const res = await SELF.fetch("http://localhost/admin/ingest/iso", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flavor: "iso", rows: [], blobs: {} }),
    });
    expect(res.status).toBe(403);
  });
});
