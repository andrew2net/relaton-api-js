// Storage v2 producer (TODO.api/02): walks a flavor's Pages machine index
// and turns each row's dataset document into a v2 ingest row — the model
// JSON as the dataset ships it, the row reference as the canonical key,
// and the normalized reference as the one lookup token. Keys are imported,
// never derived beyond the mechanical normKey form; XML blobs stay with
// the opt-in Ruby workflow.
import { load as loadYaml } from "js-yaml";
// Deep path: keys.ts is self-contained and extension-free, so this loads
// under plain node (the CLI's runtime) as well as under the bundler —
// pubid-ts's barrel imports its siblings without extensions.
import { normKey } from "../pubid/keys.ts";

// The pubid grammar engine needs a real filesystem at import time, so it is
// loaded lazily and only on the node-side ingest path (the CLI's runtime) —
// never inside the worker. It gives colliding rows their edition-bearing
// canonical key from the machine-index row's structured id (relaton-api-js#129).
type PubidImpl = {
  parse(ref: string): { render(): string; constructor: { fromHash(h: Record<string, unknown>): { render(): string } | null } | null } | null;
};
const engineCache = new Map<string, PubidImpl | null>();
async function flavorEngine(flavor: string): Promise<PubidImpl | null> {
  if (!engineCache.has(flavor)) {
    try {
      // Cast: the .d.ts lags the runtime - Identifier implements render()
      // (verified on 0.1.32) but the interface does not declare it yet.
      const mod = (await import("@pubid/pubid/dist/flavors/index.js")) as {
        grammarImplementation(flavor: string): PubidImpl | undefined;
      };
      engineCache.set(flavor, mod.grammarImplementation(flavor) ?? null);
    } catch (e) {
      // Under vitest the engine's package.json walk cannot resolve through
      // the module runner - tests inject a stub engine instead.
      console.log(`flavorEngine(${flavor}) unavailable: ${(e as Error).message}`);
      engineCache.set(flavor, null);
    }
  }
  return engineCache.get(flavor) ?? null;
}

// Canonical key from a machine-index row's structured id hash: the pubid
// model's own render of the identity, edition included. Unstripped-`:` keys
// (the hand-rendered monolith) are normalized first.
function stripColonKeys(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.startsWith(":") ? k.slice(1) : k;
    out[key] = v && typeof v === "object" && !Array.isArray(v)
      ? stripColonKeys(v as Record<string, unknown>)
      : v;
  }
  return out;
}

async function keyFromIdHash(impl: PubidImpl | null, hash: unknown, seedRef: string): Promise<string> {
  if (!impl || !hash || typeof hash !== "object" || !seedRef) return "";
  try {
    // The impl exposes parse/parseUrn; the identifier class carries fromHash.
    // Seeding parses the row's own printed form - the flavor's grammar reads
    // it by construction, and the class it yields dispatches fromHash on
    // _type across the family.
    const probe = impl.parse(seedRef);
    const ctor = probe?.constructor?.fromHash ? probe.constructor : null;
    if (!ctor) return "";
    const pub = ctor.fromHash(stripColonKeys(hash as Record<string, unknown>));
    if (!pub || typeof pub.render !== "function") return "";
    return pub.render();
  } catch {
    return "";
  }
}

export interface V2Chunk {
  flavor: string;
  repo: string;
  final?: boolean;
  lastModified?: string | null;
  rows: { key: string; file: string; data: Record<string, unknown>; keys: string[] }[];
  blobs: Record<string, string>;
}

export interface ProduceOptions {
  flavor: string;
  pagesBase: string;
  repoBase?: string;
  chunkSize?: number;
  fromChunk?: number;
  maxRows?: number;
  concurrency?: number;
  onProgress?: (message: string) => void;
  fetchImpl?: typeof fetch;
  /** Injected by tests: the real path resolves the flavor's engine lazily. */
  engine?: PubidImpl;
  /** Injected by tests: real-path backoff on 429/network errors. */
  retryDelaysMs?: number[];
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// The document's own primary docidentifier — the key source when the
// index row carries no reference string (the shards: 0 fallback).
function keyFromDoc(data: Record<string, unknown>): string {
  const raw = data.docidentifier ?? data.docid;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== "object") return "";
  const entry = first as { content?: unknown; id?: unknown };
  const text = typeof entry.content === "string" ? entry.content : typeof entry.id === "string" ? entry.id : "";
  return text.trim();
}

async function pull(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

// The dataset walk's shared fetch throttle. GitHub's raw host 429s a
// burst of parallel document fetches (the 2026-11-09 sweep lost the six
// heaviest flavors to it — rows were skipped mid-walk and the legs
// failed), so the walk observes 429s by halving the overlap and backing
// off before retrying: slow beats silently missing rows.
class FetchGate {
  #parallel: number;
  #active = 0;
  #queue: (() => void)[] = [];

  constructor(start: number) {
    this.#parallel = start;
  }

  async acquire(): Promise<void> {
    if (this.#active < this.#parallel) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active++;
  }

  release(): void {
    this.#active--;
    this.#queue.shift()?.();
  }

  throttle(log: (message: string) => void): void {
    const next = Math.max(4, Math.floor(this.#parallel / 2));
    if (next < this.#parallel) {
      this.#parallel = next;
      log(`throttling: dataset fetch concurrency -> ${next}`);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Dataset fetches run from CI runners whose egress IPs are shared fleet
// wide - raw.githubusercontent 429s them for minutes at a time when the
// fleet is busy, and the walk's own burst makes it worse. Three quick
// retries could not outlast that (the 2026-11-12 iso walk skipped every
// row past ~2,500): the default budget now reaches minute-scale waits.
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000, 60_000, 120_000, 300_000];

async function pullWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  gate: FetchGate,
  log: (message: string) => void,
  retryDelaysMs: number[],
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await gate.acquire();
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      gate.release();
      if (attempt >= retryDelaysMs.length) throw e;
      gate.throttle(log);
      const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!;
      log(`retrying in ${delay / 1000}s: ${String(e).slice(0, 80)}`);
      await sleep(delay);
      continue;
    }
    if (res.status === 429) {
      gate.release();
      if (attempt >= retryDelaysMs.length) throw new Error(`HTTP 429 for ${url} (persistent after backoff)`);
      gate.throttle(log);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!;
      log(`HTTP 429, backing off ${Math.round(wait / 1000)}s: ${url.split("/").pop()}`);
      await sleep(wait);
      continue;
    }
    gate.release();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  }
}

export async function* produceV2Chunks(opts: ProduceOptions): AsyncGenerator<V2Chunk> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pages = trimSlash(opts.pagesBase);
  // The dataset repos' default branch is not consistently main (the
  // relaton-data-* repos default to v2) — resolve it once per run via the
  // GitHub API, authenticated when GITHUB_TOKEN is around (CI), falling
  // back to main when the API is unreachable.
  const repoBase = opts.repoBase
    ?? await fetchImpl(`https://api.github.com/repos/relaton/relaton-data-${opts.flavor}`, {
      headers: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GITHUB_TOKEN
        ? { Authorization: `Bearer ${(globalThis as { process?: { env?: Record<string, string | undefined> } }).process!.env!.GITHUB_TOKEN}` } : {},
    })
      .then((r) => (r.ok ? r.json() as Promise<{ default_branch: string }> : null))
      .then((r) => `https://raw.githubusercontent.com/relaton/relaton-data-${opts.flavor}/${r?.default_branch ?? "main"}`)
      .catch(() => `https://raw.githubusercontent.com/relaton/relaton-data-${opts.flavor}/main`);
  const repo = trimSlash(repoBase);
  const chunkSize = opts.chunkSize ?? 100;
  // 40 parallel dataset fetches keeps a 175k-row walk inside the 6-hour
  // runner cap; the machine index can regenerate between runs, so a walk
  // must fit one run rather than rely on from_chunk resume.
  const concurrency = opts.concurrency ?? 40;
  const log = opts.onProgress ?? (() => {});
  const gate = new FetchGate(concurrency);
  const retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  let fromChunk = opts.fromChunk ?? 0;
  let remaining = opts.maxRows ?? Infinity;

  // The engine is injectable for tests; the real path resolves it lazily
  // (its import needs a real filesystem - never available in the worker).
  const engine = opts.engine ?? (await flavorEngine(opts.flavor));

  const manifest = await pull(fetchImpl, `${pages}/index/manifest.json`)
    .then((r) => r.json() as Promise<{ shards: number; index?: string; count?: number }>);
  if (!Number.isInteger(manifest.shards) || manifest.shards < 0) throw new Error("manifest has no shard count");
  log(`manifest ok, shards=${manifest.shards}`);

  const shardRows: { r: string; idHash?: Record<string, unknown>; file: string }[] = [];
  if (manifest.index) {
    // Monolith first whenever the manifest names one, even above the
    // sharding threshold: one fetch cannot trip the per-file burst limits
    // that a 16k-shard enumeration can (the 2026-11-12 iso walk lost
    // 1,434 of 16,384 shards to fleet rate limits at 300s backoffs while
    // this same monolith fetched fine). Shards remain the enumeration for
    // index generations that publish no monolith.
    const yaml = await pullWithRetry(fetchImpl, `${pages}/${manifest.index}.yaml`, gate, log, retryDelaysMs)
      .then((r) => r.text());
    for (const row of (loadYaml(yaml) as { ":file"?: string }[] | null) ?? []) {
      const mRow = row as { ":file"?: string; ":id"?: Record<string, unknown> };
      if (mRow[":file"]) shardRows.push({ r: "", idHash: mRow[":id"], file: mRow[":file"] });
    }
  } else if (manifest.shards > 0) {
    const PROBE = 24;
    // Shard enumeration goes through the same throttle/retry gate as the
    // datasets, and a shard that still will not load is FATAL: the manifest
    // promises it, so walking with a fraction of the index would silently
    // ingest a fraction of the flavor (the 2026-11-12 iso walk enumerated
    // 87k of 242k rows this way - 16k shard fetches at ~300/s dropped 64%
    // without a single log line - and posted its slice as if it were the
    // flavor).
    let unfetched = 0;
    for (let i = 0; i < manifest.shards; i += PROBE) {
      const names: string[] = [];
      for (let s = i; s < Math.min(i + PROBE, manifest.shards); s++) names.push(`shard-${String(s).padStart(5, "0")}.json`);
      const bodies = await Promise.all(
        names.map((n) =>
          pullWithRetry(fetchImpl, `${pages}/index/${n}`, gate, log, retryDelaysMs)
            .then((r) => r.json() as Promise<{ r: string; id?: Record<string, unknown>; file: string }[]>)
            .catch(() => null),
        ),
      );
      for (const rows of bodies)
        if (rows) shardRows.push(...rows.map((row) => ({ ...row, idHash: row.id })));
        else unfetched += 1;
    }
    if (unfetched > 0) {
      throw new Error(
        `machine index enumeration incomplete: ${unfetched} of ${manifest.shards} shards unfetchable after backoff`,
      );
    }
  } else if (!manifest.index) {
    throw new Error("manifest names neither an index artifact nor shards");
  }
  log(`${shardRows.length} index rows${manifest.index ? ` (from monolith ${manifest.index}.yaml)` : ""}`);

  // Completeness gate: the manifest's `count` is the index generation's own
  // row tally. A walk that enumerated materially fewer rows would ingest a
  // fraction of the flavor as if it were the whole - fail loudly instead
  // (the gate catches shard-fetch losses the per-shard fatal above cannot,
  // e.g. a shard file that loads but was truncated at the publisher).
  if (manifest.count && shardRows.length < manifest.count * 0.995) {
    throw new Error(
      `machine index enumeration incomplete: ${shardRows.length} of ${manifest.count} rows`,
    );
  }

  // Some datasets map several keys to one file (IANA sub-registries live
  // inside the registry document); the first key wins the document, the
  // rest skip until those data repos split their files.
  const seenFiles = new Set<string>();
  const seenKeys = new Map<string, string>();
  const deferred: { row: { r: string; idHash?: Record<string, unknown>; file: string }; data: Record<string, unknown> }[] = [];

  let chunk: V2Chunk | null = null;
  let completed = true;
  // Resume skips rows, not fetches: from_chunk counts chunks, and chunk N
  // is exactly rows [N*chunkSize, (N+1)*chunkSize) of the deterministic
  // walk, so every row before fromChunk*chunkSize is already in storage
  // and its dataset document does not need fetching at all. Re-fetching
  // the prefix was what made a resume of a corpus-class walk slower than
  // the original run and re-trip the rate limit on 80k pointless fetches
  // (relaton-api-js#137). Rows past the checkpoint keep the same chunk
  // numbering, so a resume lands the failed chunk and everything after.
  const skipRows = fromChunk * chunkSize;

  for (let start = 0; start < shardRows.length; start += concurrency) {
    const window = shardRows.slice(start, start + concurrency);
    const settled = await Promise.allSettled(
      window.map(async (row, offset) => {
        if (start + offset < skipRows) {
          return { row, data: null as Record<string, unknown> | null };
        }
        const yaml = await pullWithRetry(fetchImpl, `${repo}/${row.file}`, gate, log, retryDelaysMs)
          .then((r) => r.text());
        return { row, data: loadYaml(yaml) as Record<string, unknown> };
      }),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log(`skipped: ${String(outcome.reason).slice(0, 160)}`);
        continue;
      }
      const { row, data } = outcome.value;
      if (data === null) continue; // resumed-over row: already in storage
      if (remaining <= 0) break;
      remaining -= 1;
      if (seenFiles.has(row.file)) {
        log(`skipped duplicate file: ${row.file} (${row.r})`);
        continue;
      }
      seenFiles.add(row.file);
      const key = row.r || keyFromDoc(data);
      if (!key) {
        log(`skipped: no key derivable for ${row.file}`);
        continue;
      }
      // Editions of one document print the same docid, so their printed
      // keys collide; emitting both would trip doc_keys' (key, document)
      // primary key and silently collapse the editions besides
      // (relaton-api-js#129). Defer them: after the walk, the colliding
      // rows re-key from their structured id - edition included - via the
      // pubid engine. Non-colliding flavors keep the printed key exactly
      // as before.
      const nk = normKey(key);
      const owner = seenKeys.get(nk);
      if (owner !== undefined) {
        deferred.push({ row, data });
        log(`deferred: ${row.file} (printed key ${nk} collides with ${owner}; re-keys from its id)`);
        continue;
      }
      seenKeys.set(nk, row.file);
      if (!chunk || chunk.rows.length >= chunkSize) {
        if (chunk) yield chunk;
        chunk = { flavor: opts.flavor, repo: `relaton/relaton-data-${opts.flavor}`, rows: [], blobs: {} };
      }
      chunk.rows.push({ key, file: row.file, data, keys: [normKey(key)] });
    }
    if (remaining <= 0) {
      completed = false;
      break;
    }
  }

  // The deferred collision rows, re-keyed edition-bearing from their
  // structured ids. Their documents are already fetched; they ride the
  // same chunk machinery and inherit the final flag.
  for (const { row, data } of deferred) {
    const idKey = await keyFromIdHash(engine, row.idHash, row.r || keyFromDoc(data));
    if (!idKey) {
      log(`skipped: ${row.file} collided and carries no structured id to re-key from`);
      continue;
    }
    if (!chunk || chunk.rows.length >= chunkSize) {
      if (chunk) yield chunk;
      chunk = { flavor: opts.flavor, repo: `relaton/relaton-data-${opts.flavor}`, rows: [], blobs: {} };
    }
    log(`re-keyed: ${row.file} -> ${idKey}`);
    chunk.rows.push({ key: idKey, file: row.file, data, keys: [normKey(idKey)] });
  }

  if (chunk) {
    // A truncated run must not stamp `final`: the wave's ghost cleanup
    // would delete every row the truncation never reached.
    chunk.final = completed;
    yield chunk;
  }
}
