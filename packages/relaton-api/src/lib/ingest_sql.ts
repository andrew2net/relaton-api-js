// The storage v2 ingest write path, as plain SQL statements.
//
// One builder, two consumers (relaton-api-js#137's bulk-import track): the
// worker route executes these through D1 batched prepared statements, and
// the CLI's `--dump-sql` mode renders the binds as SQLite literals into a
// file for `wrangler d1 import`. Because both render from THIS module, the
// bulk path cannot drift from the API path - there is one write shape.
//
// The batching mirrors the worker's: one multi-row upsert per ~90 binds,
// one delete per ~90 keys - statements stay far under D1's per-query CPU
// and bind caps regardless of chunk size.
import {
  deriveSearchRow,
  projectClassifications,
  projectContributors,
  projectDates,
  projectIdentifiers,
  projectRelations,
  projectTitles,
} from "./storage2.ts";

export interface IngestRow {
  key: string;
  file: string;
  data: Record<string, unknown>;
  keys: string[];
}

export interface IngestChunkLike {
  flavor: string;
  repo: string;
  final?: boolean;
  lastModified?: string | null;
  relatonVersion?: string;
  rows: IngestRow[];
  blobs: Record<string, string>;
}

export interface SqlStatement {
  sql: string;
  binds: unknown[];
}

const BIND_CAP = 90;

function multiRowUpsert(table: string, columns: string[], pk: string, hold: string[], tuples: unknown[][]): SqlStatement[] {
  if (!tuples.length) return [];
  const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
  const rowSql = `(${columns.map(() => "?").join(", ")})`;
  const updateSet = columns.filter((col) => col !== pk && !hold.includes(col))
    .map((col) => `${col} = excluded.${col}`).join(", ");
  const out: SqlStatement[] = [];
  for (let i = 0; i < tuples.length; i += perStmt) {
    const group = tuples.slice(i, i + perStmt);
    out.push({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (${pk}) DO UPDATE SET ${updateSet}`,
      binds: group.flat(),
    });
  }
  return out;
}

function multiRowInsert(table: string, columns: string[], tuples: unknown[][]): SqlStatement[] {
  if (!tuples.length) return [];
  const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
  const rowSql = `(${columns.map(() => "?").join(", ")})`;
  const out: SqlStatement[] = [];
  for (let i = 0; i < tuples.length; i += perStmt) {
    const group = tuples.slice(i, i + perStmt);
    out.push({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}`,
      binds: group.flat(),
    });
  }
  return out;
}

function deleteByDocuments(table: string, keys: string[]): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (let i = 0; i < keys.length; i += BIND_CAP) {
    const group = keys.slice(i, i + BIND_CAP);
    out.push({
      sql: `DELETE FROM ${table} WHERE document IN (${group.map((_, j) => `?${j + 1}`).join(", ")})`,
      binds: group,
    });
  }
  return out;
}

// The complete statement sequence for one ingest chunk: the document
// upserts, the query-side projection (migration 0009; FTS rows ride the
// table's triggers), the lookup tokens, and the per-chunk projection
// deletes + inserts. Order matters: deletes before their table's inserts,
// documents before anything referencing them.
export function buildIngestStatements(chunk: IngestChunkLike, ingestedAt: string): SqlStatement[] {
  const flavor = chunk.flavor;
  const chunkKeys = chunk.rows.map((r) => r.key);
  const stmts: SqlStatement[] = [];

  {
    const columns = ["key", "flavor", "file", "data", "indexed_at"];
    const perStmt = Math.max(1, Math.floor(BIND_CAP / columns.length));
    const rowSql = `(${columns.map(() => "?").join(", ")})`;
    for (let i = 0; i < chunk.rows.length; i += perStmt) {
      const group = chunk.rows.slice(i, i + perStmt);
      stmts.push({
        sql: `INSERT INTO documents_v2 (key, flavor, file, data, indexed_at)
           VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (key) DO UPDATE SET
             flavor = excluded.flavor, file = excluded.file, data = excluded.data,
             indexed_at = excluded.indexed_at`,
        binds: group.flatMap((r) => [r.key, flavor, r.file, JSON.stringify(r.data), ingestedAt]),
      });
    }
  }

  stmts.push(...multiRowUpsert(
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
  stmts.push(...multiRowInsert(
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
    stmts.push(...multiRowInsert(table, columns, tuples));
  }

  if (chunk.final) {
    stmts.push({
      sql: `INSERT INTO flavors_v2 (flavor, repo, last_modified, indexed_at, doc_count)
         VALUES (?1, ?2, ?3, ?4, (SELECT COUNT(*) FROM documents_v2 WHERE flavor = ?1))
         ON CONFLICT (flavor) DO UPDATE SET
           repo = excluded.repo, last_modified = excluded.last_modified,
           indexed_at = excluded.indexed_at, doc_count = excluded.doc_count`,
      binds: [flavor, chunk.repo, chunk.lastModified ?? null, ingestedAt],
    });
    if (chunk.relatonVersion) {
      stmts.push({
        sql: `INSERT INTO meta (key, value) VALUES ('relaton_version', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        binds: [chunk.relatonVersion],
      });
    }
  }

  return stmts;
}

// The ghost cleanup for a full wave: everything the flavor's walk never
// re-stamped since `before`, plus the flavor's row tally. Mirrors the
// worker's /admin/reconcile-v2 exactly.
export function buildReconcileStatements(flavor: string, before: string): SqlStatement[] {
  const stale = `flavor = ?1 AND (indexed_at IS NULL OR indexed_at < ?2)`;
  return [
    {
      sql: `DELETE FROM doc_keys WHERE document IN (SELECT key FROM documents_v2 WHERE ${stale})`,
      binds: [flavor, before],
    },
    {
      sql: `DELETE FROM documents_v2 WHERE ${stale}`,
      binds: [flavor, before],
    },
    {
      sql: `UPDATE flavors_v2 SET doc_count = (SELECT COUNT(*) FROM documents_v2 WHERE flavor = ?1)
       WHERE flavor = ?1`,
      binds: [flavor],
    },
  ];
}
