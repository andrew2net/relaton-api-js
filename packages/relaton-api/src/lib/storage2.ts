// Storage v2 (TODO.api/02): the document unit is the model's JSON, read
// losslessly from documents_v2; the projection tables are mechanical views
// of that JSON and nothing here derives lookup keys — doc_keys carries the
// dataset-provided tokens verbatim.

export interface StorageV2Doc {
  key: string;
  flavor: string;
  file: string;
  data: Record<string, unknown>;
  indexedAt: string;
}

interface TitleEntry {
  content?: string | { content?: string };
  type?: string;
  language?: string[] | string;
}

interface DocidentifierEntry {
  content?: string;
  type?: string;
  primary?: boolean;
}

interface DateEntry {
  type?: string;
  on?: string;
  from?: string;
  to?: string;
}

interface ContributorEntry {
  organization?: { name?: string; abbreviation?: string };
  person?: { name?: { completename?: string } };
  role?: { type?: string }[] | string[];
}

interface RelationEntry {
  type?: string;
  bibitem?: { docidentifier?: { content?: string }[]; id?: string };
}

interface ClassificationEntry {
  type?: string;
  value?: string;
}

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Datasets carry nested-content shapes (`content: { content: ... }`) and
// plain strings interchangeably; every projection column is TEXT, so each
// extractor reads through to the scalar and answers null for anything
// else. The lossless JSON stays authoritative in documents_v2.
export function scalarText(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (entry && typeof entry === "object") {
    const content = (entry as { content?: unknown }).content;
    if (content !== undefined) return scalarText(content);
    const value = (entry as { value?: unknown }).value;
    if (typeof value === "string") return value;
    // Role entries carry their value under `type` ({ type: "publisher" }).
    const type = (entry as { type?: unknown }).type;
    if (type !== undefined && type !== null) {
      const text = scalarText(type);
      if (text !== null) return text;
    }
  }
  return null;
}

function titleText(t: TitleEntry): string {
  if (typeof t.content === "string") return t.content;
  if (typeof t.content === "object" && t.content !== null && typeof t.content.content === "string") {
    return t.content.content;
  }
  return "";
}

export function projectTitles(data: Record<string, unknown>): { lang: string | null; type: string | null; text: string }[] {
  const raw = data.title;
  const entries: TitleEntry[] = typeof raw === "string" ? [{ content: raw }] : arrayify(raw as TitleEntry | TitleEntry[]);
  return entries
    .map((t) => ({ lang: scalarText(arrayify(t.language)[0]), type: scalarText(t.type), text: titleText(t) }))
    .filter((t): t is { lang: string | null; type: string | null; text: string } => t.text !== "");
}

export function projectIdentifiers(data: Record<string, unknown>): { raw: string; type: string | null; isPrimary: number }[] {
  return arrayify(data.docidentifier as DocidentifierEntry | DocidentifierEntry[])
    .map((d) => ({ raw: scalarText(d.content), type: scalarText(d.type), isPrimary: d.primary === true ? 1 : 0 }))
    .filter((d): d is { raw: string; type: string | null; isPrimary: number } => d.raw !== null);
}

export function projectDates(data: Record<string, unknown>): { type: string | null; onDate: string | null }[] {
  return arrayify(data.date as DateEntry | DateEntry[])
    .map((d) => ({ type: scalarText(d.type), onDate: scalarText(d.on) ?? scalarText(d.from) ?? scalarText(d.to) }));
}

export function projectContributors(data: Record<string, unknown>): { role: string | null; name: string | null; orgAbbrev: string | null }[] {
  return arrayify(data.contributor as ContributorEntry | ContributorEntry[])
    .map((c) => {
      const roles = arrayify(c.role as unknown as ({ type?: string } | string)[]);
      const first = roles[0];
      return {
        role: scalarText(first),
        name: scalarText(c.organization?.name) ?? scalarText(c.person?.name?.completename),
        orgAbbrev: scalarText(c.organization?.abbreviation),
      };
    });
}

export function projectRelations(data: Record<string, unknown>): { type: string | null; target: string | null }[] {
  return arrayify(data.relation as RelationEntry | RelationEntry[])
    .map((r) => ({
      type: scalarText(r.type),
      target: scalarText(r.bibitem?.docidentifier?.[0]?.content) ?? scalarText((r.bibitem as { id?: unknown } | undefined)?.id),
    }));
}

export function projectClassifications(data: Record<string, unknown>): { type: string | null; value: string }[] {
  return arrayify(data.classification as ClassificationEntry | ClassificationEntry[])
    .map((c) => ({ type: scalarText(c.type), value: scalarText(c.value) }))
    .filter((c): c is { type: string | null; value: string } => c.value !== null);
}

export async function getDocument(db: D1Database, key: string): Promise<StorageV2Doc | null> {
  const row = await db
    .prepare("SELECT key, flavor, file, data, indexed_at FROM documents_v2 WHERE key = ?1")
    .bind(key)
    .first<{ key: string; flavor: string; file: string; data: string; indexed_at: string }>();
  if (!row) return null;
  return {
    key: row.key,
    flavor: row.flavor,
    file: row.file,
    data: JSON.parse(row.data) as Record<string, unknown>,
    indexedAt: row.indexed_at,
  };
}

export async function getDocumentByLookupKey(db: D1Database, key: string): Promise<StorageV2Doc | null> {
  const doc = await db
    .prepare(
      `SELECT d.key, d.flavor, d.file, d.data, d.indexed_at
       FROM documents_v2 AS d JOIN doc_keys AS k ON k.document = d.key
       WHERE k.key = ?1 ORDER BY d.key LIMIT 1`,
    )
    .bind(key)
    .first<{ key: string; flavor: string; file: string; data: string; indexed_at: string }>();
  if (!doc) return null;
  return {
    key: doc.key,
    flavor: doc.flavor,
    file: doc.file,
    data: JSON.parse(doc.data) as Record<string, unknown>,
    indexedAt: doc.indexed_at,
  };
}

export interface SearchFilters {
  cursor?: string | null;
  flavor?: string | null;
  year?: number | null;
  doctype?: string | null;
  status?: string | null;
  q?: string | null;
  title?: string | null;
  contributor?: string | null;
  relationType?: string | null;
  relationTarget?: string | null;
}

export interface SearchRow {
  key: string;
  flavor: string;
  file: string;
}

// One key-ordered page over documents_v2, filters hitting the projection
// tables — the single SQL the v3 REST collection and the GraphQL
// connection share. `cursor` is the last key served (inclusive-exclusive
// against the ORDER BY); the caller asks for limit+1 rows to detect
// hasNextPage.
export async function searchDocumentPages(
  db: D1Database,
  opts: SearchFilters & { limit: number },
): Promise<SearchRow[]> {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  const bind = (value: string | number): string => `?${binds.push(value)}`;

  if (opts.cursor) conditions.push(`d.key > ${bind(opts.cursor)}`);
  if (opts.flavor) conditions.push(`d.flavor = ${bind(opts.flavor)}`);
  if (opts.year) conditions.push(`EXISTS (SELECT 1 FROM dates t WHERE t.document = d.key AND t.on_date LIKE ${bind(`${opts.year}%`)})`);
  if (opts.doctype) conditions.push(`JSON_EXTRACT(d.data, '$.doctype') = ${bind(opts.doctype)}`);
  if (opts.status) conditions.push(`JSON_EXTRACT(d.data, '$.status.stage') = ${bind(opts.status)}`);
  if (opts.q) conditions.push(`EXISTS (SELECT 1 FROM titles t WHERE t.document = d.key AND t.text LIKE ${bind(`%${opts.q}%`)})`);
  if (opts.title) conditions.push(`EXISTS (SELECT 1 FROM titles t WHERE t.document = d.key AND t.text LIKE ${bind(`%${opts.title}%`)})`);
  if (opts.contributor) {
    conditions.push(
      `EXISTS (SELECT 1 FROM contributors c WHERE c.document = d.key AND (c.name LIKE ${bind(`%${opts.contributor}%`)} OR c.org_abbrev = ${bind(opts.contributor)}))`,
    );
  }
  if (opts.relationType || opts.relationTarget) {
    conditions.push(
      `EXISTS (SELECT 1 FROM relations r WHERE r.document = d.key
         AND (${opts.relationType ? `r.type = ${bind(opts.relationType)}` : "1"}
         AND ${opts.relationTarget ? `r.target LIKE ${bind(`%${opts.relationTarget}%`)}` : "1"}))`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT d.key, d.flavor, d.file FROM documents_v2 d ${where} ORDER BY d.key LIMIT ${bind(opts.limit + 1)}`)
    .bind(...binds)
    .all<SearchRow>();
  return results ?? [];
}

// Title (main, first) and primary docidentifier lookups for a page of keys.
export async function pageSummaries(
  db: D1Database,
  keys: string[],
): Promise<{ titleOf: Map<string, string>; primaryOf: Map<string, string> }> {
  if (!keys.length) return { titleOf: new Map(), primaryOf: new Map() };
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(",");

  const titles = await db
    .prepare(
      `SELECT document, text FROM titles WHERE document IN (${placeholders}) AND type = 'main' LIMIT 200`,
    )
    .bind(...keys)
    .all<{ document: string; text: string }>();
  const titleOf = new Map<string, string>();
  for (const t of titles.results ?? []) if (!titleOf.has(t.document)) titleOf.set(t.document, t.text);

  const primaries = await db
    .prepare(
      `SELECT document, raw FROM identifiers WHERE document IN (${placeholders}) AND is_primary = 1 LIMIT 200`,
    )
    .bind(...keys)
    .all<{ document: string; raw: string }>();
  return { titleOf, primaryOf: new Map(primaries.results?.map((r) => [r.document, r.raw])) };
}
