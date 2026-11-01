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

  it("falls back to index-v2.yaml when the manifest publishes no shards", async () => {
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
      if (url.endsWith("manifest.json")) return new Response(JSON.stringify({ version: 2, shards: 0, count: 2 }));
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

  it("does not stamp final when maxRows truncates the wave", async () => {
    const chunks = await collect(options({ chunkSize: 1, maxRows: 1 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.final).toBe(false);
  });

  it("fails loudly when the Pages site has no machine index", async () => {
    const opts = options({});
    opts.fetchImpl = (async () => new Response("no", { status: 404 })) as typeof fetch;
    await expect(collect(opts)).rejects.toThrow(/no machine index|HTTP 404/);
  });
});
