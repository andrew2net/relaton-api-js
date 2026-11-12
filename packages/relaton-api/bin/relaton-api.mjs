#!/usr/bin/env node
// relaton-api CLI: config-only deployments.
//   init   — scaffold relaton-api.yaml, worker entry, D1 migrations
//   check  — validate relaton-api.yaml and reachability of flavor indexes
//   deploy — generate worker/wrangler.jsonc from the config, apply D1
//            migrations, run `wrangler deploy`
//   ingest — mirror a flavor's Pages machine index into the API, or post
//            prebuilt ingest chunks (from the Ruby workflow) into D1

import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// D1 rejects chunks while its CPU window recovers ("DB is overloaded.
// Too many resources consumed within a 10 second window") and kills
// transactions that ran past its CPU cap ("exceeded its CPU time limit
// and was reset"). Both answer HTTP 500 with a D1_ERROR body; the
// window heals in tens of seconds to minutes, so the poster waits in
// minute steps instead of the 5-15s linear backoff that failed six
// corpus-class walks in a row (relaton-api-js#137 tracks the
// server-side chunk splitting this works around).
const D1_ERROR = /D1_ERROR/;
const D1_BACKOFF_MS = 60_000;
const D1_BACKOFF_MAX_MS = 600_000;
const D1_MAX_WAITING_ATTEMPTS = 30;

async function postJson(url, token, body, attempts = 4) {
  let d1Waits = 0;
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return await res.json().catch(() => ({}));
      const detail = (await res.text()).slice(0, 200);
      if (D1_ERROR.test(detail) && d1Waits < D1_MAX_WAITING_ATTEMPTS) {
        const wait = Math.min(D1_BACKOFF_MS * 2 ** d1Waits, D1_BACKOFF_MAX_MS);
        d1Waits += 1;
        i -= 1; // a D1 wait is not one of the ordinary attempts
        console.error(`  D1 throttle #${d1Waits}, waiting ${wait / 1000}s: ${detail}`);
        await sleep(wait);
        continue;
      }
      if (i >= attempts) throw new Error(`HTTP ${res.status}: ${detail}`);
      console.error(`  HTTP ${res.status}, attempt ${i}: ${detail}`);
    } catch (e) {
      if (D1_ERROR.test(String(e)) && d1Waits < D1_MAX_WAITING_ATTEMPTS) {
        const wait = Math.min(D1_BACKOFF_MS * 2 ** d1Waits, D1_BACKOFF_MAX_MS);
        d1Waits += 1;
        i -= 1;
        console.error(`  D1 throttle #${d1Waits}, waiting ${wait / 1000}s: ${String(e).slice(0, 120)}`);
        await sleep(wait);
        continue;
      }
      if (i >= attempts) throw e;
      console.error(`  ${String(e).slice(0, 200)}, attempt ${i}`);
    }
    await sleep(i * 5000);
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
      "dump-sql": { type: "string" },
      "data-clone": { type: "string" },
    },
  });
  if (!flavor) {
    console.error("usage: relaton-api ingest <flavor> [--v2] [--pages URL] [--base URL] [--token-env NAME]");
    process.exit(1);
  }
  // CI runs the CLI from a repo checkout with no relaton-api.yaml; the
  // explicit --base/--token-env flags carry everything then. Dump mode
  // needs neither: it writes SQL locally and never talks to the API.
  const config = existsSync("relaton-api.yaml") ? loadConfig() : {};
  if (values.v2 && values["dump-sql"]) return dumpSqlV2(flavor, values, values["dump-sql"]);
  const base = apiBase(config, values.base);
  const token = adminToken(config, values["token-env"]);

  if (values.v2) return ingestV2(flavor, values, base, token);
  return ingestMachineIndex(flavor, values.pages, base, token);
}

// SQLite literal rendering for the bulk import (relaton-api-js#137): the
// shared builder's binds inlined so `wrangler d1 execute --remote --file` executes the
// identical write shape the worker route would have.
function sqliteLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replaceAll("'", "''")}'`;
}

// Bulk mode: walk the machine index with the same producer (fetch throttle,
// fatal enumeration, resume support) but write the statements as SQLite
// literals instead of POSTing chunks - `wrangler d1 execute --remote --file` executes the
// file server-side with streaming batching, which is orders of magnitude
// cheaper per row than per-chunk D1 transactions. The reconcile statements
// ride a separate file so the workflow imports them only after a full wave.
async function dumpSqlV2(flavor, values, outDir) {
  const { produceV2Chunks } = await import("../src/ingest/produce.ts");
  const { buildIngestStatements, buildReconcileStatements, bulkTriggerDropStatements, bulkTriggerRestoreStatements } = await import("../src/lib/ingest_sql.ts");
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  const before = new Date().toISOString();

  // With --data-clone, dataset reads come off a local clone of the data
  // repo instead of raw.githubusercontent: an 80k-dataset walk over HTTP
  // is the remaining rate-limit exposure after the monolith index fix,
  // and the datasets are committed in the repo. Anything the clone lacks
  // (added after the clone, or never committed) still fetches over the
  // network, so clone staleness cannot fail the walk.
  let fetchImpl;
  if (values["data-clone"]) {
    const cloneDir = String(values["data-clone"]).replace(/\/+$/, "");
    const rawBase = `https://raw.githubusercontent.com/relaton/relaton-data-${flavor}/`;
    fetchImpl = (url) => {
      const s = String(url);
      if (!s.startsWith(rawBase)) return fetch(url);
      const rest = s.slice(rawBase.length);
      const slash = rest.indexOf("/");
      if (slash === -1) return fetch(url);
      try {
        const body = fs.readFileSync(`${cloneDir}/${rest.slice(slash + 1)}`, "utf8");
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
      } catch {
        return fetch(url);
      }
    };
  }

  const FILE_CAP = 40 * 1024 * 1024;
  let fileNo = 1;
  let fileBytes = 0;
  let out = fs.createWriteStream(`${outDir}/${flavor}.sql`);
  let chunks = 0;
  let rows = 0;
  const writeStmts = (stmts) => {
    for (const st of stmts) {
      // ingest statements use bare "?" in positional order; the reconcile
      // and final-chunk statements use numbered "?N" binds.
      const rendered = /\?\d/.test(st.sql)
        ? st.sql.replace(/\?(\d+)/g, (_, n) => sqliteLiteral(st.binds[Number(n) - 1]))
        : st.sql.replace(/\?/g, () => sqliteLiteral(st.binds.shift()));
      const text = rendered.endsWith(";") ? rendered : `${rendered};`;
      const buf = `${text}\n`;
      if (fileBytes + buf.length > FILE_CAP) {
        out.end();
        fileNo += 1;
        fileBytes = 0;
        out = fs.createWriteStream(`${outDir}/${flavor}-${fileNo}.sql`);
      }
      out.write(buf);
      fileBytes += buf.length;
    }
  };

  // FTS triggers off for the whole import (see bulkTriggerDropStatements):
  // their per-row FTS5 maintenance stalls the import stream by the tail of
  // a corpus-class file and wrangler silently drops the rest.
  writeStmts(bulkTriggerDropStatements());

  let failedChunk = 0;
  let failedCount = 0;
  for await (const chunk of produceV2Chunks({
    flavor,
    pagesBase: values.pages ?? `https://relaton.github.io/relaton-data-${flavor}`,
    repoBase: values["repo-base"],
    fetchImpl,
    chunkSize: values["chunk-size"] ? Number(values["chunk-size"]) : undefined,
    fromChunk: values["from-chunk"] ? Number(values["from-chunk"]) : 0,
    maxRows: values.limit ? Number(values.limit) : undefined,
    onProgress: (m) => console.log(`${flavor}: ${m}`),
  })) {
    chunks += 1;
    try {
      writeStmts(buildIngestStatements(chunk, before));
      rows += chunk.rows.length;
      console.log(`${flavor}: chunk ${chunks} dumped (rows=${chunk.rows.length})`);
    } catch (e) {
      failedChunk ||= chunks;
      failedCount += 1;
      console.error(`${flavor}: chunk ${chunks} FAILED (rows=${chunk.rows.length} not dumped): ${String(e).slice(0, 160)}`);
    }
  }
  out.end();
  await new Promise((resolve) => out.on("close", resolve));

  if (failedChunk) {
    console.error(`${flavor}: ${failedCount} chunk(s) failed (first: #${failedChunk}); dumped ${rows} rows. ` +
      `Resume with: ingest ${flavor} --v2 --dump-sql ${outDir} --from-chunk ${failedChunk - 1}`);
    process.exit(1);
  }
  if (rows === 0) {
    console.error(`${flavor}: dumped 0 rows — the index rows and the dataset files disagree`);
    process.exit(1);
  }
  // The reconcile for a full wave, as its own file: imported only after the
  // data files, it deletes the ghosts the refreshed index left behind,
  // restores the FTS triggers the dump dropped, and rebuilds the FTS
  // index wholesale from the content table.
  const rec = fs.createWriteStream(`${outDir}/${flavor}-reconcile.sql`);
  const recStmts = [
    ...buildReconcileStatements(flavor, before),
    ...bulkTriggerRestoreStatements(),
  ];
  for (const st of recStmts) {
    const rendered = /\?\d/.test(st.sql)
      ? st.sql.replace(/\?(\d+)/g, (_, n) => sqliteLiteral(st.binds[Number(n) - 1]))
      : st.sql.replace(/\?/g, () => sqliteLiteral(st.binds.shift()));
    rec.write(`${rendered.endsWith(";") ? rendered : `${rendered};`}\n`);
  }
  rec.end();
  await new Promise((resolve) => rec.on("close", resolve));

  console.log(`${flavor}: dumped ${rows} rows across ${chunks} chunks into ${outDir}/${flavor}.sql(-2,-3,…)`);
  console.log(`${flavor}: import with (numeric order — a glob sorts iso-10 before iso-2 and iso.sql last, which FK-fails):`);
  console.log(`  npx wrangler d1 execute api-relaton-org --remote --file=${outDir}/${flavor}.sql --yes`);
  console.log(`  i=2; while [ -f ${outDir}/${flavor}-$i.sql ]; do npx wrangler d1 execute api-relaton-org --remote --file=${outDir}/${flavor}-$i.sql --yes; i=$((i+1)); done`);
  console.log(`  npx wrangler d1 execute api-relaton-org --remote --file=${outDir}/${flavor}-reconcile.sql --yes`);
}

// Rows the wave never re-stamped are ghosts and get deleted (v2 store).
async function reconcile(flavor, base, token, before) {
  const res = await postJson(`${base}/admin/reconcile-v2/${flavor}`, token, JSON.stringify({ before }));
  console.log(`${flavor}: reconciled, deleted ${res.deleted} stale rows`);
}

// Run the storage v2 producer live: walk the machine index, post each
// chunk as it fills, reconcile once the wave completes.
async function ingestV2(flavor, values, base, token) {
  const { produceV2Chunks } = await import("../src/ingest/produce.ts");
  const before = new Date().toISOString();
  let index = 0;
  let posted = 0;
  // A chunk the poster cannot land (D1 CPU caps on a pathologically
  // heavy chunk after every throttle wait) must not kill the walk: the
  // rows after it are just as postable, and the failed chunk is
  // re-postable via --from-chunk. The leg still exits non-zero at the
  // end so the workflow's reconcile step is skipped - reconciling after
  // a partial wave would delete every row the failed chunk never
  // stamped (relaton-api-js#137).
  let failedChunk = 0;
  let failedCount = 0;
  for await (const chunk of produceV2Chunks({
    flavor,
    pagesBase: values.pages ?? `https://relaton.github.io/relaton-data-${flavor}`,
    repoBase: values["repo-base"],
    chunkSize: values["chunk-size"] ? Number(values["chunk-size"]) : undefined,
    fromChunk: values["from-chunk"] ? Number(values["from-chunk"]) : 0,
    maxRows: values.limit ? Number(values.limit) : undefined,
    onProgress: (m) => console.log(`${flavor}: ${m}`),
  })) {
    index += 1;
    try {
      await postJson(`${base}/admin/ingest-v2/${flavor}`, token, JSON.stringify(chunk));
      posted += chunk.rows.length;
      console.log(`${flavor}: chunk ${index} ok (rows=${chunk.rows.length})`);
    } catch (e) {
      failedChunk ||= index;
      failedCount += 1;
      console.error(`${flavor}: chunk ${index} FAILED (rows=${chunk.rows.length} not posted): ${String(e).slice(0, 160)}`);
    }
  }
  // A wave that ingests nothing is an index/data mismatch, not success —
  // fail loudly so the rollout notices (iana/calconnect taught us this).
  if (posted === 0) {
    console.error(`${flavor}: ingested 0 rows — the index rows and the dataset files disagree`);
    process.exit(1);
  }
  if (failedChunk) {
    console.error(
      `${flavor}: ${failedCount} chunk(s) failed (first: #${failedChunk}); posted ${posted} rows. The reconcile step is skipped. ` +
      `Resume with: ingest ${flavor} --v2 --from-chunk ${failedChunk - 1} ` +
      `(re-posts the failed chunk and everything after; add --chunk-size 50 if the same chunk fails again)`,
    );
    process.exit(1);
  }
  await reconcile(flavor, base, token, before);
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
  const migrationsSrc = fileURLToPath(new URL("../migrations/", import.meta.url));
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

export const __cli = { apiBase, adminToken, loadConfig, postJson, reconcile, ingestMachineIndex, ingestV2, resolveEnvValue };

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
