import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../../../migrations/0001_init.sql?raw";
import storageV2Sql from "../../../migrations/0007_storage_v2.sql?raw";
import { getDocument, getDocumentByLookupKey } from "../src/lib/storage2";

const DOC = {
  schema_version: "v1.5.6",
  doctype: "standard",
  title: [
    { content: "Geographic information - Metadata", type: "main", language: ["en"], script: ["Latn"] },
    { content: "Information géographique - Métadonnées", type: "main", language: ["fr"] },
  ],
  docidentifier: [
    { content: "ISO 19115-1:2014", type: "ISO", primary: true },
    { content: "10.2600/19115-1", type: "DOI" },
  ],
  date: [{ type: "published", on: "2014-04-01" }],
  contributor: [
    { organization: { name: "International Organization for Standardization", abbreviation: "ISO" }, role: [{ type: "publisher" }] },
  ],
  relation: [{ type: "updates", bibitem: { docidentifier: [{ content: "ISO 19115:2003", type: "ISO" }] } }],
  classification: [{ type: "ICS", value: "35.240.70" }],
};

function auth(init: RequestInit = {}): RequestInit {
  // Echo whatever token the test worker was configured with (a .dev.vars
  // secret locally, the wrangler.test.jsonc var in CI) — the test asserts
  // the gate's behavior, not a particular credential.
  const token = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  };
}

async function applySchema(sql: string) {
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

beforeAll(async () => {
  await applySchema(schemaSql);
  await applySchema(storageV2Sql);
});

async function postChunk(rows: unknown[], extra: Record<string, unknown> = {}) {
  return SELF.fetch("http://localhost/admin/ingest-v2/iso", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flavor: "iso",
      repo: "relaton/relaton-data-iso",
      rows,
      blobs: {},
      ...extra,
    }),
  }));
}

describe("POST /admin/ingest-v2/:flavor", () => {
  it("rejects a bad token and a flavor mismatch", async () => {
    const noAuth = await SELF.fetch("http://localhost/admin/ingest-v2/iso", {
      method: "POST",
      body: "{}",
    });
    expect(noAuth.status).toBe(403);

    const mismatch = await postChunk([], { flavor: "ieee" });
    expect(mismatch.status).toBe(400);
  });

  it("stores the model JSON, the lookup keys, and the projections", async () => {
    const res = await postChunk([
      { key: "ISO 19115-1:2014", file: "data/iso-19115-1-2014.yaml", data: DOC, keys: ["ISO19115-1:2014"] },
    ], { final: true, relatonVersion: "3.0.4" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rows: 1, blobs: 0 });

    const doc = await getDocument(env.DB, "ISO 19115-1:2014");
    expect(doc?.flavor).toBe("iso");
    expect(doc?.file).toBe("data/iso-19115-1-2014.yaml");
    expect(doc?.data).toEqual(DOC);

    const byKey = await getDocumentByLookupKey(env.DB, "ISO19115-1:2014");
    expect(byKey?.key).toBe("ISO 19115-1:2014");

    const titles = await env.DB.prepare("SELECT lang, text FROM titles WHERE document = ?1 ORDER BY lang")
      .bind("ISO 19115-1:2014").all();
    expect(titles.results).toEqual([
      { lang: "en", text: "Geographic information - Metadata" },
      { lang: "fr", text: "Information géographique - Métadonnées" },
    ]);

    const identifiers = await env.DB.prepare("SELECT raw, type, is_primary FROM identifiers WHERE document = ?1 ORDER BY raw")
      .bind("ISO 19115-1:2014").all();
    expect(identifiers.results).toEqual([
      { raw: "10.2600/19115-1", type: "DOI", is_primary: 0 },
      { raw: "ISO 19115-1:2014", type: "ISO", is_primary: 1 },
    ]);

    const dates = await env.DB.prepare("SELECT type, on_date FROM dates WHERE document = ?1")
      .bind("ISO 19115-1:2014").all();
    expect(dates.results).toEqual([{ type: "published", on_date: "2014-04-01" }]);

    const contributors = await env.DB.prepare("SELECT role, name, org_abbrev FROM contributors WHERE document = ?1")
      .bind("ISO 19115-1:2014").all();
    expect(contributors.results).toEqual([
      { role: "publisher", name: "International Organization for Standardization", org_abbrev: "ISO" },
    ]);

    const relations = await env.DB.prepare("SELECT type, target FROM relations WHERE document = ?1")
      .bind("ISO 19115-1:2014").all();
    expect(relations.results).toEqual([{ type: "updates", target: "ISO 19115:2003" }]);

    const classifications = await env.DB.prepare("SELECT type, value FROM classifications WHERE document = ?1")
      .bind("ISO 19115-1:2014").all();
    expect(classifications.results).toEqual([{ type: "ICS", value: "35.240.70" }]);

    const flavorRow = await env.DB.prepare("SELECT repo, doc_count FROM flavors_v2 WHERE flavor = 'iso'").first();
    expect(flavorRow).toMatchObject({ repo: "relaton/relaton-data-iso", doc_count: 1 });
    const version = await env.DB.prepare("SELECT value FROM meta WHERE key = 'relaton_version'").first();
    expect(version).toEqual({ value: "3.0.4" });
  });

  it("upserts by key and replaces keys and projections wholesale", async () => {
    const revised = { ...DOC, docidentifier: [{ content: "ISO 19115-1:2014", type: "ISO", primary: true }] };
    const res = await postChunk([
      { key: "ISO 19115-1:2014", file: "data/iso-19115-1-2014.yaml", data: revised, keys: ["ISO19115-1:2014", "ALIAS1"] },
    ]);
    expect(res.status).toBe(200);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM doc_keys WHERE document = ?1")
      .bind("ISO 19115-1:2014").first()).toEqual({ n: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identifiers WHERE document = ?1")
      .bind("ISO 19115-1:2014").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM documents_v2 WHERE flavor = 'iso'").first())
      .toEqual({ n: 1 });
  });

  it("writes blobs to R2", async () => {
    const res = await postChunk([
      { key: "ISO 99999:2999", file: "data/iso-99999.yaml", data: { title: "x" }, keys: [] },
    ], { blobs: { "iso/data/iso-99999": "<bibdata/>" } });
    expect(res.status).toBe(200);
    expect(await env.BUCKET.get("iso/data/iso-99999")).not.toBeNull();
  });
});
