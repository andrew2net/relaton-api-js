import { ftsMatch as ftsMatchExpr } from "./search";
import { lastPublisherKey, normKey, undatedKey } from "../pubid/keys.ts";
import { canonicalize, yearOf } from "../pubid/index.ts";

// Query engine over documents_search (migration 0009) — the storage-v2
// projection of the v1 documents table. Same search semantics (filters,
// FTS with LIKE fallback, facets, sorting), pubid-aware lookup, and the
// collection/entry/home reads the cloud store needs. The v1 engine
// (search.ts/lookup.ts) stays until the backfill completes and the
// cleanup migration drops the v1 tables; callers pick with searchReady().

export interface SearchRowV2 {
  key: string;
  flavor: string;
  file: string;
  docid: string | null;
  title: string | null;
  year: number | null;
  doctype: string | null;
  status: string | null;
  abstract: string | null;
  norm: string;
  undated_norm: string;
  allparts_norm: string;
  publisher: string | null;
  number: string | null;
  part: string | null;
  edition: string | null;
}

export interface SearchParamsV2 {
  semantic?: boolean;
  q?: string;
  inAbstract?: boolean;
  flavor?: string;
  doctype?: string;
  status?: string;
  publisher?: string;
  number?: string;
  part?: string;
  edition?: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  sort?: "relevance" | "year_desc" | "year_asc" | "docid";
  page?: number;
  size?: number;
}

export interface SearchHitV2 {
  key: string;
  flavor: string;
  file: string;
  docid: string | null;
  year: number | null;
  doctype: string | null;
  status: string | null;
  title: string | null;
  norm: string;
}

export interface FacetCountsV2 {
  [dimension: string]: { value: string; count: number }[];
}

export interface SearchResultV2 {
  items: SearchHitV2[];
  total: number;
  page: number;
  size: number;
  hasPrev: boolean;
  hasNext: boolean;
  facets: FacetCountsV2;
}

// True when the v2 search projection holds rows. Probed per request until
// the backfill completes — caching a stale negative would pin an isolate
// to the v1 path after the tables fill.
export async function searchReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT key FROM documents_search LIMIT 1").first();
    return row !== null;
  } catch {
    return false; // migration not applied yet
  }
}

// Entry URL key for a dataset file: the manifest/entry address space is
// the file without its extension and without the data/ prefix (the same
// space the v1 r2_key shape produced).
export function entryKeyOf(file: string): string {
  return file.replace(/^data\//, "").replace(/\.(ya?ml|json|xml)$/i, "");
}

function buildWhere(
  p: SearchParamsV2,
  opts: { scopeFlavor?: string } = {},
  useFts = false,
): { where: string; bind: unknown[] } {
  const clauses: string[] = [];
  const bind: unknown[] = [];
  const push = (clause: string, ...values: unknown[]) => {
    clauses.push(clause);
    bind.push(...values);
  };

  if (opts.scopeFlavor) push("flavor = ?", opts.scopeFlavor);
  else if (p.flavor) push("flavor = ?", p.flavor);
  if (p.doctype) push("doctype = ?", p.doctype);
  if (p.status) push("status = ?", p.status);
  if (p.publisher) push("publisher = ? COLLATE NOCASE", p.publisher);
  if (p.number) push("number = ? COLLATE NOCASE", p.number);
  if (p.part) push("part = ? COLLATE NOCASE", p.part);
  if (p.edition) push("edition = ? COLLATE NOCASE", p.edition);
  if (p.yearFrom != null) push("year >= ?", p.yearFrom);
  if (p.yearTo != null) push("year <= ?", p.yearTo);
  if (p.q) {
    const match = useFts ? ftsMatchExpr(p.q, p.inAbstract === true) : "";
    if (match) {
      push("rowid IN (SELECT rowid FROM documents_search_fts WHERE documents_search_fts MATCH ?)", match);
    } else {
      const like = `%${p.q}%`;
      if (p.inAbstract) push("(docid LIKE ? OR title LIKE ? OR norm LIKE ? OR undated_norm LIKE ? OR abstract LIKE ?)", like, like, like, like, like);
      else push("(docid LIKE ? OR title LIKE ? OR norm LIKE ? OR undated_norm LIKE ?)", like, like, like, like);
    }
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", bind };
}

async function facetFor(
  db: D1Database,
  dimension: string,
  textWhere: { where: string; bind: unknown[] },
): Promise<{ value: string; count: number }[]> {
  const notNull = `${textWhere.where ? textWhere.where + " AND " : "WHERE "}${dimension} IS NOT NULL`;
  const { results } = await db.prepare(
    `SELECT ${dimension} AS value, COUNT(*) AS count FROM documents_search ${notNull}
     GROUP BY ${dimension} ORDER BY count DESC LIMIT 12`,
  ).bind(...textWhere.bind).all<{ value: string; count: number }>();
  return (results ?? []).map((r) => ({ value: r.value, count: r.count }));
}

// Hybrid search (v2): keyword results fused with semantic neighbours by
// reciprocal-rank fusion on the first page. Vectors carry { key, flavor }
// metadata (written by /admin/embed-search); an empty vector index simply
// degrades to keyword-only.
export async function hybridSearch(
  db: D1Database,
  env: { AI: Ai; VECTORIZE: VectorizeIndex } | undefined,
  params: SearchParamsV2,
  opts: { scopeFlavor?: string } = {},
): Promise<SearchResultV2> {
  const result = await searchDocuments(db, params, opts);
  const size = Math.min(100, Math.max(10, params.size ?? 25));
  if (!env || !params.q || !params.semantic || (params.page ?? 0) > 0 || result.items.length === 0) {
    return result;
  }
  const { semanticSearchV2, fuseRankings } = await import("./semantic");
  const hits = await semanticSearchV2(env, params.q, 50);
  if (!hits.length) return result;

  const { where, bind } = buildWhere(
    {
      flavor: params.flavor,
      doctype: params.doctype,
      status: params.status,
      yearFrom: params.yearFrom,
      yearTo: params.yearTo,
    },
    opts,
  );
  const placeholders = hits.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT key, flavor, file, docid, year, doctype, status, title, norm
     FROM documents_search WHERE key IN (${placeholders})${where ? ` AND ${where.replace(/^WHERE /, "")}` : ""}`,
  ).bind(...hits.map((h) => h.key), ...bind).all<SearchHitV2>();

  const byKey = new Map((results ?? []).map((r) => [r.key, r]));
  const secondary = hits.flatMap((h) => {
    const row = byKey.get(h.key);
    return row && !result.items.some((i) => i.key === row.key) ? [row] : [];
  });
  const fused = fuseRankings(
    result.items.map((i) => ({ ...i, id: i.key })),
    secondary.map((i) => ({ ...i, id: i.key })),
  ).slice(0, size);
  return { ...result, items: fused.map(({ id: _id, ...row }) => row) };
}

export async function searchDocuments(
  db: D1Database,
  params: SearchParamsV2,
  opts: { scopeFlavor?: string } = {},
): Promise<SearchResultV2> {
  const page = Math.max(0, params.page ?? 0);
  const size = Math.min(100, Math.max(10, params.size ?? 25));
  const useFts = params.q ? await ftsReady(db) : false;
  const { where, bind } = buildWhere(params, opts, useFts);
  const sort = params.sort ?? "relevance";

  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM documents_search ${where}`,
  ).bind(...bind).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  let order: string;
  const orderBind: unknown[] = [];
  if (sort === "relevance" && params.q) {
    order = `CASE WHEN docid = ? THEN 0 WHEN docid LIKE ? THEN 1 ELSE 2 END, year DESC, docid ASC`;
    orderBind.push(params.q, `${params.q}%`);
  } else {
    order = SORTS[sort] ?? "year DESC, docid ASC";
  }

  const { results } = await db.prepare(
    `SELECT key, flavor, file, docid, year, doctype, status, title, norm
     FROM documents_search ${where} ORDER BY ${order} LIMIT ${size + 1} OFFSET ${page * size}`,
  ).bind(...bind, ...orderBind).all<SearchHitV2>();

  const rows = results ?? [];
  const items = rows.slice(0, size);

  const textOnly = buildWhere(
    { q: params.q, yearFrom: params.yearFrom, yearTo: params.yearTo },
    opts,
    useFts,
  );
  const facets: FacetCountsV2 = {};
  if (!opts.scopeFlavor) facets.flavor = await facetFor(db, "flavor", textOnly);
  facets.doctype = await facetFor(db, "doctype", textOnly);
  facets.status = await facetFor(db, "status", textOnly);

  return { items, total, page, size, hasPrev: page > 0, hasNext: rows.length > size, facets };
}

const SORTS: Record<string, string> = {
  year_desc: "year DESC, docid ASC",
  year_asc: "year ASC, docid ASC",
  docid: "docid ASC",
};

export async function ftsReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT rowid FROM documents_search_fts LIMIT 1").first();
    return row !== null;
  } catch {
    return false;
  }
}

// Pubid-aware lookup (the v1 findDocument semantics) over documents_search,
// falling back to the dataset tokens in doc_keys.
export interface LookupOptionsV2 {
  code: string;
  year?: number | null;
  allParts?: boolean | null;
}

export interface FoundDocument extends SearchRowV2 {}

export async function findDocument(
  db: D1Database,
  opts: LookupOptionsV2,
): Promise<FoundDocument | null> {
  const keys = [normKey(opts.code)];
  const canon = canonicalize(opts.code);
  if (canon) {
    const canonKey = normKey(canon);
    if (!keys.includes(canonKey)) keys.push(canonKey);
  }
  const probeKeys = keys.flatMap((k) => [k, lastPublisherKey(k)])
    .filter((k, i, all) => k.length > 2 && all.indexOf(k) === i);
  if (!probeKeys.length) return null;

  const parsedYear = Number(yearOf(opts.code));
  const refYear = Number.isFinite(parsedYear) ? parsedYear : null;

  for (const k of probeKeys) {
    const row = await matchByNorm(db, k, opts, refYear);
    if (row) return row;
  }

  for (const k of probeKeys) {
    const row = await db
      .prepare(
        `SELECT s.* FROM documents_search AS s JOIN doc_keys AS t ON t.document = s.key
         WHERE t.key = ?1 ORDER BY s.year DESC, s.key ASC LIMIT 1`,
      )
      .bind(k)
      .first<SearchRowV2>();
    if (row) return row;
  }

  return null;
}

async function matchByNorm(
  db: D1Database,
  k: string,
  opts: LookupOptionsV2,
  refYear: number | null,
): Promise<SearchRowV2 | null> {
  if (opts.allParts) {
    const r = await db
      .prepare(
        `SELECT * FROM documents_search WHERE allparts_norm = ?1 ORDER BY year DESC, key ASC LIMIT 1`,
      )
      .bind(k)
      .first<SearchRowV2>();
    if (r) return r;
  }

  const embeddedYear = k.match(/:(\d{4})/)?.[1] ?? (refYear ? String(refYear) : undefined);
  const year = embeddedYear ? Number(embeddedYear) : (opts.year ?? null);

  if (year) {
    const r = await db
      .prepare(
        `SELECT * FROM documents_search AS s WHERE s.undated_norm = ?1 AND (s.year = ?2 OR s.norm = ?3)
         ORDER BY s.year DESC, s.key ASC LIMIT 1`,
      )
      .bind(undatedKey(k), year, k)
      .first<SearchRowV2>();
    if (r) return r;
  }

  return db
    .prepare(
      `SELECT * FROM documents_search AS s WHERE s.undated_norm = ?1
       ORDER BY s.year DESC, s.key ASC LIMIT 1`,
    )
    .bind(undatedKey(k))
    .first<SearchRowV2>();
}

// Cloud store reads over the v2 projection.
export interface EntryRowV2 {
  docid: string | null;
  file: string;
}

export async function findEntryRow(
  db: D1Database,
  collection: string,
  key: string,
): Promise<EntryRowV2 | null> {
  const bare = key.replace(/^data\//, "").replace(/\.(ya?ml|json|xml)$/i, "");
  const candidates = [`data/${bare}.yaml`, `${bare}.yaml`, `data/${bare}.yml`, `${bare}.yml`];
  return db.prepare(
    `SELECT docid, file FROM documents_search WHERE flavor = ? AND file IN (${candidates.map(() => "?").join(", ")})`,
  ).bind(collection, ...candidates).first<EntryRowV2>();
}

// R2 blob key for a stored file — the same convention the ingest wrote
// (`<flavor>/<file without .yaml>`, holding bibdata XML).
export function blobKeyOf(flavor: string, file: string): string {
  return `${flavor}/${file.replace(/\.ya?ml$/i, "")}`;
}

export interface FlavorRowV2 {
  flavor: string;
  doc_count: number;
  last_modified: string | null;
  indexed_at: string;
}

export async function listFlavors(db: D1Database): Promise<FlavorRowV2[]> {
  const { results } = await db.prepare(
    "SELECT flavor, doc_count, last_modified, indexed_at FROM flavors_v2 ORDER BY flavor",
  ).all<FlavorRowV2>();
  return results ?? [];
}

export interface HomeFlavorRowV2 {
  flavor: string;
  doc_count: number;
  indexed_at: string | null;
}

export async function homeFlavors(db: D1Database): Promise<HomeFlavorRowV2[]> {
  const { results } = await db.prepare(
    `SELECT s.flavor, COUNT(*) AS doc_count, MAX(f.indexed_at) AS indexed_at
     FROM documents_search AS s LEFT JOIN flavors_v2 AS f ON f.flavor = s.flavor
     GROUP BY s.flavor ORDER BY doc_count DESC`,
  ).all<HomeFlavorRowV2>();
  return results ?? [];
}
