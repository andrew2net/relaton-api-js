import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  deriveSearchRow,
  projectClassifications,
  projectContributors,
  projectDates,
  projectIdentifiers,
  projectRelations,
  projectTitles,
} from "../lib/storage2";


function fixedTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return fixedTimeEqual(new TextEncoder().encode(header.slice(7)), new TextEncoder().encode(token));
}

export const adminRoutes = new Hono<AppEnv>();

interface MachineIndexFile {
  name: string;
  body: string; // base64 of the exact producer bytes
}

interface MachineIndexUpload {
  files: MachineIndexFile[];
}

// The Pages machine-index shard names and the manifest, nothing else:
// these objects are served byte-for-byte to relaton ShardSource clients.
const MACHINE_INDEX_NAME_RX = /^(manifest\.json|shard-\d{5}\.json)$/;
const MACHINE_INDEX_BATCH = 64;

/**
 * Mirrors a flavor's published machine index (`index/manifest.json` +
 * `index/shard-NNNNN.json`) into R2 under `index/<flavor>/`, from where
 * the public machine-index routes serve it byte-for-byte. Files arrive
 * base64 so the producer bytes are never re-encoded; ETags come from the
 * stored objects, so If-None-Match revalidation matches the content.
 */
adminRoutes.post("/admin/ingest/:flavor/machine-index", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  if (!flavor) return c.text("Invalid flavor.", 400);

  const upload = await c.req.json<MachineIndexUpload>().catch(() => null);
  if (!upload || !Array.isArray(upload.files) || upload.files.length === 0) {
    return c.text("Expected { files: [{ name, body }] } with at least one file.", 400);
  }
  for (const f of upload.files) {
    if (!MACHINE_INDEX_NAME_RX.test(f.name) || typeof f.body !== "string") {
      return c.text(`Invalid machine-index file name: ${f.name}`, 400);
    }
  }

  let written = 0;
  for (let i = 0; i < upload.files.length; i += MACHINE_INDEX_BATCH) {
    await Promise.all(
      upload.files.slice(i, i + MACHINE_INDEX_BATCH).map((f) => {
        const bytes = Uint8Array.from(atob(f.body), (ch) => ch.charCodeAt(0));
        return c.env.BUCKET.put(`index/${flavor}/${f.name}`, bytes, {
          httpMetadata: { contentType: "application/json" },
        });
      }),
    );
    written += Math.min(MACHINE_INDEX_BATCH, upload.files.length - i);
  }
  return c.json({ ok: true, files: written });
});

// Storage v2 ingest (TODO.api/02): rows carry the lossless model JSON and
// the dataset-provided lookup keys; the projection tables are rebuilt
// mechanically from `data` here, so a schema projection change never needs
// a producer change — re-post the same chunks.
interface IngestV2Row {
  key: string;
  file: string;
  data: Record<string, unknown>;
  keys: string[];
}

interface IngestV2Chunk {
  flavor: string;
  repo: string;
  final?: boolean;
  lastModified?: string | null;
  relatonVersion?: string;
  rows: IngestV2Row[];
  blobs: Record<string, string>;
}

adminRoutes.post("/admin/ingest-v2/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }

  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const chunk = await c.req.json<IngestV2Chunk>();
  if (chunk.flavor !== flavor) return c.text("Flavor mismatch.", 400);

  const ingestedAt = new Date().toISOString();

  // The ingest writes batched: one multi-row upsert per ~90 binds, one
  // chunk-wide projection delete, one multi-row insert per projection —
  // ~50 statements for a 100-row chunk instead of ~2,500 per-row ones, so
  // a heavy flavor's walk fits the runner cap instead of D1 round-trips.
  const BIND_CAP = 90;

  function insertStatements(table: string, columns: string[], tuples: unknown[][]): D1PreparedStatement[] {
    if (!tuples.length) return [];
    const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
    const rowSql = `(${columns.map(() => "?").join(", ")})`;
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < tuples.length; i += perStmt) {
      const group = tuples.slice(i, i + perStmt);
      out.push(
        c.env.DB.prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}`,
        ).bind(...group.flat()),
      );
    }
    return out;
  }

  function deleteByDocuments(table: string, keys: string[]): D1PreparedStatement[] {
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < keys.length; i += BIND_CAP) {
      const group = keys.slice(i, i + BIND_CAP);
      out.push(
        c.env.DB.prepare(`DELETE FROM ${table} WHERE document IN (${group.map((_, j) => `?${j + 1}`).join(", ")})`)
          .bind(...group),
      );
    }
    return out;
  }

  // Multi-row upsert by a primary key; `hold` columns are written on
  // insert but never clobbered by an update (embedded_at is the embed
  // cursor, not a projection of data).
  function upsertStatements(table: string, columns: string[], pk: string, hold: string[], tuples: unknown[][]): D1PreparedStatement[] {
    if (!tuples.length) return [];
    const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
    const rowSql = `(${columns.map(() => "?").join(", ")})`;
    const updateSet = columns.filter((col) => col !== pk && !hold.includes(col))
      .map((col) => `${col} = excluded.${col}`).join(", ");
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < tuples.length; i += perStmt) {
      const group = tuples.slice(i, i + perStmt);
      out.push(
        c.env.DB.prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (${pk}) DO UPDATE SET ${updateSet}`,
        ).bind(...group.flat()),
      );
    }
    return out;
  }

  const chunkKeys = chunk.rows.map((r) => r.key);
  const stmts: D1PreparedStatement[] = [];

  // Multi-row upsert: SQLite applies VALUES rows sequentially, so a key
  // repeated within one statement (the producer dedupes, but be safe)
  // updates cleanly.
  {
    const columns = ["key", "flavor", "file", "data", "indexed_at"];
    const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
    const rowSql = `(${columns.map(() => "?").join(", ")})`;
    for (let i = 0; i < chunk.rows.length; i += perStmt) {
      const group = chunk.rows.slice(i, i + perStmt);
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO documents_v2 (key, flavor, file, data, indexed_at)
           VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (key) DO UPDATE SET
             flavor = excluded.flavor, file = excluded.file, data = excluded.data,
             indexed_at = excluded.indexed_at`,
        ).bind(...group.flatMap((r) => [r.key, flavor, r.file, JSON.stringify(r.data), ingestedAt])),
      );
    }
  }

  // The query-side projection (migration 0009): derived mechanically from
  // the same data, so the search/collections surfaces read one source of
  // truth. FTS rows ride the table's triggers.
  stmts.push(...upsertStatements(
    "documents_search",
    ["key", "flavor", "file", "docid", "title", "year", "doctype", "status", "abstract",
      "norm", "undated_norm", "allparts_norm", "publisher", "number", "part", "edition"],
    "key",
    ["embedded_at", "publisher", "number", "part"],
    chunk.rows.map((r) => {
      const s = deriveSearchRow(r.key, flavor, r.file, r.data);
      return [s.key, s.flavor, s.file, s.docid, s.title, s.year, s.doctype, s.status, s.abstract,
        s.norm, s.undated_norm, s.allparts_norm, s.publisher, s.number, s.part, s.edition];
    }),
  ));

  stmts.push(...deleteByDocuments("doc_keys", chunkKeys));
  stmts.push(...insertStatements(
    "doc_keys",
    ["key", "document"],
    chunk.rows.flatMap((r) => r.keys.map((k) => [k, r.key])),
  ));

  const projected: [string, string[], unknown[][]][] = [
    ["titles", ["document", "lang", "type", "text"],
      chunk.rows.flatMap((r) => projectTitles(r.data).map((t) => [r.key, t.lang, t.type, t.text]))],
    ["identifiers", ["document", "raw", "type", "is_primary"],
      chunk.rows.flatMap((r) => projectIdentifiers(r.data).map((i) => [r.key, i.raw, i.type, i.isPrimary]))],
    ["dates", ["document", "type", "on_date"],
      chunk.rows.flatMap((r) => projectDates(r.data).map((d) => [r.key, d.type, d.onDate]))],
    ["contributors", ["document", "role", "name", "org_abbrev"],
      chunk.rows.flatMap((r) => projectContributors(r.data).map((p) => [r.key, p.role, p.name, p.orgAbbrev]))],
    ["relations", ["document", "type", "target"],
      chunk.rows.flatMap((r) => projectRelations(r.data).map((r2) => [r.key, r2.type, r2.target]))],
    ["classifications", ["document", "type", "value"],
      chunk.rows.flatMap((r) => projectClassifications(r.data).map((cl) => [r.key, cl.type, cl.value]))],
  ];
  for (const [table, columns, tuples] of projected) {
    stmts.push(...deleteByDocuments(table, chunkKeys));
    stmts.push(...insertStatements(table, columns, tuples));
  }

  if (chunk.final) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO flavors_v2 (flavor, repo, last_modified, indexed_at, doc_count)
         VALUES (?1, ?2, ?3, ?4, (SELECT COUNT(*) FROM documents_v2 WHERE flavor = ?1))
         ON CONFLICT (flavor) DO UPDATE SET
           repo = excluded.repo, last_modified = excluded.last_modified,
           indexed_at = excluded.indexed_at, doc_count = excluded.doc_count`,
      ).bind(flavor, chunk.repo, chunk.lastModified ?? null, ingestedAt),
    );
    if (chunk.relatonVersion) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO meta (key, value) VALUES ('relaton_version', ?1)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        ).bind(chunk.relatonVersion),
      );
    }
  }

  try {
    for (let i = 0; i < stmts.length; i += 90) {
      await c.env.DB.batch(stmts.slice(i, i + 90));
    }
  } catch (e) {
    console.error(`ingest-v2 batch failed for flavor ${flavor}: ${String(e)}`);
    return c.text(`Ingest failed: ${String(e)}`, 500);
  }

  await putBlobs(c.env.BUCKET, chunk.blobs);

  return c.json({ ok: true, rows: chunk.rows.length, blobs: Object.keys(chunk.blobs).length });
});

// Query-projection backfill (migration 0009): walks documents_v2 in key
// order and rebuilds documents_search rows from the stored JSON — the
// same derivation the ingest uses, so existing production data needs no
// re-crawl. Paged: pass ?cursor= (last key) to continue.
adminRoutes.post("/admin/build-search", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const limit = Math.min(500, Number(c.req.query("limit") ?? "300") || 300);
  const cursor = c.req.query("cursor") ?? "";

  const { results } = await c.env.DB.prepare(
    `SELECT key, flavor, file, data FROM documents_v2 WHERE key > ?1 ORDER BY key LIMIT ?2`,
  ).bind(cursor, limit).all<{ key: string; flavor: string; file: string; data: string }>();

  const rows = (results ?? []).map((r) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      // A corrupt row is skipped, not fatal to the walk.
    }
    return { key: r.key, flavor: r.flavor, file: r.file, data };
  });

  const BIND_CAP = 90;
  const columns = ["key", "flavor", "file", "docid", "title", "year", "doctype", "status", "abstract",
    "norm", "undated_norm", "allparts_norm", "publisher", "number", "part", "edition"];
  const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
  const rowSql = `(${columns.map(() => "?").join(", ")})`;
  const updateSet = columns.filter((col) => col !== "key" && col !== "embedded_at" && col !== "publisher" && col !== "number" && col !== "part")
    .map((col) => `${col} = excluded.${col}`).join(", ");
  const stmts: D1PreparedStatement[] = [];
  const tuples = rows.map((r) => {
    const s = deriveSearchRow(r.key, r.flavor, r.file, r.data);
    return [s.key, s.flavor, s.file, s.docid, s.title, s.year, s.doctype, s.status, s.abstract,
      s.norm, s.undated_norm, s.allparts_norm, s.publisher, s.number, s.part, s.edition];
  });
  for (let i = 0; i < tuples.length; i += perStmt) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO documents_search (${columns.join(", ")}) VALUES ${tuples.slice(i, i + perStmt).map(() => rowSql).join(", ")}
         ON CONFLICT (key) DO UPDATE SET ${updateSet}`,
      ).bind(...tuples.slice(i, i + perStmt).flat()),
    );
  }
  try {
    for (let i = 0; i < stmts.length; i += 90) {
      await c.env.DB.batch(stmts.slice(i, i + 90));
    }
  } catch (e) {
    console.error(`build-search batch failed at cursor ${cursor}: ${String(e)}`);
    return c.text(`build-search failed: ${String(e)}`, 500);
  }

  const lastKey = rows.at(-1)?.key ?? cursor;
  return c.json({
    scanned: rows.length, lastKey,
    nextCursor: rows.length === limit ? lastKey : null,
  });
});

// Vector backfill for the v2 projection: embeds documents_search rows
// (docid + title + abstract) into Vectorize keyed by the document, with
// { key, flavor } metadata — no numeric id indirection. embedded_at is
// the cursor, so completed flavors re-run for nothing.
adminRoutes.post("/admin/embed-search", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const limit = Math.min(200, Number(c.req.query("limit") ?? "100") || 100);
  const cursor = c.req.query("cursor") ?? "";

  const { results } = await c.env.DB.prepare(
    `SELECT key, flavor, docid, title, abstract FROM documents_search
     WHERE key > ?1 AND embedded_at IS NULL ORDER BY key LIMIT ?2`,
  ).bind(cursor, limit).all<{ key: string; flavor: string; docid: string | null; title: string | null; abstract: string | null }>();

  const rows = (results ?? []).filter((r) => r.title !== null || r.abstract !== null || r.docid !== null);
  if (!(results ?? []).length) return c.json({ embedded: 0, lastKey: cursor, nextCursor: null });

  const { recordText, embedTexts } = await import("../lib/semantic");
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const embeddings = await embedTexts(c.env, batch.map((r) => recordText(r.docid, r.title, r.abstract)));
    if (embeddings.length !== batch.length) {
      return c.json({ error: "embedding count mismatch", expected: batch.length, got: embeddings.length }, 502);
    }
    const upserts = await Promise.all(batch.map(async (row, j) => {
      const values = embeddings[j];
      if (!values) return null;
      // Vectorize ids cap at 44 bytes: a digest of flavor/key is
      // collision-free and length-stable; the metadata carries the key.
      const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${row.flavor}/${row.key}`));
      const id = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      return { id, values, metadata: { key: row.key, flavor: row.flavor } };
    })).then((list) => list.filter((u) => u !== null));
    await c.env.VECTORIZE.upsert(upserts);
  }

  // Stamp the page (all scanned rows, not only embedded ones, so the walk
  // advances a full page even through gaps).
  const stamped = (results ?? []).map((r) => r.key);
  const now = new Date().toISOString();
  for (let i = 0; i < stamped.length; i += 90) {
    await c.env.DB.prepare(
      `UPDATE documents_search SET embedded_at = ?1 WHERE key IN (${stamped.slice(i, i + 90).map(() => "?").join(", ")})`,
    ).bind(now, ...stamped.slice(i, i + 90)).run();
  }

  const lastKey = (results ?? []).at(-1)!.key;
  return c.json({
    embedded: rows.length, lastKey,
    nextCursor: (results?.length ?? 0) === limit ? lastKey : null,
  });
});

// Paged walk over documents_search for node-side tooling: the pubid
// component backfill runs the @pubid/pubid grammar engine, which needs
// a real filesystem and cannot load inside the worker. ?flavor= scopes
// the walk (e.g. a re-run after an IHO grammar release).
adminRoutes.get("/admin/page-search", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const limit = Math.min(1000, Number(c.req.query("limit") ?? "500") || 500);
  const cursor = c.req.query("cursor") ?? "";
  const flavor = c.req.query("flavor");
  const { results } = flavor
    ? await c.env.DB.prepare(
      `SELECT key, docid FROM documents_search WHERE flavor = ?1 AND key > ?2 ORDER BY key LIMIT ?3`,
    ).bind(flavor, cursor, limit).all<{ key: string; docid: string | null }>()
    : await c.env.DB.prepare(
      `SELECT key, docid FROM documents_search WHERE key > ?1 ORDER BY key LIMIT ?2`,
    ).bind(cursor, limit).all<{ key: string; docid: string | null }>();
  const lastKey = (results ?? []).at(-1)?.key ?? cursor;
  return c.json({
    scanned: results?.length ?? 0,
    rows: results ?? [],
    nextCursor: (results?.length ?? 0) === limit ? lastKey : null,
  });
});

interface ComponentUpdate {
  key: string;
  publisher: string | null;
  number: string | null;
  part: string | null;
}

// Component updates from the engine backfill. Batched as CASE statements
// (~9 binds per row), so a page of 500 rows is ~56 statements. Columns
// are held by the projection upserts, so only this route writes them.
adminRoutes.post("/admin/set-components", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const body = await c.req.json<{ components?: ComponentUpdate[] }>().catch(() => null);
  if (!body?.components?.length) return c.text("Expected { components: [{ key, publisher, number, part }] }.", 400);

  const rows = body.components.filter((r) => typeof r.key === "string" && r.key.length > 0);
  const stmts: D1PreparedStatement[] = [];
  const PER_STMT = 10;
  for (let i = 0; i < rows.length; i += PER_STMT) {
    const group = rows.slice(i, i + PER_STMT);
    const cases = ["publisher", "number", "part"].map((col) => {
      const branches = group.map(() => `WHEN ? THEN ?`).join(" ");
      return `${col} = CASE key ${branches} END`;
    }).join(", ");
    const binds: unknown[] = [];
    for (const col of ["publisher", "number", "part"] as const) {
      for (const r of group) binds.push(r.key, r[col] ?? null);
    }
    stmts.push(
      c.env.DB.prepare(
        `UPDATE documents_search SET ${cases} WHERE key IN (${group.map(() => "?").join(", ")})`,
      ).bind(...binds, ...group.map((r) => r.key)),
    );
  }
  try {
    for (let i = 0; i < stmts.length; i += 90) {
      await c.env.DB.batch(stmts.slice(i, i + 90));
    }
  } catch (e) {
    console.error(`set-components batch failed: ${String(e)}`);
    return c.text(`set-components failed: ${String(e)}`, 500);
  }
  return c.json({ ok: true, updated: rows.length });
});

// Storage v2 ghost cleanup: same semantics as the v1 reconcile, over the
// v2 tables — documents_v2 rows of the flavor the wave never re-stamped.
adminRoutes.post("/admin/reconcile-v2/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }

  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const { before } = await c.req.json<{ before?: string }>();
  if (!before) return c.text("before timestamp is required.", 400);
  const cutoff = Date.parse(before);
  if (Number.isNaN(cutoff)) return c.text("before is not a timestamp.", 400);
  if (cutoff > Date.now() + 5 * 60_000) return c.text("before must not be in the future.", 400);

  const stale = "flavor = ?1 AND (indexed_at IS NULL OR indexed_at < ?2)";
  const doomed = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents_v2 WHERE ${stale}`,
  ).bind(flavor, before).first<{ n: number }>();

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM doc_keys WHERE document IN (SELECT key FROM documents_v2 WHERE ${stale})`).bind(flavor, before),
    c.env.DB.prepare(`DELETE FROM documents_v2 WHERE ${stale}`).bind(flavor, before),
    c.env.DB.prepare(
      `UPDATE flavors_v2 SET doc_count = (SELECT COUNT(*) FROM documents_v2 WHERE flavor = ?1)
       WHERE flavor = ?1`,
    ).bind(flavor),
  ]);

  return c.json({ flavor, before, deleted: doomed?.n ?? 0 });
});

async function putBlobs(bucket: R2Bucket, blobs: Record<string, string>, concurrency = 25): Promise<void> {
  const entries = Object.entries(blobs);
  for (let i = 0; i < entries.length; i += concurrency) {
    await Promise.all(
      entries.slice(i, i + concurrency).map(([key, xml]) =>
        bucket.put(key, xml, { httpMetadata: { contentType: "text/xml; charset=utf-8" } }),
      ),
    );
  }
}