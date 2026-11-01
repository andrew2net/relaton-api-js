#!/usr/bin/env node
// relaton-api CLI: config-only deployments.
//   init   — scaffold relaton-api.yaml, worker entry, D1 migrations
//   check  — validate relaton-api.yaml and reachability of flavor indexes
//   deploy — generate worker/wrangler.jsonc from the config, apply D1
//            migrations, run `wrangler deploy`
//   ingest — mirror a flavor's Pages machine index into the API, or post
//            prebuilt ingest chunks (from the Ruby workflow) into D1

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const command = process.argv[2];

function usage() {
  console.log(`relaton-api — deploy a Relaton API from configuration

  relaton-api init [dir]        scaffold a deployment
  relaton-api check             validate relaton-api.yaml in the current dir
  relaton-api deploy [dir]      generate wrangler.jsonc, migrate D1, deploy the worker
  relaton-api ingest <flavor>   mirror the flavor's Pages machine index into the API
                                (--chunks DIR posts prebuilt ingest chunks instead)
`);
}

function loadConfig(dir = ".") {
  const file = join(resolve(dir), "relaton-api.yaml");
  if (!existsSync(file)) {
    console.error(`no relaton-api.yaml in ${resolve(dir)}`);
    process.exit(1);
  }
  return loadYaml(readFileSync(file, "utf8"));
}

function apiBase(config, override) {
  if (override) return override.replace(/\/+$/, "");
  const domain = config?.cloudflare?.domain;
  if (!domain) {
    console.error("no API base: set cloudflare.domain in relaton-api.yaml or pass --base");
    process.exit(1);
  }
  return `https://${domain}`;
}

function adminToken(config, envOverride) {
  const name = envOverride ?? config?.admin?.token_env ?? "RELATON_API_ADMIN_TOKEN";
  const token = process.env[name];
  if (!token) {
    console.error(`admin token missing: export ${name}`);
    process.exit(1);
  }
  return token;
}

function resolveEnvValue(value) {
  if (typeof value !== "string") return value;
  const m = value.match(/^env:(.+)$/);
  return m ? process.env[m[1]] : value;
}

async function postJson(url, token, body, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return await res.json().catch(() => ({}));
      const detail = (await res.text()).slice(0, 200);
      if (i >= attempts) throw new Error(`HTTP ${res.status}: ${detail}`);
      console.error(`  HTTP ${res.status}, attempt ${i}: ${detail}`);
    } catch (e) {
      if (i >= attempts) throw e;
      console.error(`  ${String(e).slice(0, 200)}, attempt ${i}`);
    }
    await new Promise((r) => setTimeout(r, i * 5000));
  }
}

// --- ingest -----------------------------------------------------------

async function ingest(...argv) {
  const [flavor] = argv;
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      chunks: { type: "string" },
      v2: { type: "boolean" },
      pages: { type: "string" },
      "repo-base": { type: "string" },
      "from-chunk": { type: "string" },
      limit: { type: "string" },
      "chunk-size": { type: "string" },
      base: { type: "string" },
      "token-env": { type: "string" },
    },
  });
  if (!flavor) {
    console.error("usage: relaton-api ingest <flavor> [--v2] [--chunks DIR] [--pages URL] [--base URL] [--token-env NAME]");
    process.exit(1);
  }
  const config = loadConfig();
  const base = apiBase(config, values.base);
  const token = adminToken(config, values["token-env"]);

  if (values.chunks) {
    const dir = values.chunks;
    const names = readdirSync(dir).filter((f) => /^chunk-.*\.json$/.test(f)).sort();
    if (!names.length) {
      console.error(`no chunk-*.json files in ${dir}`);
      process.exit(1);
    }
    const endpoint = values.v2 ? "ingest-v2" : "ingest";
    const files = names.map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }));
    return postChunks(flavor, files, `${base}/admin/${endpoint}`, token)
      .then((before) => reconcile(flavor, base, values.v2, token, before));
  }
  if (values.v2) return ingestV2(flavor, values, base, token);
  return ingestMachineIndex(flavor, values.pages, base, token);
}

// Post the chunk files (Ruby workflow output for v1, producer output for
// v2), then reconcile: rows the wave never re-stamped are ghosts and get
// deleted. Returns the wave start so reconcile can be issued separately.
async function postChunks(flavor, files, url, token, { attempts = 4 } = {}) {
  const before = new Date().toISOString();
  const failed = [];
  for (const { name, body } of files) {
    process.stdout.write(`${name}: posting…`);
    try {
      const res = await postJson(url, token, body, attempts);
      console.log(` ok (rows=${res.rows}, blobs=${res.blobs})`);
    } catch (e) {
      console.log(` FAILED: ${String(e).slice(0, 200)}`);
      failed.push(name);
    }
  }
  if (failed.length) {
    console.error(`${flavor}: ${failed.length} chunk(s) failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  return before;
}

async function reconcile(flavor, base, v2, token, before) {
  const endpoint = v2 ? "reconcile-v2" : "reconcile";
  const res = await postJson(`${base}/admin/${endpoint}/${flavor}`, token, JSON.stringify({ before }));
  console.log(`${flavor}: reconciled, deleted ${res.deleted} stale rows`);
}

// Run the storage v2 producer live: walk the machine index, post each
// chunk as it fills, reconcile once the wave completes.
async function ingestV2(flavor, values, base, token) {
  const { produceV2Chunks } = await import("../src/ingest/produce.ts");
  const before = new Date().toISOString();
  let index = 0;
  for await (const chunk of produceV2Chunks({
    flavor,
    pagesBase: values.pages ?? `https://relaton.github.io/relaton-data-${flavor}`,
    repoBase: values["repo-base"],
    chunkSize: values["chunk-size"] ? Number(values["chunk-size"]) : undefined,
    fromChunk: values["from-chunk"] ? Number(values["from-chunk"]) : 0,
    maxRows: values.limit ? Number(values.limit) : undefined,
    onProgress: (m) => console.log(`${flavor}: ${m}`),
  })) {
    await postJson(`${base}/admin/ingest-v2/${flavor}`, token, JSON.stringify(chunk));
    index += 1;
    console.log(`${flavor}: chunk ${index} ok (rows=${chunk.rows.length})`);
  }
  await reconcile(flavor, base, true, token, before);
}

// Mirror the Pages machine index byte-for-byte: manifest + every shard that
// answers, batched 64 per request (~2 MB, inside the Workers body limit).
async function ingestMachineIndex(flavor, pagesBase, base, token) {
  const pages = (pagesBase ?? `https://relaton.github.io/relaton-data-${flavor}`).replace(/\/+$/, "");

  const manifest = await fetch(`${pages}/index/manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`no Pages machine index at ${pages} (HTTP ${r.status})`);
    return r.arrayBuffer();
  });
  const { shards } = JSON.parse(Buffer.from(manifest).toString("utf8"));
  if (!Number.isInteger(shards) || shards <= 0) throw new Error("manifest has no shard count");
  console.log(`${flavor}: manifest ok, shards=${shards}`);

  const files = [{ name: "manifest.json", body: Buffer.from(manifest).toString("base64") }];
  const BATCH_PROBE = 24;
  for (let i = 0; i < shards; i += BATCH_PROBE) {
    const names = [];
    for (let s = i; s < Math.min(i + BATCH_PROBE, shards); s++) names.push(`shard-${String(s).padStart(5, "0")}.json`);
    const bodies = await Promise.all(
      names.map((n) => fetch(`${pages}/index/${n}`).then((r) => (r.ok ? r.arrayBuffer() : null))),
    );
    names.forEach((n, j) => {
      if (bodies[j]) files.push({ name: n, body: Buffer.from(bodies[j]).toString("base64") });
    });
  }
  console.log(`${flavor}: ${files.length} files fetched (${files.length - 1} of ${shards} shards present)`);

  const BATCH_POST = 64;
  for (let i = 0; i < files.length; i += BATCH_POST) {
    const batch = files.slice(i, i + BATCH_POST);
    await postJson(`${base}/admin/ingest/${flavor}/machine-index`, token, JSON.stringify({ files: batch }));
    process.stdout.write(`\r${flavor}: ${Math.min(i + BATCH_POST, files.length)}/${files.length} files posted`);
  }
  process.stdout.write("\n");
  console.log(`${flavor}: machine index mirrored`);
}

// --- deploy -----------------------------------------------------------

export function buildWranglerConfig(config, { apiVersion = "3.0.0" } = {}) {
  const accountId = resolveEnvValue(config?.cloudflare?.account_id);
  const domain = config?.cloudflare?.domain;
  const databaseId = resolveEnvValue(config?.cloudflare?.database_id);
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: config.name,
    main: "src/index.ts",
    compatibility_date: "2026-07-01",
    ...(accountId ? { account_id: accountId } : {}),
    workers_dev: true,
    ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : {}),
    vars: {
      API_VERSION: apiVersion,
      API_CONFIG: JSON.stringify({ name: config.name, cache: config.cache ?? { edge: true } }),
    },
    d1_databases: [{
      binding: "DB",
      database_name: config.name,
      ...(databaseId ? { database_id: databaseId } : {}),
    }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: `${config.name}-data` }],
    observability: { enabled: true },
    triggers: { crons: ["0 */6 * * *"] },
  };
}

async function runWrangler(args, cwd) {
  // Lazy: the workerd test pool has no child_process, and only a real
  // deploy ever spawns wrangler.
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("npx", ["wrangler", ...args], { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`wrangler ${args.join(" ")} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

async function deploy(...argv) {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean" } },
  });
  const dir = argv.find((a) => !a.startsWith("-")) ?? ".";
  const config = loadConfig(dir);
  if (!config.name) {
    console.error("config: name is required");
    process.exit(1);
  }
  const workerDir = join(resolve(dir), "worker");
  const wrangler = buildWranglerConfig(config);
  if (values["dry-run"]) {
    console.log(JSON.stringify(wrangler, null, 2));
    return;
  }
  writeFileSync(join(workerDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`);
  console.log(`wrote: ${join(workerDir, "wrangler.jsonc")}`);

  const migrations = join(resolve(dir), "migrations");
  if (existsSync(migrations)) {
    await runWrangler(["d1", "migrations", "apply", config.name, "--remote"], workerDir);
  } else {
    console.log("no migrations dir, skipping d1 migrations");
  }
  await runWrangler(["deploy"], workerDir);
}

// --- init / check -----------------------------------------------------

function scaffold(dir = ".") {
  mkdirSync(dir, { recursive: true });
  const files = {
    "relaton-api.yaml": `name: my-relaton-api
cloudflare:
  account_id: env:CF_ACCOUNT_ID
  zone: example.org
  domain: api.example.org
cache: { edge: true }
flavors:
  - id: ietf
    index: https://github.com/relaton/relaton-data-ietf/raw/main/index.zip
admin:
  token_env: RELATON_API_ADMIN_TOKEN
`,
    "worker/src/index.ts": `import { createRelatonApi, runIngestion } from "@relaton/api";
import type { Env } from "@relaton/api";

const { app } = createRelatonApi({ name: "my-relaton-api" });

export default {
  fetch: app.fetch,
  scheduled(controller, env: Env, ctx) {
    ctx.waitUntil(runIngestion(env));
  },
} satisfies ExportedHandler<Env>;
`,
  };
  for (const [path, content] of Object.entries(files)) {
    const target = `${dir}/${path}`;
    if (existsSync(target)) {
      console.log(`exists, skipped: ${target}`);
      continue;
    }
    mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    writeFileSync(target, content);
    console.log(`wrote: ${target}`);
  }

  // Deployments apply their own copy of the D1 migrations; the source only
  // exists inside this workspace, so a scaffold elsewhere ships without.
  const migrationsSrc = fileURLToPath(new URL("../../../migrations/", import.meta.url));
  if (existsSync(migrationsSrc)) {
    cpSync(migrationsSrc, join(resolve(dir), "migrations"), { recursive: true });
    console.log(`wrote: ${join(resolve(dir), "migrations")}/`);
  }

  console.log("\nNext: fill in relaton-api.yaml, then `relaton-api check`, `relaton-api deploy`,");
  console.log("and `relaton-api ingest <flavor>` per flavor.");
}

async function check() {
  if (!existsSync("relaton-api.yaml")) {
    console.error("no relaton-api.yaml in the current directory");
    process.exit(1);
  }
  const config = loadYaml(readFileSync("relaton-api.yaml", "utf8"));
  const problems = [];
  if (!config.name) problems.push("name is required");
  if (!Array.isArray(config.flavors) || !config.flavors.length) {
    problems.push("at least one flavor with an index URL is required");
  }
  for (const f of config.flavors ?? []) {
    if (!f.id) problems.push("flavor missing id");
    if (!f.index) problems.push(`flavor ${f.id}: index URL missing`);
  }
  for (const p of problems) console.error(`config: ${p}`);

  for (const f of config.flavors ?? []) {
    if (!f.index) continue;
    try {
      const res = await fetch(f.index, { method: "HEAD" });
      console.log(`${f.id}: index ${res.status === 200 ? "reachable" : `HTTP ${res.status}`}`);
      if (res.status >= 400) problems.push(`flavor ${f.id}: index not reachable`);
    } catch (e) {
      problems.push(`flavor ${f.id}: ${String(e)}`);
      console.error(`${f.id}: unreachable — ${String(e)}`);
    }
  }
  if (problems.length) process.exit(1);
  console.log("config OK");
}

const commands = { init: scaffold, check, deploy, ingest, "": usage };

export const __cli = { apiBase, adminToken, loadConfig, postJson, postChunks, reconcile, ingestMachineIndex, ingestV2, resolveEnvValue };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fn = commands[command ?? ""];
  if (!fn) {
    usage();
    process.exit(1);
  }
  Promise.resolve(fn(...process.argv.slice(3))).catch((e) => {
    console.error(String(e?.cause ?? e));
    process.exit(1);
  });
}
