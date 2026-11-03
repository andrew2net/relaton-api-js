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

interface IngestDocid {
  norm: string;
  raw: string;
  type: string | null;
}

interface IngestRow {
  abstract?: string | null;
  file_path: string;
  r2_key: string;
  docid: string | null;
  norm: string;
  undated_norm: string;
  allparts_norm: string;
  year: number | null;
  published: string | null;
  title_en: string | null;
  doctype: string | null;
  status: string | null;
  // Pubid components of the primary docidentifier (the ingest tool parses
  // them); optional so an older producer stays compatible.
  publisher?: string | null;
  number?: string | null;
  part?: string | null;
  edition?: string | null;
  docids: IngestDocid[];
}

interface IngestChunk {
  flavor: string;
  repo: string;
  final?: boolean;
  lastModified?: string | null;
  relatonVersion?: string;
  rows: IngestRow[];
  blobs: Record<string, string>;
}

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

/**
 * Backfills the abstract column for already-ingested documents by reading
 * each record from R2 and extracting the abstract. Paged: pass ?cursor=
 * (last document id) to continue; repeats until the flavor is walked.
 */
adminRoutes.post("/admin/backfill-abstracts/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const limit = Math.min(500, Number(c.req.query("limit") ?? "200") || 200);
  const cursor = Number(c.req.query("cursor") ?? "0") || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT id, r2_key FROM documents
     WHERE flavor = ?1 AND id > ?2 AND abstract IS NULL ORDER BY id LIMIT ?3`,
  ).bind(flavor, cursor, limit).all<{ id: number; r2_key: string }>();

  let done = 0;
  let lastId = cursor;
  for (const row of results ?? []) {
    lastId = row.id;
    const obj = await c.env.BUCKET.get(row.r2_key);
    if (!obj) continue;
    const body = await obj.text();
    let abstract: string | null = null;
    if (body.trimStart().startsWith("<")) {
      const m = body.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/);
      if (m?.[1]) abstract = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 4000) || null;
    }
    if (abstract) {
      await c.env.DB.prepare("UPDATE documents SET abstract = ?1 WHERE id = ?2")
        .bind(abstract, row.id).run();
      done += 1;
    }
  }

  return c.json({
    flavor, scanned: results?.length ?? 0, updated: done, lastId,
    nextCursor: (results?.length ?? 0) === limit ? lastId : null,
  });
});

adminRoutes.post("/admin/backfill-status/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const limit = Math.min(500, Number(c.req.query("limit") ?? "200") || 200);
  const cursor = Number(c.req.query("cursor") ?? "0") || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT id, r2_key FROM documents
     WHERE flavor = ?1 AND id > ?2 AND status IS NULL ORDER BY id LIMIT ?3`,
  ).bind(flavor, cursor, limit).all<{ id: number; r2_key: string }>();

  let done = 0;
  let lastId = cursor;
  for (const row of results ?? []) {
    lastId = row.id;
    const obj = await c.env.BUCKET.get(row.r2_key);
    if (!obj) continue;
    const body = await obj.text();
    let status: string | null = null;
    if (body.trimStart().startsWith("<")) {
      const m = body.match(/<status[^>]*>([\s\S]*?)<\/status>/);
      if (m?.[1]) {
        const stage = m[1].match(/<stage[^>]*>([^<]+)<\/stage>/)?.[1]?.trim();
        const substage = m[1].match(/<substage[^>]*>([^<]+)<\/substage>/)?.[1]?.trim();
        status = stage && substage ? `${stage}.${substage}` : stage ??
          (m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null);
      }
    }
    if (status) {
      await c.env.DB.prepare("UPDATE documents SET status = ?1 WHERE id = ?2")
        .bind(status.slice(0, 32), row.id).run();
      done += 1;
    }
  }

  return c.json({
    flavor, scanned: results?.length ?? 0, updated: done, lastId,
    nextCursor: (results?.length ?? 0) === limit ? lastId : null,
  });
});

adminRoutes.post("/admin/populate-fts", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const limit = Math.min(10000, Number(c.req.query("limit") ?? "5000") || 5000);
  const cursor = Number(c.req.query("cursor") ?? "0") || 0;

  // One statement re-derives every entry from the content table — the
  // fastest path for a first index build. Falls back to the paged walk
  // below when a runtime cap refuses the statement.
  if (c.req.query("rebuild") === "1") {
    await c.env.DB.prepare("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')").run();
    return c.json({ mode: "rebuild" });
  }

  // Rows whose FTS entry does not exist yet (pre-trigger rows), in id
  // order so the walk is resumable by cursor.
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.docid, d.title_en, d.abstract FROM documents d
     WHERE d.id > ?1 AND NOT EXISTS (SELECT 1 FROM documents_fts WHERE documents_fts.rowid = d.id)
     ORDER BY d.id LIMIT ?2`,
  ).bind(cursor, limit).all<{ id: number; docid: string | null; title_en: string | null; abstract: string | null }>();

  for (const row of results ?? []) {
    await c.env.DB.prepare(
      "INSERT INTO documents_fts(rowid, docid, title_en, abstract) VALUES (?1, ?2, ?3, ?4)",
    ).bind(row.id, row.docid, row.title_en, row.abstract).run();
  }

  const lastId = (results ?? []).at(-1)?.id ?? cursor;
  return c.json({
    scanned: results?.length ?? 0, indexed: (results ?? []).length, lastId,
    nextCursor: (results?.length ?? 0) === limit ? lastId : null,
  });
});

adminRoutes.post("/admin/embed-records", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }
  const limit = Math.min(200, Number(c.req.query("limit") ?? "100") || 100);
  const cursor = Number(c.req.query("cursor") ?? "0") || 0;

  // Scan raw rows by id so the cursor always advances a full page —
  // filtering embeddable rows here would end the walk early at the
  // first gap. Rows without embeddable text are skipped in code.
  const { results } = await c.env.DB.prepare(
    `SELECT id, docid, title_en, abstract FROM documents
     WHERE id > ?1 ORDER BY id LIMIT ?2`,
  ).bind(cursor, limit).all<{ id: number; docid: string | null; title_en: string | null; abstract: string | null }>();

  const rows = (results ?? []).filter((r) => r.title_en !== null || r.abstract !== null);
  if (!(results ?? []).length) return c.json({ embedded: 0, lastId: cursor, nextCursor: null });

  // Vectors carry the document id in metadata so matches map straight
  // back to D1 without a lookup.
  const { recordText, embedTexts } = await import("../lib/semantic");
  // The AI binding accepts up to 100 texts per call; batch to stay well
  // inside that while upserting everything the page selected.
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const embeddings = await embedTexts(c.env, batch.map((r) => recordText(r.docid, r.title_en, r.abstract)));
    if (embeddings.length !== batch.length) {
      return c.json({ error: "embedding count mismatch", expected: batch.length, got: embeddings.length }, 502);
    }
    const upserts = batch.flatMap((row, j) => {
      const values = embeddings[j];
      return values ? [{
        id: `doc-${row.id}`,
        values,
        metadata: { documentId: row.id },
      }] : [];
    });
    await c.env.VECTORIZE.upsert(upserts);
  }

  const lastId = (results ?? []).at(-1)?.id ?? cursor;
  return c.json({
    embedded: rows.length, lastId,
    nextCursor: (results?.length ?? 0) === limit ? lastId : null,
  });
});

adminRoutes.post("/admin/ingest/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }

  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const chunk = await c.req.json<IngestChunk>();
  if (chunk.flavor !== flavor) return c.text("Flavor mismatch.", 400);

  const stmts: D1PreparedStatement[] = [];
  const ingestedAt = new Date().toISOString();
  for (const row of chunk.rows) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO documents
           (flavor, file_path, kind, r2_key, docid, norm, undated_norm, allparts_norm,
            year, published, title_en, doctype, status, abstract,
            publisher, number, part, edition, ingested_at)
         VALUES (?1, ?2, 'document', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT (flavor, file_path, kind) DO UPDATE SET
           r2_key = excluded.r2_key, docid = excluded.docid, norm = excluded.norm,
           undated_norm = excluded.undated_norm, allparts_norm = excluded.allparts_norm,
           year = excluded.year, published = excluded.published, title_en = excluded.title_en,
           doctype = excluded.doctype, status = excluded.status, abstract = excluded.abstract,
           publisher = excluded.publisher, number = excluded.number,
           part = excluded.part, edition = excluded.edition, ingested_at = excluded.ingested_at`,
      ).bind(
        flavor, row.file_path, row.r2_key, row.docid, row.norm, row.undated_norm,
        row.allparts_norm, row.year, row.published, row.title_en, row.doctype, row.status,
        row.abstract ?? null,
        row.publisher ?? null, row.number ?? null, row.part ?? null, row.edition ?? null,
        ingestedAt,
      ),
    );
    stmts.push(
      c.env.DB.prepare(
        `DELETE FROM docids WHERE document_id =
           (SELECT id FROM documents WHERE flavor = ?1 AND file_path = ?2 AND kind = 'document')`,
      ).bind(flavor, row.file_path),
    );
    for (const d of row.docids) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO docids (norm, raw, type, document_id)
           SELECT ?1, ?2, ?3, id FROM documents WHERE flavor = ?4 AND file_path = ?5 AND kind = 'document'
           ON CONFLICT (norm, document_id) DO NOTHING`,
        ).bind(d.norm, d.raw, d.type, flavor, row.file_path),
      );
    }
  }

  if (chunk.final) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO flavors (flavor, repo, last_modified, ingested_at, doc_count)
         VALUES (?1, ?2, ?3, ?4, (SELECT COUNT(*) FROM documents WHERE flavor = ?1))
         ON CONFLICT (flavor) DO UPDATE SET
           repo = excluded.repo, last_modified = excluded.last_modified,
           ingested_at = excluded.ingested_at, doc_count = excluded.doc_count`,
      ).bind(flavor, chunk.repo, chunk.lastModified ?? null, new Date().toISOString()),
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
    console.error(`ingest batch failed for flavor ${flavor}: ${String(e)}`);
    return c.text(`Ingest failed: ${String(e)}`, 500);
  }

  await putBlobs(c.env.BUCKET, chunk.blobs);

  return c.json({ ok: true, rows: chunk.rows.length, blobs: Object.keys(chunk.blobs).length });
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
    ["embedded_at"],
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
  const updateSet = columns.filter((col) => col !== "key" && col !== "embedded_at")
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

// Delete a flavor's ghost rows: documents whose file_path was not touched
// since `before` (rows the current ingest generation never re-stamped).
// Shards cannot prune mid-wave — each shard only sees its own window — so
// this runs once the whole wave is done. The FTS delete trigger keeps the
// search index in step.
adminRoutes.post("/admin/reconcile/:flavor", async (c) => {
  if (!c.env.ADMIN_TOKEN || !tokenMatches(c.req.header("Authorization"), c.env.ADMIN_TOKEN)) {
    return c.text("Forbidden.", 403);
  }

  const flavor = c.req.param("flavor").replace(/[^a-z0-9-]/gi, "");
  const { before } = await c.req.json<{ before?: string }>();
  if (!before) return c.text("before timestamp is required.", 400);
  const cutoff = Date.parse(before);
  if (Number.isNaN(cutoff)) return c.text("before is not a timestamp.", 400);
  // A future cutoff would match every row of the flavor.
  if (cutoff > Date.now() + 5 * 60_000) return c.text("before must not be in the future.", 400);

  const stale = "flavor = ?1 AND (ingested_at IS NULL OR ingested_at < ?2)";
  const doomed = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents WHERE ${stale}`,
  ).bind(flavor, before).first<{ n: number }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM docids WHERE document_id IN (SELECT id FROM documents WHERE ${stale})`,
    ).bind(flavor, before),
    c.env.DB.prepare(`DELETE FROM documents WHERE ${stale}`).bind(flavor, before),
    c.env.DB.prepare(
      `UPDATE flavors SET doc_count = (SELECT COUNT(*) FROM documents WHERE flavor = ?1)
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