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
    .map((t) => ({ lang: arrayify(t.language)[0] ?? null, type: t.type ?? null, text: titleText(t) }))
    .filter((t) => t.text !== "");
}

export function projectIdentifiers(data: Record<string, unknown>): { raw: string; type: string | null; isPrimary: number }[] {
  return arrayify(data.docidentifier as DocidentifierEntry | DocidentifierEntry[])
    .filter((d) => typeof d.content === "string")
    .map((d) => ({ raw: d.content!, type: d.type ?? null, isPrimary: d.primary === true ? 1 : 0 }));
}

export function projectDates(data: Record<string, unknown>): { type: string | null; onDate: string | null }[] {
  return arrayify(data.date as DateEntry | DateEntry[])
    .map((d) => ({ type: d.type ?? null, onDate: d.on ?? d.from ?? d.to ?? null }));
}

export function projectContributors(data: Record<string, unknown>): { role: string | null; name: string | null; orgAbbrev: string | null }[] {
  return arrayify(data.contributor as ContributorEntry | ContributorEntry[])
    .map((c) => {
      const roles = arrayify(c.role as unknown as ({ type?: string } | string)[]);
      const first = roles[0];
      const role = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type ?? null;
      return {
        role,
        name: c.organization?.name ?? c.person?.name?.completename ?? null,
        orgAbbrev: c.organization?.abbreviation ?? null,
      };
    });
}

export function projectRelations(data: Record<string, unknown>): { type: string | null; target: string | null }[] {
  return arrayify(data.relation as RelationEntry | RelationEntry[])
    .map((r) => ({
      type: r.type ?? null,
      target: r.bibitem?.docidentifier?.[0]?.content ?? r.bibitem?.id ?? null,
    }));
}

export function projectClassifications(data: Record<string, unknown>): { type: string | null; value: string }[] {
  return arrayify(data.classification as ClassificationEntry | ClassificationEntry[])
    .filter((c) => typeof c.value === "string")
    .map((c) => ({ type: c.type ?? null, value: c.value! }));
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
