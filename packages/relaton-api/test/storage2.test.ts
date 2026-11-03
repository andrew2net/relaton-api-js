import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../migrations/0001_init.sql?raw";
import storageV2Sql from "../migrations/0007_storage_v2.sql?raw";
import searchV2Sql from "../migrations/0009_documents_search.sql?raw";
import { splitSqlStatements } from "./split-sql";
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
  const statements = splitSqlStatements(sql);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

beforeAll(async () => {
  await applySchema(schemaSql);
  await applySchema(storageV2Sql);
  await applySchema(searchV2Sql);
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

  it("projects nested-content shapes without choking D1", async () => {
    // Datasets (IANA among them) interchange strings and {content: ...} /
    // {value: ...} shapes; every projection column is TEXT, so the
    // extractors read through to the scalar and null the rest.
    const nested = {
      title: [{ content: { content: "Nested title" }, type: "main", language: [{ content: "en" }] }],
      docidentifier: [{ content: { content: "IANA x/y" }, type: { value: "IANA" }, primary: true }],
      date: [{ type: { value: "published" }, on: { content: "2024-01-01" } }],
      contributor: [{ organization: { name: { content: "IANA" }, abbreviation: "IANA" }, role: [{ type: { content: "publisher" } }] }],
      relation: [{ type: { content: "updates" }, bibitem: { docidentifier: [{ content: { content: "IANA x" } }] } }],
      classification: [{ type: "ICS", value: { content: "35.240" } }],
    };
    const res = await postChunk([
      { key: "IANA x/y", file: "data/x.yaml", data: nested, keys: ["IANAX/Y"] },
    ]);
    expect(res.status).toBe(200);

    expect((await env.DB.prepare("SELECT text FROM titles WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ text: "Nested title" }]);
    expect((await env.DB.prepare("SELECT raw, type FROM identifiers WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ raw: "IANA x/y", type: "IANA" }]);
    expect((await env.DB.prepare("SELECT on_date FROM dates WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ on_date: "2024-01-01" }]);
    expect((await env.DB.prepare("SELECT role, name FROM contributors WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ role: "publisher", name: "IANA" }]);
    expect((await env.DB.prepare("SELECT type, target FROM relations WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ type: "updates", target: "IANA x" }]);
    expect((await env.DB.prepare("SELECT value FROM classifications WHERE document = 'IANA x/y'").all()).results)
      .toEqual([{ value: "35.240" }]);
  });

  it("projects v1.2-era dataset shapes (docid/id, format-only titles, date values)", async () => {
    // The shape the iana probe served first: `docid` with `id`, titles
    // without `type`, dates carrying `value`, array-wrapped org names.
    const oldSchema = {
      "schema-version": "v1.2.9",
      id: "IANAchannel-binding-types",
      title: [{ content: "Channel-Binding Types", format: "text/plain" }],
      type: "standard",
      docid: [{ id: "IANA channel-binding-types", type: "IANA", primary: true }],
      date: [{ type: "updated", value: "2022-07-28" }],
      contributor: [{
        organization: { name: [{ content: "Internet Assigned Numbers Authority" }], abbreviation: { content: "IANA" } },
        role: [{ type: "publisher" }],
      }],
      language: ["en"],
      script: ["Latn"],
    };
    const res = await postChunk([
      { key: "IANA channel-binding-types", file: "data/channel-binding-types.yaml", data: oldSchema, keys: ["IANACHANNEL-BINDING-TYPES"] },
    ]);
    expect(res.status).toBe(200);

    const titles = await env.DB.prepare("SELECT type, text FROM titles WHERE document = ?1")
      .bind("IANA channel-binding-types").all();
    expect(titles.results).toEqual([{ type: "main", text: "Channel-Binding Types" }]);

    const ids = await env.DB.prepare("SELECT raw, type, is_primary FROM identifiers WHERE document = ?1")
      .bind("IANA channel-binding-types").all();
    expect(ids.results).toEqual([{ raw: "IANA channel-binding-types", type: "IANA", is_primary: 1 }]);

    const dates = await env.DB.prepare("SELECT type, on_date FROM dates WHERE document = ?1")
      .bind("IANA channel-binding-types").all();
    expect(dates.results).toEqual([{ type: "updated", on_date: "2022-07-28" }]);

    const contributors = await env.DB.prepare("SELECT role, name, org_abbrev FROM contributors WHERE document = ?1")
      .bind("IANA channel-binding-types").all();
    expect(contributors.results).toEqual([
      { role: "publisher", name: "Internet Assigned Numbers Authority", org_abbrev: "IANA" },
    ]);
  });
});
