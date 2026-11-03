import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

interface FakeFlavor {
  flavor: string;
  doc_count: number;
  last_modified: string | null;
  indexed_at: string;
}

function makeEnv(opts: {
  flavor: FakeFlavor | null;
  entry: { docid: string; file: string } | null;
  docids: string[];
  objects?: Record<string, string>;
}) {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        first: async () => {
          if (/COUNT\(\*\) AS n/.test(sql)) return { n: opts.docids.length };
          if (sql.includes("FROM flavors")) return opts.flavor;
          // The projection stores the dataset file; the entry lookup
          // resolves candidates against it.
          if (sql.includes("FROM documents_search")) return opts.entry;
          return null;
        },
        all: async () => {
          if (/AS value, COUNT\(\*\) AS count/.test(sql)) {
            return { results: [{ value: "standard", count: opts.docids.length }] };
          }
          if (sql.includes("FROM documents_search")) {
            return {
              results: opts.docids.map((docid) => ({
                key: docid,
                flavor: "ietf",
                docid,
                file: `data/${docid.toLowerCase().replace(/\s+/g, "-")}.yaml`,
                year: 2020,
                norm: docid.toUpperCase().replace(/\s+/g, ""),
              })),
            };
          }
          if (sql.includes("FROM flavors")) return { results: opts.flavor ? [opts.flavor] : [] };
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  const objects = opts.objects ?? {};
  const bucket = {
    get: async (key: string) => (objects[key] ? { text: async () => objects[key] } : null),
  };
  return { DB: db as unknown as D1Database, BUCKET: bucket as unknown as R2Bucket };
}

const flavorRow: FakeFlavor = {
  flavor: "ietf",
  doc_count: 2,
  last_modified: "2026-09-25T00:00:00Z",
  indexed_at: "2026-09-25T01:00:00Z",
};

describe("lutaml cloud store contract", () => {
  it("lists collections", async () => {
    const app = createApp({});
    const env = makeEnv({ flavor: flavorRow, entry: null, docids: ["RFC 7231", "RFC 3986"] });
    const res = await app.request("/collections", {}, env as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collections: [{ name: "ietf", count: 2 }] });
  });

  it("serves the collection manifest with etag and cache-control", async () => {
    const app = createApp({});
    const env = makeEnv({ flavor: flavorRow, entry: null, docids: ["RFC 7231", "RFC 3986"] });
    const res = await app.request("/collections/ietf/manifest", {}, env as never);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      version: number;
      count: number;
      generated: string;
      entries: { key: string; metadata?: Record<string, unknown> }[];
    };
    expect(manifest.version).toBe(1);
    expect(manifest.count).toBe(2);
    expect(manifest.generated).toBe("2026-09-25T00:00:00Z");
    expect(manifest.entries.map((e) => e.key)).toEqual(["rfc-7231", "rfc-3986"]);
    expect(manifest.entries[1]?.metadata).toEqual({ docid: "RFC 3986" });
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("serves an entry from R2 by storage key", async () => {
    const app = createApp({});
    const env = makeEnv({
      flavor: flavorRow,
      entry: { docid: "RFC 7231", file: "data/rfc-7231.yaml" },
      docids: ["RFC 7231"],
      objects: { "ietf/data/rfc-7231": "id: RFC7231\n" },
    });
    const res = await app.request("/collections/ietf/entries/rfc-7231", {}, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml");
    expect(await res.text()).toBe("id: RFC7231\n");
  });

  it("answers 404 definitively for unknown collections and entries", async () => {
    const app = createApp({});
    const unknownCollection = makeEnv({ flavor: null, entry: null, docids: [] });
    const res = await app.request("/collections/nope/manifest", {}, unknownCollection as never);
    expect(res.status).toBe(404);

    const unknownEntry = makeEnv({ flavor: flavorRow, entry: null, docids: [] });
    const noEntry = await app.request(
      "/collections/ietf/entries/rfc%209999",
      {},
      unknownEntry as never,
    );
    expect(noEntry.status).toBe(404);
  });
});

describe("lutaml cloud store UI", () => {
  const htmlEnv = makeEnv({
    flavor: flavorRow,
    entry: { docid: "RFC 7231", file: "data/rfc-7231.yaml" },
    docids: ["RFC 3986", "RFC 7231"],
    objects: { "ietf/data/rfc-7231": "id: RFC7231\n" },
  });

  it("serves JSON to clients and a browsable page to browsers on /collections", async () => {
    const app = createApp({});
    const env = makeEnv({ flavor: flavorRow, entry: null, docids: ["RFC 7231"] });

    const json = await app.request("/collections", {}, env as never);
    expect(json.headers.get("content-type")).toContain("application/json");

    const html = await app.request("/collections", {
      headers: { Accept: "text/html" },
    }, env as never);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("/collections/ietf");
  });

  it("serves a collection page with entry links, manifest link and a pager", async () => {
    const app = createApp({});
    const res = await app.request("/collections/ietf?page=1", {
      headers: { Accept: "text/html" },
    }, htmlEnv as never);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/collections/ietf/entries/rfc-7231");
    expect(html).toContain("manifest.json");
    expect(html).toContain("page 2"); // page=1 renders as page 2 (1-based)
  });

  it("frames an entry for browsers and links the raw bytes", async () => {
    const app = createApp({});
    const res = await app.request("/collections/ietf/entries/rfc-7231", {
      headers: { Accept: "text/html" },
    }, htmlEnv as never);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("id: RFC7231");
    expect(html).toContain("?raw=1");
  });

  it("keeps raw bytes for API clients regardless of Accept", async () => {
    const app = createApp({});
    const client = await app.request("/collections/ietf/entries/rfc-7231", {
      headers: { Accept: "*/*" },
    }, htmlEnv as never);
    expect(client.headers.get("content-type")).toBe("application/yaml");
    expect(await client.text()).toBe("id: RFC7231\n");
  });

  it("exports a record as schema.org JSON-LD", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bibdata type="standard">
  <docidentifier type="IETF" primary="true">RFC 7231</docidentifier>
  <title language="en" script="Latn" type="main">Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content</title>
  <date type="published"><on>2022-06-21</on></date>
</bibdata>`;
    const app = createApp({});
    const env = makeEnv({
      flavor: flavorRow,
      entry: { docid: "RFC 7231", file: "data/rfc-7231.yaml" },
      docids: ["RFC 7231"],
      objects: { "ietf/data/rfc-7231": xml },
    });

    const res = await app.request(
      "/collections/ietf/entries/rfc-7231/export.jsonld",
      {},
      env as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/ld+json");

    const json = (await res.json()) as Record<string, any>;
    expect(json["@context"]).toBe("https://schema.org");
    expect(json["@type"]).toBe("CreativeWork");
    expect(json.identifier).toBe("RFC 7231");
    expect(json.name).toContain("Hypertext Transfer Protocol");
    expect(json.datePublished).toBe("2022-06-21");
  });
});

describe("record export over YAML storage", () => {
  const yaml = `---
id: RFC7231
title:
- content: "Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content"
  language: en
  script: Latn
  type: main
date:
- type: published
  at: 2022-06-21
docidentifier:
- content: RFC 7231
  type: IETF
  primary: true
`;

  function yamlEnv() {
    return makeEnv({
      flavor: flavorRow,
      entry: { docid: "RFC 7231", file: "data/rfc-7231.yaml" },
      docids: ["RFC 7231"],
      objects: { "ietf/data/rfc-7231": yaml },
    });
  }

  function exportAs(format: string, env: unknown) {
    const app = createApp({});
    return app.request(
      `/collections/ietf/entries/rfc-7231/export.${format}`,
      {},
      env as never,
    );
  }

  it("exports JSON-LD from a YAML-stored record", async () => {
    const res = await exportAs("jsonld", yamlEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json["@type"]).toBe("CreativeWork");
    expect(json.name).toContain("Hypertext Transfer Protocol");
  });

  it("exports CSL from a YAML-stored record", async () => {
    const res = await exportAs("csl.json", yamlEnv());
    expect(res.status).toBe(200);
    const items = JSON.parse(await res.text()) as { title?: string }[];
    expect(Array.isArray(items)).toBe(true);
    expect(String(items[0]?.title)).toContain("Hypertext Transfer Protocol");
  });
});
