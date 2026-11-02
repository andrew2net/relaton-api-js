import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../../../migrations/0001_init.sql?raw";
import storageV2Sql from "../../../migrations/0007_storage_v2.sql?raw";

// API v3 (TODO.api/03) over storage v2: seeded through the ingest-v2 admin
// route, then served by the routes under test.
const DOC = (key: string, year: string, title: string) => ({
  doctype: "standard",
  docidentifier: [{ content: key, type: "ISO", primary: true }],
  title: [{ content: title, type: "main", language: ["en"] }],
  date: [{ type: "published", on: `${year}-01-01` }],
});

const XML = (key: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<bibdata type="standard"><docidentifier type="ISO" primary="true">${key}</docidentifier></bibdata>`;

function auth(init: RequestInit = {}): RequestInit {
  const token = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  };
}

async function seed() {
  await SELF.fetch("http://localhost/admin/ingest-v2/iso", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flavor: "iso",
      repo: "relaton/relaton-data-iso",
      final: true,
      relatonVersion: "3.0.4",
      rows: [
        { key: "ISO 19115-1:2014", file: "data/iso-19115-1-2014.yaml", data: DOC("ISO 19115-1:2014", "2014", "Metadata"), keys: ["ISO19115-1:2014"] },
        { key: "ISO 19115-1:2018", file: "data/iso-19115-1-2018.yaml", data: DOC("ISO 19115-1:2018", "2018", "Metadata"), keys: ["ISO19115-1:2018"] },
        { key: "ISO 99999:2999", file: "data/iso-99999.yaml", data: DOC("ISO 99999:2999", "2999", "No XML here"), keys: ["ISO99999:2999", "ISO999992999"] },
      ],
      blobs: {
        "iso/data/iso-19115-1-2014": XML("ISO 19115-1:2014"),
        "iso/data/iso-19115-1-2018": XML("ISO 19115-1:2018"),
      },
    }),
  }));
}

beforeAll(async () => {
  for (const sql of [schemaSql, storageV2Sql]) {
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  }
  await seed();
});

describe("GET /v3/documents/{key}", () => {
  it("serves the model JSON by default", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<Record<string, unknown>>();
    expect(body.docidentifier).toEqual([{ content: "ISO 19115-1:2014", type: "ISO", primary: true }]);
  });

  it("negotiates YAML via Accept and format", async () => {
    for (const [init, type] of [
      [{ headers: { Accept: "application/yaml" } }, "application/yaml"],
      [{ headers: { Accept: "application/relaton+xml" } }, "application/relaton+xml"],
      [{ url: "?format=yaml" }, "application/yaml"],
    ] as [RequestInit, string][]) {
      const url = "url" in init ? `http://localhost/v3/documents/ISO%2019115-1:2014${init.url}` : "http://localhost/v3/documents/ISO%2019115-1:2014";
      const res = await SELF.fetch(url, init);
      expect(res.headers.get("content-type")).toContain(type);
      await res.text();
    }
  });

  it("serves the stored bibdata XML for the xml negotiation", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014", {
      headers: { Accept: "application/relaton+xml" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(XML("ISO 19115-1:2014").slice(-60));
  });

  it("answers 406 problem+json when XML is requested but none is stored", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%2099999:2999", {
      headers: { Accept: "application/relaton+xml" },
    });
    expect(res.status).toBe(406);
    const body = await res.json<Record<string, unknown>>();
    expect(body.title).toBe("Not Acceptable");
  });

  it("sets a strong ETag with immutable caching and answers 304", async () => {
    const first = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    await first.text();

    const second = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014", {
      headers: { "If-None-Match": etag },
    });
    expect(second.status).toBe(304);
  });

  it("answers HEAD with headers only", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%2019115-1:2014", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe("");
  });

  it("normalizes key spelling through the lookup tokens", async () => {
    // The dataset's normKey token (uppercased, whitespace-stripped) backs
    // the fallback, so case and spacing variants of a key resolve.
    for (const spelling of ["ISO19115-1:2014", "iso%2019115-1:2014", "ISO%20%2019115-1:2014"]) {
      const res = await SELF.fetch(`http://localhost/v3/documents/${spelling}`);
      expect(res.status, spelling).toBe(200);
      const body = await res.json<{ docidentifier: { content: string }[] }>();
      expect(body.docidentifier[0]!.content).toBe("ISO 19115-1:2014");
    }

    // Hyphen variants resolve against hyphen-free tokens (RFC-8446 → RFC8446).
    const hyphened = await SELF.fetch("http://localhost/v3/documents/ISO-99999-2999");
    expect(hyphened.status).toBe(200);
    expect(((await hyphened.json<{ docidentifier: { content: string }[] }>()).docidentifier[0]!).content).toBe("ISO 99999:2999");
  });

  it("404s as problem+json for an unknown key", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents/ISO%20NOTHING");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("GET /v3/documents", () => {
  it("pages key-ordered with a next Link header and follows the cursor", async () => {
    const first = await SELF.fetch("http://localhost/v3/documents?limit=2");
    expect(first.status).toBe(200);
    const body = await first.json<{ items: { key: string }[]; next_cursor: string | null }>();
    expect(body.items.map((i) => i.key)).toEqual(["ISO 19115-1:2014", "ISO 19115-1:2018"]);
    expect(body.next_cursor).toBeTruthy();
    expect(first.headers.get("Link")).toContain('rel="next"');

    const next = await SELF.fetch(`http://localhost/v3/documents?limit=2&cursor=${body.next_cursor}`);
    const page2 = await next.json<{ items: { key: string }[]; next_cursor: string | null }>();
    expect(page2.items.map((i) => i.key)).toEqual(["ISO 99999:2999"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("filters by flavor and title query", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents?q=Metadata&flavor=iso");
    const body = await res.json<{ items: { key: string }[] }>();
    expect(body.items.map((i) => i.key)).toEqual(["ISO 19115-1:2014", "ISO 19115-1:2018"]);
  });

  it("filters by identifier text, not just titles", async () => {
    // "19115" appears in the seeded docidentifier but in no title — the q
    // filter matches the identifiers projection too (v1 search parity).
    const res = await SELF.fetch("http://localhost/v3/documents?q=19115");
    const body = await res.json<{ items: { key: string }[] }>();
    expect(body.items.map((i) => i.key)).toEqual(["ISO 19115-1:2014", "ISO 19115-1:2018"]);
  });

  it("422s an invalid cursor as problem+json", async () => {
    const res = await SELF.fetch("http://localhost/v3/documents?cursor=%21%21not-base64%21%21");
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("GET /v3/flavors and /v3/version", () => {
  it("reports coverage and versions", async () => {
    const flavors = await SELF.fetch("http://localhost/v3/flavors");
    const flavorBody = await flavors.json<{ flavors: { flavor: string; doc_count: number }[] }>();
    expect(flavorBody.flavors).toEqual([{ flavor: "iso", repo: "relaton/relaton-data-iso", last_modified: null, indexed_at: expect.any(String), doc_count: 3 }]);

    const version = await SELF.fetch("http://localhost/v3/version");
    const versionBody = await version.json<{ release: string; relaton: string }>();
    expect(versionBody.relaton).toBe("3.0.4");
    expect(versionBody.release).toBeTruthy();
  });
});
