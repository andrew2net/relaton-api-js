// The storage v2 ingest write path, as plain SQL statements.
//
// One builder, two consumers (relaton-api-js#137's bulk-import track): the
// worker route executes these through D1 batched prepared statements, and
// the CLI's `--dump-sql` mode renders the binds as SQLite literals into a
// file for `wrangler d1 execute --remote --file`. Because both render from THIS module, the
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
// D1 rejects any single SQL statement longer than 100KB ("Statement too
// long" — the documented large-import failure). The bind cap alone lets
// a group of documents with large JSON blow through it, so groups flush
// by estimated rendered bytes too. A single row over the cap cannot be
// split further; the chunk-level failure path handles it.
const STMT_BYTE_CAP = 90_000;

function tupleBytes(t: unknown[]): number {
  let n = 2;
  for (const v of t) n += typeof v === "string" ? v.length + 2 : String(v ?? "NULL").length;
  return n;
}

function groupTuples(tuples: unknown[][], maxRows: number): unknown[][][] {
  const groups: unknown[][][] = [];
  let group: unknown[][] = [];
  let bytes = 0;
  for (const t of tuples) {
    const b = tupleBytes(t);
    if (group.length && (group.length >= maxRows || bytes + b > STMT_BYTE_CAP)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(t);
    bytes += b;
  }
  if (group.length) groups.push(group);
  return groups;
}

function multiRowUpsert(table: string, columns: string[], pk: string, hold: string[], tuples: unknown[][]): SqlStatement[] {
  if (!tuples.length) return [];
  const maxRows = Math.max(1, Math.floor(BIND_CAP / columns.length));
  const rowSql = `(${columns.map(() => "?").join(", ")})`;
  const updateSet = columns.filter((col) => col !== pk && !hold.includes(col))
    .map((col) => `${col} = excluded.${col}`).join(", ");
  return groupTuples(tuples, maxRows).map((group) => ({
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (${pk}) DO UPDATE SET ${updateSet}`,
    binds: group.flat(),
  }));
}

function multiRowInsert(table: string, columns: string[], tuples: unknown[][]): SqlStatement[] {
  if (!tuples.length) return [];
  const maxRows = Math.max(1, Math.floor(BIND_CAP / columns.length));
  const rowSql = `(${columns.map(() => "?").join(", ")})`;
  return groupTuples(tuples, maxRows).map((group) => ({
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${group.map(() => rowSql).join(", ")}`,
    binds: group.flat(),
  }));
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
    const maxRows = Math.max(1, Math.floor(BIND_CAP / columns.length));
    const rowSql = `(${columns.map(() => "?").join(", ")})`;
    const tuples = chunk.rows.map((r) => [r.key, r.file, JSON.stringify(r.data)]);
    for (const group of groupTuples(tuples, maxRows)) {
      stmts.push({
        sql: `INSERT INTO documents_v2 (key, flavor, file, data, indexed_at)
           VALUES ${group.map(() => rowSql).join(", ")}
           ON CONFLICT (key) DO UPDATE SET
             flavor = excluded.flavor, file = excluded.file, data = excluded.data,
             indexed_at = excluded.indexed_at`,
        binds: group.flatMap((t) => [t[0], flavor, t[1], t[2], ingestedAt]),
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
// re-stamped since `before`, plus the flavor's row tally. The deletes run
// in bounded rounds (500 keys per statement) because a flavor-wide DELETE
// with FK cascades is too heavy for the D1 import endpoint — the gateway
// kills it at ~60s with "Upstream service unavailable [code: 7009]"
// (twice, deterministically, on the 2026-11-12 iso leg) while the same
// endpoint handles the 40MB data files fine, since their statements are
// bounded. Extra rounds are no-ops once the stale set is exhausted.
export function buildReconcileStatements(flavor: string, before: string): SqlStatement[] {
  const stale = `flavor = ?1 AND (indexed_at IS NULL OR indexed_at < ?2)`;
  const ROUNDS = 100;
  const BATCH = 500;
  const stmts: SqlStatement[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    stmts.push({
      sql: `DELETE FROM doc_keys WHERE document IN (SELECT key FROM documents_v2 WHERE ${stale} LIMIT ${BATCH})`,
      binds: [flavor, before],
    });
  }
  for (let r = 0; r < ROUNDS; r++) {
    stmts.push({
      sql: `DELETE FROM documents_v2 WHERE key IN (SELECT key FROM documents_v2 WHERE ${stale} LIMIT ${BATCH})`,
      binds: [flavor, before],
    });
  }
  stmts.push({
    sql: `UPDATE flavors_v2 SET doc_count = (SELECT COUNT(*) FROM documents_v2 WHERE flavor = ?1)
       WHERE flavor = ?1`,
    binds: [flavor],
  });
  return stmts;
}
