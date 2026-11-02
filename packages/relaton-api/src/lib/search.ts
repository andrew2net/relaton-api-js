import { fuseRankings } from "./semantic";

// Shared search engine for /search and /collections/{c}:
// one WHERE-builder over the documents index with pubid-aware matching,
// filters, sorting, pagination, and per-dimension facet counts.

export interface SearchParams {
  semantic?: boolean;
  q?: string;
  /** Also match the query against record abstracts (LIKE-based). */
  inAbstract?: boolean;
  flavor?: string;
  doctype?: string;
  status?: string;
  /** Pubid components of the primary docidentifier (ingest-parsed). */
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

export interface SearchHit {
  id: number;
  flavor: string;
  r2_key: string;
  docid: string | null;
  year: number | null;
  doctype: string | null;
  status: string | null;
  title_en: string | null;
  norm: string;
}

export interface FacetCounts {
  [dimension: string]: { value: string; count: number }[];
}

export interface SearchResult {
  items: SearchHit[];
  total: number;
  page: number;
  size: number;
  hasPrev: boolean;
  hasNext: boolean;
  facets: FacetCounts;
}

const SORTS: Record<string, string> = {
  year_desc: "year DESC, docid ASC",
  year_asc: "year ASC, docid ASC",
  docid: "docid ASC",
};

interface BuiltWhere {
  where: string;
  bind: unknown[];
}

/** Build an FTS5 MATCH string from free text: alphanumeric tokens, prefix
 * matched, ANDed ("ISO 9001" → `iso* AND 9001*`). Returns "" when the
 * query has no usable tokens, or when abstract-only mode needs the
 * LIKE fallback (column-filtered prefixes match too narrowly here).
 * An unpopulated index yields zero rows, so search.ts probes the index
 * before enabling this path. */
export function ftsMatch(q: string, abstractOnly = false): string {
  const tokens = q.match(/[A-Za-z0-9]+/g) ?? [];
  const usable = tokens.filter((w) => w.length >= 2 || /\d/.test(w)).slice(0, 8);
  if (!usable.length) return "";
  const expr = usable.map((w) => `${w.toLowerCase()}*`).join(" AND ");
  return abstractOnly ? `{abstract}: (${expr})` : expr;
}

/** True when the FTS index exists and holds rows. Probed per search —
 * it is a LIMIT 1 lookup, and caching a stale negative would pin an
 * isolate to the LIKE scan even after the index populates. */
export async function ftsAvailable(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(
      "SELECT rowid FROM documents_fts LIMIT 1",
    ).first();
    return row !== null;
  } catch {
    return false;
  }
}

function buildWhere(
  p: SearchParams,
  opts: { scopeFlavor?: string } = {},
  useFts = false,
): BuiltWhere {
  const clauses: string[] = [];
  const bind: unknown[] = [];

  if (opts.scopeFlavor) {
    clauses.push("flavor = ?");
    bind.push(opts.scopeFlavor);
  } else if (p.flavor) {
    clauses.push("flavor = ?");
    bind.push(p.flavor);
  }
  if (p.doctype) {
    clauses.push("doctype = ?");
    bind.push(p.doctype);
  }
  if (p.status) {
    clauses.push("status = ?");
    bind.push(p.status);
  }
  if (p.publisher) {
    clauses.push("publisher = ? COLLATE NOCASE");
    bind.push(p.publisher);
  }
  if (p.number) {
    clauses.push("number = ? COLLATE NOCASE");
    bind.push(p.number);
  }
  if (p.part) {
    clauses.push("part = ? COLLATE NOCASE");
    bind.push(p.part);
  }
  if (p.edition) {
    clauses.push("edition = ? COLLATE NOCASE");
    bind.push(p.edition);
  }
  if (p.yearFrom != null) {
    clauses.push("year >= ?");
    bind.push(p.yearFrom);
  }
  if (p.yearTo != null) {
    clauses.push("year <= ?");
    bind.push(p.yearTo);
  }
  if (p.q) {
    const match = useFts ? ftsMatch(p.q, p.inAbstract === true) : "";
    if (match) {
      // FTS5 narrows by identifier/title/abstract tokens in a fraction of
      // the LIKE scan; the outer query keeps all filters and ordering.
      clauses.push("id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)");
      bind.push(match);
    } else {
      const like = `%${p.q}%`;
      if (p.inAbstract) {
        clauses.push(
          "(docid LIKE ? OR title_en LIKE ? OR norm LIKE ? OR undated_norm LIKE ? OR abstract LIKE ?)",
        );
        bind.push(like, like, like, like, like);
      } else {
        clauses.push("(docid LIKE ? OR title_en LIKE ? OR norm LIKE ? OR undated_norm LIKE ?)");
        bind.push(like, like, like, like);
      }
    }
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    bind,
  };
}

async function facetFor(
  db: D1Database,
  dimension: string,
  textWhere: BuiltWhere,
): Promise<{ value: string; count: number }[]> {
  const notNull = `${textWhere.where ? textWhere.where + " AND " : "WHERE "}${dimension} IS NOT NULL`;
  const { results } = await db.prepare(
    `SELECT ${dimension} AS value, COUNT(*) AS count FROM documents ${notNull}
     GROUP BY ${dimension} ORDER BY count DESC LIMIT 12`,
  ).bind(...textWhere.bind).all<{ value: string; count: number }>();
  return (results ?? []).map((r) => ({ value: r.value, count: r.count }));
}


/**
 * Hybrid search: keyword results fused with semantic neighbours by
 * reciprocal-rank fusion on the first page. Deeper pages fall back to
 * keyword ordering — the fused pool is intentionally small.
 */
export async function hybridSearch(
  db: D1Database,
  env: { AI: Ai; VECTORIZE: VectorizeIndex } | undefined,
  params: SearchParams,
  opts: { scopeFlavor?: string } = {},
): Promise<SearchResult> {
  const result = await searchDocuments(db, params, opts);
  const size = Math.min(100, Math.max(10, params.size ?? 25));
  if (!env || !params.q || !params.semantic || (params.page ?? 0) > 0 || result.items.length === 0) {
    return result;
  }
  const { semanticSearch } = await import("./semantic");
  const hits = await semanticSearch(env, params.q, 50);
  if (!hits.length) return result;

  const ids = hits.map((h) => h.id);
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
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT id, flavor, r2_key, docid, year, doctype, status, title_en, norm
     FROM documents WHERE id IN (${placeholders})${where ? ` AND ${where.replace(/^WHERE /, "")}` : ""}`,
  ).bind(...ids, ...bind).all<SearchHit>();

  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  const secondary = hits.flatMap((h) => {
    const row = byId.get(h.id);
    return row && !result.items.some((i) => i.id === row.id) ? [row] : [];
  });
  result.items = fuseRankings(result.items, secondary).slice(0, size);
  return result;
}

export async function searchDocuments(
  db: D1Database,
  params: SearchParams,
  opts: { scopeFlavor?: string } = {},
): Promise<SearchResult> {
  // The abstract column is populated by ingest (migration 0002); a LIKE
  // over it is a scan — tolerate missing column on pre-migration DBs.
  if (params.inAbstract) {
    try {
      await db.prepare("SELECT abstract FROM documents LIMIT 1").first();
    } catch {
      params = { ...params, inAbstract: false };
    }
  }
  // The component columns arrive with migration 0005; a filter against a
  // pre-migration database would be a syntax error, so drop the filters
  // (they cannot match anything there anyway) instead of failing the query.
  if (params.publisher || params.number || params.part || params.edition) {
    try {
      await db.prepare("SELECT publisher FROM documents LIMIT 1").first();
    } catch {
      params = { ...params, publisher: undefined, number: undefined, part: undefined, edition: undefined };
    }
  }
  const page = Math.max(0, params.page ?? 0);
  const size = Math.min(100, Math.max(10, params.size ?? 25));
  const useFts = params.q ? await ftsAvailable(db) : false;
  const { where, bind } = buildWhere(params, opts, useFts);
  const sort = params.sort ?? "relevance";

  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM documents ${where}`,
  ).bind(...bind).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  // Relevance ranks exact docid matches first, then docid prefixes —
  // "ISO 9001" must find ISO 9001:2015 above ISO 10017 (which sorts
  // before it alphabetically because "1" < "9").
  let order: string;
  const orderBind: unknown[] = [];
  if (sort === "relevance" && params.q) {
    order = `CASE WHEN docid = ? THEN 0 WHEN docid LIKE ? THEN 1 ELSE 2 END, year DESC, docid ASC`;
    orderBind.push(params.q, `${params.q}%`);
  } else {
    order = SORTS[sort] ?? "year DESC, docid ASC";
  }

  const { results } = await db.prepare(
    `SELECT id, flavor, r2_key, docid, year, doctype, status, title_en, norm
     FROM documents ${where} ORDER BY ${order} LIMIT ${size + 1} OFFSET ${page * size}`,
  ).bind(...bind, ...orderBind).all<SearchHit>();

  const rows = results ?? [];
  const items = rows.slice(0, size);

  // Facets are computed on the text/year-filtered set (independent of the
  // selected facet values) so counts stay meaningful while narrowing.
  const textOnly = buildWhere(
    { q: params.q, yearFrom: params.yearFrom, yearTo: params.yearTo },
    opts,
    useFts,
  );
  const facets: FacetCounts = {};
  if (!opts.scopeFlavor) facets.flavor = await facetFor(db, "flavor", textOnly);
  facets.doctype = await facetFor(db, "doctype", textOnly);
  facets.status = await facetFor(db, "status", textOnly);

  return {
    items,
    total,
    page,
    size,
    hasPrev: page > 0,
    hasNext: rows.length > size,
    facets,
  };
}
