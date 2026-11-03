import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../migrations/0001_init.sql?raw";
import storageV2Sql from "../migrations/0007_storage_v2.sql?raw";
import searchV2Sql from "../migrations/0009_documents_search.sql?raw";
import { splitSqlStatements } from "./split-sql";

// Storage unification (TODO.api/03 remaining): the search, collections,
// and MCP surfaces served from documents_search — the v2 projection the
// ingest writes. Seeding through /admin/ingest-v2 fills it, so the
// searchReady() probe routes these requests to the v2 engine.

const DOC = (key: string, year: string, title: string, docid = key) => ({
  doctype: "standard",
  docidentifier: [{ content: docid, type: "ISO", primary: true }],
  title: [{ content: title, type: "main", language: ["en"] }],
  date: [{ type: "published", on: `${year}-01-01` }],
});

function auth(init: RequestInit = {}): RequestInit {
  const token = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  };
}

async function seed() {
  // The dataset keys carry only the undated canonical form; the dated
  // printed docid resolves through the identifiers projection (v3 fallback)
  // and the search row's pubid derivation.
  const res = await SELF.fetch("http://localhost/admin/ingest-v2/iso", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flavor: "iso",
      repo: "relaton/relaton-data-iso",
      final: true,
      relatonVersion: "3.0.4",
      rows: [
        {
          key: "ISO 19115",
          file: "data/iso-19115.yaml",
          data: DOC("ISO 19115", "2003", "Geographic information - Metadata"),
          keys: ["ISO19115"],
        },
        {
          key: "ISO 19115-1",
          file: "data/iso-19115-1.yaml",
          data: DOC("ISO 19115-1", "2014", "Geographic information - Metadata - Part 1: Fundamentals", "ISO 19115-1:2014"),
          keys: ["ISO19115-1"],
        },
        {
          key: "ISO 19115-2",
          file: "data/iso-19115-2.yaml",
          data: DOC("ISO 19115-2", "2019", "Geographic information - Metadata - Part 2: Imagery"),
          keys: ["ISO19115-2"],
        },
      ],
      blobs: {
        "iso/data/iso-19115-1": `<?xml version="1.0" encoding="UTF-8"?>
<bibdata type="standard">
  <docidentifier type="ISO" primary="true">ISO 19115-1:2014</docidentifier>
  <title type="main" language="en">Geographic information - Metadata - Part 1: Fundamentals</title>
  <date type="published"><on>2014-12-01</on></date>
</bibdata>`,
      },
    }),
  }));
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  for (const sql of [schemaSql, storageV2Sql, searchV2Sql]) {
    await env.DB.batch(splitSqlStatements(sql).map((s) => env.DB.prepare(s)));
  }
  await seed();
});

describe("search over documents_search", () => {
  it("finds documents by title keyword", async () => {
    const res = await SELF.fetch("http://localhost/search?q=Metadata");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/collections/iso/entries/iso-19115-1");
    expect(html).toContain("Geographic information");
  });

  it("matches identifiers, not only titles", async () => {
    // "19115-2" appears in the docid but in no title; FTS tokenization
    // (same unicode61 rules as the v1 engine) also lets the 2014 year
    // token match the "2" prefix, so only assert the target is present.
    const res = await SELF.fetch("http://localhost/search?q=19115-2");
    const html = await res.text();
    expect(html).toContain("/collections/iso/entries/iso-19115-2");
  });

  it("filters by pubid components", async () => {
    const res = await SELF.fetch("http://localhost/search?publisher=ISO&number=19115");
    const html = await res.text();
    expect(html).toContain("entries/iso-19115");
    expect((html.match(/entries\/iso-19115/g) ?? []).length).toBe(3);
  });
});

describe("collections over the v2 projection", () => {
  it("lists collections from flavors_v2", async () => {
    const res = await SELF.fetch("http://localhost/collections");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collections: [{ name: "iso", count: 3 }] });
  });

  it("serves a manifest keyed by the entry address space", async () => {
    const res = await SELF.fetch("http://localhost/collections/iso/manifest");
    expect(res.status).toBe(200);
    const manifest = await res.json<{ entries: { key: string }[] }>();
    // File-lexicographic order: "-1"/"-2" sort before the bare suffix.
    expect(manifest.entries.map((e) => e.key)).toEqual(["iso-19115-1", "iso-19115-2", "iso-19115"]);
  });

  it("serves an entry blob and frames the page", async () => {
    const raw = await SELF.fetch("http://localhost/collections/iso/entries/iso-19115-1");
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("bibdata");

    const page = await SELF.fetch("http://localhost/collections/iso/entries/iso-19115-1", {
      headers: { Accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ISO 19115-1:2014");
  });
});

describe("MCP over the v2 projection", () => {
  async function rpc(method: string, params: Record<string, unknown>, name?: string, args?: Record<string, unknown>) {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: args } : params }),
    });
    return res.json<{ result?: Record<string, unknown>; error?: { message: string } }>();
  }

  it("search returns entries from documents_search", async () => {
    const out = await rpc("tools/call", {}, "relaton_search", { q: "19115" });
    const payload = JSON.parse((out.result!.content as { text: string }[])[0]!.text) as {
      total: number;
      items: { docid: string; record: string }[];
    };
    expect(payload.total).toBe(3);
    expect(payload.items[0]!.record).toContain("/collections/iso/entries/iso-19115");
  });

  it("fetch resolves an undated code to the latest edition and reads the blob", async () => {
    const out = await rpc("tools/call", {}, "relaton_fetch", { code: "ISO 19115-1", format: "xml" });
    const text = (out.result!.content as { text: string }[])[0]!.text;
    expect(text).toContain("ISO 19115-1:2014");
  });
});

describe("admin build-search backfill", () => {
  it("rebuilds the projection from documents_v2", async () => {
    // Drop the ingest-written rows to prove the walk rebuilds them from
    // the lossless store alone.
    await env.DB.prepare("DELETE FROM documents_search").run();
    const first = await SELF.fetch("http://localhost/admin/build-search?limit=2", auth({ method: "POST" }));
    expect(first.status).toBe(200);
    const page1 = await first.json<{ scanned: number; nextCursor: string | null }>();
    expect(page1.scanned).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await SELF.fetch(`http://localhost/admin/build-search?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, auth({ method: "POST" }));
    const page2 = await second.json<{ scanned: number; nextCursor: string | null }>();
    expect(page2.scanned).toBe(1);
    expect(page2.nextCursor).toBeNull();

    const res = await SELF.fetch("http://localhost/search?q=Metadata");
    const html = await res.text();
    expect(html).toContain("entries/iso-19115-1");
  });
});

describe("v3 resolves a dated printed form via the identifiers projection", () => {
  it("serves ISO 19115-1:2014 whose dataset key is undated", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014");
    expect(res.status).toBe(200);
    const body = await res.json<{ docidentifier: { content: string }[] }>();
    expect(body.docidentifier[0]!.content).toBe("ISO 19115-1:2014");
  });
});
