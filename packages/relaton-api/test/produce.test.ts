import { describe, expect, it } from "vitest";
import { produceV2Chunks, type ProduceOptions } from "../src/ingest/produce";

const MANIFEST = JSON.stringify({ version: 2, shards: 2, count: 4 });

const YAML_DOC = (id: string) =>
  `---
schema_version: v1.5.6
title:
  content: Document ${id}
  type: main
docidentifier:
  content: ${id}
  type: RFC
  primary: true
`;

function stubFetch(shards: Record<string, unknown>, docs: Record<string, string>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("manifest.json")) return new Response(MANIFEST);
    const shard = url.match(/(shard-\d{5}\.json)$/)?.[1];
    if (shard) {
      if (!(shard in shards)) return new Response("no", { status: 404 });
      return new Response(JSON.stringify(shards[shard]));
    }
    const file = url.split("/").slice(-2).join("/");
    if (file in docs) return new Response(docs[file]);
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

function options(over: Partial<ProduceOptions>): ProduceOptions {
  return {
    flavor: "rfcs",
    pagesBase: "https://pages.example/rfcs",
    onProgress: () => {},
    fetchImpl: stubFetch(
      { "shard-00000.json": [{ r: "RFC 8446", file: "data/rfc8446.yaml" }, { r: "RFC 3986", file: "data/rfc3986.yaml" }] },
      {
        "data/rfc8446.yaml": YAML_DOC("RFC 8446"),
        "data/rfc3986.yaml": YAML_DOC("RFC 3986"),
      },
    ),
    ...over,
  };
}

async function collect(opts: ProduceOptions) {
  const chunks = [];
  for await (const chunk of produceV2Chunks(opts)) chunks.push(chunk);
  return chunks;
}

describe("produceV2Chunks", () => {
  it("turns machine-index rows into v2 rows: model JSON in, normalized key out", async () => {
    const chunks = await collect(options({ chunkSize: 10 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.final).toBe(true);
    expect(chunks[0]!.repo).toBe("relaton/relaton-data-rfcs");
    expect(chunks[0]!.rows).toEqual([
      {
        key: "RFC 8446",
        file: "data/rfc8446.yaml",
        data: { schema_version: "v1.5.6", title: { content: "Document RFC 8446", type: "main" }, docidentifier: { content: "RFC 8446", type: "RFC", primary: true } },
        keys: ["RFC8446"],
      },
      {
        key: "RFC 3986",
        file: "data/rfc3986.yaml",
        data: { schema_version: "v1.5.6", title: { content: "Document RFC 3986", type: "main" }, docidentifier: { content: "RFC 3986", type: "RFC", primary: true } },
        keys: ["RFC3986"],
      },
    ]);
  });

  it("respects the chunk size", async () => {
    const chunks = await collect(options({ chunkSize: 1 }));
    expect(chunks.map((c) => c.rows.length)).toEqual([1, 1]);
    expect(chunks.at(-1)!.final).toBe(true);
  });

  it("skips missing dataset documents without failing the wave", async () => {
    const opts = options({ chunkSize: 10 });
    opts.fetchImpl = stubFetch(
      { "shard-00000.json": [{ r: "RFC 8446", file: "data/rfc8446.yaml" }, { r: "RFC GONE", file: "data/gone.yaml" }] },
      { "data/rfc8446.yaml": YAML_DOC("RFC 8446") },
    );
    const chunks = await collect(opts);
    expect(chunks[0]!.rows.map((r) => r.key)).toEqual(["RFC 8446"]);
    expect(chunks[0]!.final).toBe(true);
  });

  it("reads the monolith the manifest names when the corpus is below the sharding threshold", async () => {
    const opts = options({ chunkSize: 10 });
    const indexYaml = [
      "- :id:",
      "    _type: pubid:calconnect:standard",
      "  :file: data/cc-1.yaml",
      "- :id:",
      "    _type: pubid:calconnect:standard",
      "  :file: data/cc-2.yaml",
    ].join("\n");
    opts.fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return new Response(JSON.stringify({ version: 2, shards: 0, index: "index-v2", count: 2 }));
      if (url.endsWith("index-v2.yaml")) return new Response(indexYaml);
      const file = url.split("/").pop()!;
      if (file === "cc-1.yaml") return new Response(YAML_DOC("CC 1"));
      if (file === "cc-2.yaml") return new Response(YAML_DOC("CC 2"));
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    const chunks = await collect(opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.rows.map((r) => r.key)).toEqual(["CC 1", "CC 2"]);
    expect(chunks[0]!.rows[0]!.keys).toEqual(["CC1"]);
    expect(chunks[0]!.final).toBe(true);
  });

  it("skips a second index row that shares a file, keeping the first key", async () => {
    const opts = options({ chunkSize: 10 });
    opts.fetchImpl = stubFetch(
      {
        "shard-00000.json": [
          { r: "IANA foo", file: "data/foo.yaml" },
          { r: "IANA foo/foo-1", file: "data/foo.yaml" },
        ],
      },
      { "data/foo.yaml": YAML_DOC("IANA foo") },
    );
    const chunks = await collect(opts);
    expect(chunks[0]!.rows).toHaveLength(1);
    expect(chunks[0]!.rows[0]!.key).toBe("IANA foo");
    expect(chunks[0]!.final).toBe(true);
  });

  it("re-keys colliding editions from their structured ids (relaton-api-js#129)", async () => {
    // Two IHO editions print the same docid; their printed keys collide.
    // The first keeps the printed key (deterministic index order), the
    // later rows re-key edition-bearing from their structured ids via the
    // pubid engine - no doc_keys collision, no silently collapsed edition.
    const engine = {
      parse: (ref: string) => ({
        render: () => ref,
        constructor: {
          fromHash: (h: Record<string, unknown>) => ({
            render: () => `IHO S-129 ${h.edition as string}`,
          }),
        },
      }),
    };
    const opts = options({
      flavor: "iho",
      chunkSize: 10,
      engine,
    });
    opts.fetchImpl = stubFetch(
      {
        "shard-00000.json": [
          {
            r: "IHO S-129",
            file: "data/s-129_1-0-0.yaml",
            id: { _type: "pubid:iho:standard", number: "129", edition: "1.0.0" },
          },
          {
            r: "IHO S-129",
            file: "data/s-129_1-1-0.yaml",
            id: { _type: "pubid:iho:standard", number: "129", edition: "1.1.0" },
          },
        ],
      },
      {
        "data/s-129_1-0-0.yaml": YAML_DOC("IHO S-129"),
        "data/s-129_1-1-0.yaml": YAML_DOC("IHO S-129"),
      },
    );
    const logs: string[] = [];
    const chunks = await collect({ ...opts, onProgress: (m) => logs.push(m) });
    const keys = chunks.flatMap((c) => c.rows.map((r) => r.key));
    // The first row keeps the printed key; the colliding row re-keys
    // edition-bearing from its id.
    expect(keys).toContain("IHO S-129");
    expect(keys.filter((k) => k === "IHO S-129")).toHaveLength(1);
    expect(keys).toContain("IHO S-129 1.1.0");
    // Both editions survive: no silent collapse, no PK crash.
    expect(chunks.flatMap((c) => c.rows)).toHaveLength(2);
    // The normalized lookup tokens are distinct.
    const tokens = chunks.flatMap((c) => c.rows.flatMap((r) => r.keys));
    expect(new Set(tokens).size).toBe(2);
    // The collision was surfaced in the run log, not silently dropped.
    expect(logs.some((m) => m.includes("deferred"))).toBe(true);
    expect(logs.some((m) => m.startsWith("re-keyed: data/s-129_1-1-0.yaml"))).toBe(true);
  });

  it("skips a colliding row whose structured id yields no key", async () => {
    const opts = options({
      chunkSize: 10,
      engine: {
        parse: () => null,
      },
    });
    opts.fetchImpl = stubFetch(
      {
        "shard-00000.json": [
          { r: "RFC 8446", file: "data/rfc8446.yaml" },
          { r: "RFC 8446", file: "data/rfc8446-bis.yaml", id: { _type: "x" } },
        ],
      },
      {
        "data/rfc8446.yaml": YAML_DOC("RFC 8446"),
        "data/rfc8446-bis.yaml": YAML_DOC("RFC 8446"),
      },
    );
    const logs: string[] = [];
    const chunks = await collect({ ...opts, onProgress: (m) => logs.push(m) });
    expect(chunks[0]!.rows.map((r) => r.key)).toEqual(["RFC 8446"]);
    expect(logs.some((m) => m.includes("carries no structured id"))).toBe(true);
  });

  it("does not stamp final when maxRows truncates the wave", async () => {
    const chunks = await collect(options({ chunkSize: 1, maxRows: 1 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.final).toBe(false);
  });

  it("backs off and retries a 429 dataset fetch instead of skipping the row", async () => {
    const shards: Record<string, unknown> = {
      "shard-00000.json": [{ r: "RFC 8446", file: "data/rfc8446.yaml" }, { r: "RFC 3986", file: "data/rfc3986.yaml" }],
    };
    const docs: Record<string, string> = {
      "data/rfc8446.yaml": YAML_DOC("RFC 8446"),
      "data/rfc3986.yaml": YAML_DOC("RFC 3986"),
    };
    const opts = options({ chunkSize: 10, retryDelaysMs: [1, 1, 1] });
    let rfc8446Fetches = 0;
    opts.fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return new Response(MANIFEST);
      const shard = url.match(/(shard-\d{5}\.json)$/)?.[1];
      if (shard) {
        if (!(shard in shards)) return new Response("no", { status: 404 });
        return new Response(JSON.stringify(shards[shard]));
      }
      if (url.endsWith("data/rfc8446.yaml")) {
        rfc8446Fetches += 1;
        if (rfc8446Fetches === 1) {
          return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
      }
      const file = url.split("/").slice(-2).join("/");
      if (file in docs) return new Response(docs[file]);
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const logs: string[] = [];
    const chunks = await collect({ ...opts, onProgress: (m) => logs.push(m) });
    expect(rfc8446Fetches).toBe(2); // the 429 was retried, not skipped
    expect(chunks[0]!.rows.map((r) => r.key)).toEqual(["RFC 8446", "RFC 3986"]);
    expect(chunks[0]!.final).toBe(true);
    expect(logs.some((m) => m.includes("HTTP 429"))).toBe(true);
  });

  it("throttles the fetch concurrency when the host pushes back", async () => {
    const shards: Record<string, unknown> = { "shard-00000.json": [{ r: "RFC 1", file: "data/rfc1.yaml" }] };
    const docs: Record<string, string> = { "data/rfc1.yaml": YAML_DOC("RFC 1") };
    const opts = options({ chunkSize: 10, retryDelaysMs: [1, 1, 1], concurrency: 16 });
    let rfc1Fetches = 0;
    opts.fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return new Response(MANIFEST);
      const shard = url.match(/(shard-\d{5}\.json)$/)?.[1];
      if (shard) {
        if (!(shard in shards)) return new Response("no", { status: 404 });
        return new Response(JSON.stringify(shards[shard]));
      }
      if (url.endsWith("data/rfc1.yaml")) {
        rfc1Fetches += 1;
        if (rfc1Fetches <= 3) {
          // Repeated 429s: the gate halves its overlap each time it sees
          // one (16 -> 8 -> 4, the floor). The retry budget is three.
          return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
      }
      const file = url.split("/").slice(-2).join("/");
      if (file in docs) return new Response(docs[file]);
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const logs: string[] = [];
    const chunks = await collect({ ...opts, onProgress: (m) => logs.push(m) });
    expect(chunks[0]!.rows.map((r) => r.key)).toEqual(["RFC 1"]);
    expect(chunks[0]!.final).toBe(true);
    expect(logs.some((m) => m.includes("throttling: dataset fetch concurrency -> 8"))).toBe(true);
    expect(logs.some((m) => m.includes("-> 4"))).toBe(true);
  });

  it("fails loudly when the Pages site has no machine index", async () => {
    const opts = options({});
    opts.fetchImpl = (async () => new Response("no", { status: 404 })) as typeof fetch;
    await expect(collect(opts)).rejects.toThrow(/no machine index|HTTP 404/);
  });
});
