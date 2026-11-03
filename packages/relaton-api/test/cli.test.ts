import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWranglerConfig, __cli } from "../bin/relaton-api.mjs";

// The CLI runs in Node, not in the workerd pool this suite boots; only its
// process handle and Buffer are touched here.
declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
declare const Buffer: {
  from(input: string): { toString(encoding: string): string };
};

const { ingestMachineIndex, apiBase, adminToken, reconcile } = __cli;

const b64 = (s: string) => Buffer.from(s).toString("base64");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildWranglerConfig", () => {
  it("generates bindings, vars and a custom-domain route from the config", () => {
    process.env.CF_ACCOUNT_ID = "acct-123";
    const cfg = buildWranglerConfig({
      name: "my-sdo-api",
      cloudflare: {
        account_id: "env:CF_ACCOUNT_ID",
        zone: "example-sdo.org",
        domain: "api.example-sdo.org",
        database_id: "d1-uuid",
      },
      cache: { edge: true },
    });

    expect(cfg.name).toBe("my-sdo-api");
    expect(cfg.main).toBe("src/index.ts");
    expect(cfg.account_id).toBe("acct-123");
    expect(cfg.routes).toEqual([{ pattern: "api.example-sdo.org", custom_domain: true }]);
    expect(cfg.d1_databases).toEqual([
      { binding: "DB", database_name: "my-sdo-api", database_id: "d1-uuid" },
    ]);
    expect(cfg.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "my-sdo-api-data" }]);
    const vars = JSON.parse(cfg.vars.API_CONFIG);
    expect(vars).toEqual({ name: "my-sdo-api", cache: { edge: true } });
    expect(cfg.triggers.crons).toEqual(["0 */6 * * *"]);
    delete process.env.CF_ACCOUNT_ID;
  });

  it("omits account/route/database pieces the config does not state", () => {
    const cfg = buildWranglerConfig({ name: "x" });
    expect(cfg.account_id).toBeUndefined();
    expect(cfg.routes).toBeUndefined();
    expect(cfg.d1_databases[0]).not.toHaveProperty("database_id");
    expect(JSON.parse(cfg.vars.API_CONFIG).cache).toEqual({ edge: true });
  });
});

describe("ingest: machine-index mirror", () => {
  it("mirrors the manifest and the shards that answer, batched per request", async () => {
    const manifest = JSON.stringify({ version: 2, shards: 3, count: 2 });
    const shard = JSON.stringify([{ r: "RFC 8446", file: "rfc8446.yaml", id: {} }]);
    const posts: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("shard-00001.json")) return new Response("nope", { status: 404 });
      if (url.includes("/index/")) {
        const name = url.split("/").pop()!;
        return new Response(name === "manifest.json" ? manifest : shard);
      }
      posts.push({ url, init });
      return jsonResponse({ ok: true, files: JSON.parse(String(init?.body)).files.length });
    }));

    await ingestMachineIndex("rfcs", "https://pages.example/rfcs/", "https://api.example.org", "tok");

    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]!.init!.body));
    expect(posts[0]!.url).toBe("https://api.example.org/admin/ingest/rfcs/machine-index");
    expect(posts[0]!.init!.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(body.files.map((f: { name: string }) => f.name)).toEqual([
      "manifest.json", "shard-00000.json", "shard-00002.json",
    ]);
    expect(body.files[0].body).toBe(b64(manifest));
    expect(body.files[1].body).toBe(b64(shard));
  });

  it("fails loudly when the Pages site has no machine index", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    await expect(
      ingestMachineIndex("rfcs", "https://pages.example/rfcs", "https://api.example.org", "tok"),
    ).rejects.toThrow(/no Pages machine index/);
  });
});

describe("config helpers", () => {
  it("apiBase prefers the override and strips trailing slashes", () => {
    expect(apiBase({ cloudflare: { domain: "api.example.org" } }, "http://localhost:8787/"))
      .toBe("http://localhost:8787");
    expect(apiBase({ cloudflare: { domain: "api.example.org" } })).toBe("https://api.example.org");
  });

  it("adminToken reads the configured env name", () => {
    process.env.MY_TOKEN = "sekrit";
    expect(adminToken({ admin: { token_env: "MY_TOKEN" } })).toBe("sekrit");
    expect(adminToken({}, "MY_TOKEN")).toBe("sekrit");
    delete process.env.MY_TOKEN;
  });
});
