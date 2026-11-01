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
import { normKey } from "pubid-ts/src/keys.ts";

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
  let fromChunk = opts.fromChunk ?? 0;
  let remaining = opts.maxRows ?? Infinity;

  const manifest = await pull(fetchImpl, `${pages}/index/manifest.json`)
    .then((r) => r.json() as Promise<{ shards: number; index?: string }>);
  if (!Number.isInteger(manifest.shards) || manifest.shards < 0) throw new Error("manifest has no shard count");
  log(`manifest ok, shards=${manifest.shards}`);

  const shardRows: { r: string; file: string }[] = [];
  if (manifest.shards > 0) {
    const PROBE = 24;
    for (let i = 0; i < manifest.shards; i += PROBE) {
      const names: string[] = [];
      for (let s = i; s < Math.min(i + PROBE, manifest.shards); s++) names.push(`shard-${String(s).padStart(5, "0")}.json`);
      const bodies = await Promise.all(
        names.map((n) => fetchImpl(`${pages}/index/${n}`).then((r) => (r.ok ? (r.json() as Promise<{ r: string; file: string }[]>) : null))),
      );
      for (const rows of bodies) if (rows) shardRows.push(...rows);
    }
  } else {
    // Below the sharding threshold the contract publishes no shard files —
    // only the monolith, named by the manifest's `index` field.
    if (!manifest.index) throw new Error("manifest has shards: 0 but names no index artifact");
    const yaml = await pull(fetchImpl, `${pages}/${manifest.index}.yaml`).then((r) => r.text());
    for (const row of (loadYaml(yaml) as { ":file"?: string }[] | null) ?? []) {
      if (row[":file"]) shardRows.push({ r: "", file: row[":file"] });
    }
  }
  log(`${shardRows.length} index rows${manifest.shards === 0 ? ` (from ${manifest.index}.yaml — below the sharding threshold)` : ""}`);

  // Some datasets map several keys to one file (IANA sub-registries live
  // inside the registry document); the first key wins the document, the
  // rest skip until those data repos split their files.
  const seenFiles = new Set<string>();

  let chunk: V2Chunk | null = null;
  let index = 0;
  let completed = true;
  const dropForResume = (): boolean => {
    // Chunks before fromChunk still cost their dataset fetches; drain them
    // without emitting.
    if (index < fromChunk) {
      index += 1;
      return true;
    }
    return false;
  };

  for (let start = 0; start < shardRows.length; start += concurrency) {
    const window = shardRows.slice(start, start + concurrency);
    const settled = await Promise.allSettled(
      window.map(async (row) => {
        const yaml = await pull(fetchImpl, `${repo}/${row.file}`).then((r) => r.text());
        return { row, data: loadYaml(yaml) as Record<string, unknown> };
      }),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log(`skipped: ${String(outcome.reason).slice(0, 160)}`);
        continue;
      }
      if (remaining <= 0) break;
      remaining -= 1;
      const { row, data } = outcome.value;
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
      if (!chunk || chunk.rows.length >= chunkSize) {
        if (chunk && !dropForResume()) yield chunk;
        chunk = { flavor: opts.flavor, repo: `relaton/relaton-data-${opts.flavor}`, rows: [], blobs: {} };
      }
      chunk.rows.push({ key, file: row.file, data, keys: [normKey(key)] });
    }
    if (remaining <= 0) {
      completed = false;
      break;
    }
  }

  if (chunk) {
    // A truncated run must not stamp `final`: the wave's ghost cleanup
    // would delete every row the truncation never reached.
    chunk.final = completed;
    if (!dropForResume()) yield chunk;
  }
}
