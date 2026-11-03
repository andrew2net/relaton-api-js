import { canonicalize, yearOf } from "../pubid/index.ts";
import { lastPublisherKey, normKey, undatedKey } from "../pubid/index.ts";

export interface DocumentRow {
  id: number;
  flavor: string;
  file_path: string;
  kind: string;
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
}

export interface LookupOptions {
  code: string;
  year?: number | null;
  allParts?: boolean | null;
}

function queryKeys(code: string): string[] {
  const keys = [normKey(code)];
  const canon = canonicalize(code);
  if (canon) {
    const canonKey = normKey(canon);
    if (!keys.includes(canonKey)) keys.push(canonKey);
  }
  return keys.flatMap((k) => [k, lastPublisherKey(k)])
    .filter((k, i, all) => k.length > 2 && all.indexOf(k) === i);
}

export async function findDocument(
  db: D1Database,
  opts: LookupOptions,
): Promise<DocumentRow | null> {
  const keys = queryKeys(opts.code);
  if (!keys.length) return null;

  const parsedYear = Number(yearOf(opts.code));

  for (const k of keys) {
    const row = await matchByNorm(db, k, opts, Number.isFinite(parsedYear) ? parsedYear : null);
    if (row) return row;
  }

  for (const k of keys) {
    const row = await db
      .prepare(
        `SELECT d.* FROM documents AS d JOIN docids AS i ON i.document_id = d.id
         WHERE i.norm = ?1 ORDER BY d.year DESC, d.id ASC LIMIT 1`,
      )
      .bind(k)
      .first<DocumentRow>();
    if (row) return row;
  }

  return null;
}

async function matchByNorm(
  db: D1Database,
  k: string,
  opts: LookupOptions,
  parsedYear: number | null,
): Promise<DocumentRow | null> {
  if (opts.allParts) {
    const r = await db
      .prepare(
        `SELECT * FROM documents WHERE allparts_norm = ?1
         ORDER BY CASE kind WHEN 'all_parts' THEN 0 ELSE 1 END, year DESC, id ASC LIMIT 1`,
      )
      .bind(k)
      .first<DocumentRow>();
    if (r) return r;
  }

  const embeddedYear = k.match(/:(\d{4})/)?.[1] ?? (parsedYear ? String(parsedYear) : undefined);
  const year = embeddedYear ? Number(embeddedYear) : (opts.year ?? null);

  if (year) {
    const r = await db
      .prepare(
        `SELECT * FROM documents AS d WHERE d.undated_norm = ?1 AND (d.year = ?2 OR d.norm = ?3)
         ORDER BY d.year DESC, d.id ASC LIMIT 1`,
      )
      .bind(undatedKey(k), year, k)
      .first<DocumentRow>();
    if (r) return r;
  }

  return db
    .prepare(
      `SELECT * FROM documents AS d WHERE d.undated_norm = ?1
       ORDER BY d.year DESC, d.id ASC LIMIT 1`,
    )
    .bind(undatedKey(k))
    .first<DocumentRow>();
}
