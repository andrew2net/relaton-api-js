import { logoUrl, publisherOf } from "../lib/publishers";
import type { AppEnv } from "../env";
import { layout, escapeHtml } from "./ui/chrome";
import { renderRecordPage, RECORD_CSS } from "./ui/record";
import * as v2 from "../lib/search2";

// Browsable web UI for the lutaml cloud store. Every page is server-rendered
// HTML served by the same routes that answer JSON to API clients — the
// content type follows the request's Accept header, never a different URL.

interface FlavorRowV1 {
  flavor: string;
  doc_count: number;
  last_modified: string | null;
  ingested_at: string;
}

interface EntryRow {
  docid: string | null;
  r2_key: string;
}


// Publisher logos come from relaton.org's per-flavor set
// (https://www.relaton.org — public/logos). A few flavors ship as PNG.
function logoSrc(flavor: string): string | null {
  return logoUrl(flavor);
}

function logoImg(flavor: string): string {
  const src = logoSrc(flavor);
  if (!src) return "";
  return `<img class="coll-logo" src="${src}" alt="" loading="lazy" onerror="this.remove()">`;
}

const PAGE_SIZE = 50;

const CSS = `
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 13px; font-weight: 600; }
  td a { color: var(--accent); text-decoration: none; font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
  td a:hover { text-decoration: underline; }
  .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  .coll-cell { display: inline-flex; align-items: center; gap: 10px; }
  .coll-logo { width: 34px; height: 34px; object-fit: contain; }
  .toolbar { display: flex; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }
  .toolbar input {
    flex: 1; min-width: 220px; padding: 10px 12px; font-size: 15px; font-family: var(--mono);
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg);
  }
  .toolbar button, .pager a, .pager span {
    padding: 10px 16px; font-size: 14px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); text-decoration: none;
  }
  .toolbar button { background: var(--accent); border-color: var(--accent); color: #fff; cursor: pointer; }
  .pager { display: flex; gap: 8px; margin-top: 18px; align-items: center; }
  .pager .info { color: var(--muted); font-size: 13px; margin-right: auto; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .tab-btn {
    padding: 10px 16px; font-size: 14px; font-weight: 500; font-family: var(--font);
    border: none; background: none; color: var(--muted); cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tab-btn:hover { color: var(--fg); }
  .tab-btn[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-btn code { font-family: var(--mono); font-size: 13px; }
  .panes > pre { border-radius: 0 0 8px 8px; border-top: none; }
`;

export function wantsHtml(accept: string | undefined): boolean {
  return (accept ?? "").includes("text/html");
}

/** Browsable list of collections. */
export async function renderCollections(db: D1Database): Promise<string> {
  const flavors = (await v2.searchReady(db))
    ? (await v2.listFlavors(db)).map((f) => ({ flavor: f.flavor, doc_count: f.doc_count, last_modified: f.last_modified }))
    : ((await db.prepare(
      "SELECT flavor, doc_count, last_modified FROM flavors ORDER BY flavor",
    ).all<FlavorRowV1>()).results ?? []);

  const rows = flavors
    .map((f) => {
      const updated = f.last_modified ?? "";
      const publisher = publisherOf(f.flavor);
      const publisherCell = publisher.name !== f.flavor ? escapeHtml(publisher.name) : "";
      return `<tr><td><span class="coll-cell">${logoImg(f.flavor)}<a href="/collections/${escapeHtml(f.flavor)}">${escapeHtml(f.flavor)}</a></span></td>` +
        `<td>${publisherCell}</td>` +
        `<td class="num">${f.doc_count.toLocaleString("en-US")}</td>` +
        `<td class="num">${escapeHtml(updated.slice(0, 10))}</td></tr>`;
    })
    .join("\n");

  return layout({
    title: "Collections — Relaton API",
    activeNav: "collections",
    css: CSS,
    body: `<h1>Collections</h1>
<p class="sub">${flavors.length.toLocaleString("en-US")} collections ·
each is a lutaml data repository: <code>manifest</code> lists its records,
<code>entries/{key}</code> serves one.</p>
<table>
<thead><tr><th>Collection</th><th>Publisher</th><th class="num">Records</th><th class="num">Updated</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
  });
}

/**
 * Entry keys mirror the repo layout (data/…). URLs may carry the bare or
 * the prefixed form — resolve both. The v2 projection stores the dataset
 * file; its R2 blob key is derived, keeping the same address space.
 */
export async function findEntryRow(
  db: D1Database,
  collection: string,
  key: string,
): Promise<EntryRow | null> {
  if (await v2.searchReady(db)) {
    const row = await v2.findEntryRow(db, collection, key);
    if (!row) return null;
    return { docid: row.docid, r2_key: v2.blobKeyOf(collection, row.file) };
  }
  const storageKey = key.startsWith("data/") ? key : `data/${key}`;
  return db.prepare(
    "SELECT docid, r2_key FROM documents WHERE flavor = ? AND r2_key IN (?, ?)",
  ).bind(collection, `${collection}/${key}`, `${collection}/${storageKey}`).first<EntryRow>();
}

/**
 * A single record, framed for a browser: human-readable overview plus the
 * serializations, rendered by ui/record.ts on top of relaton-ts. Raw bytes
 * stay one click away.
 */
export async function renderEntry(
  db: D1Database,
  collection: string,
  key: string,
  rawRequested: boolean,
  fetchObject: (r2Key: string) => Promise<{ text(): Promise<string> } | null>,
): Promise<{ html: string } | { body: string; contentType: string } | null> {
  const row = await findEntryRow(db, collection, key);
  if (!row) return null;

  const obj = await fetchObject(row.r2_key);
  if (!obj) return null;
  const body = await obj.text();

  if (rawRequested) {
    const contentType = key.endsWith(".json")
      ? "application/json"
      : key.endsWith(".xml") ? "text/xml" : "application/yaml";
    return { body, contentType };
  }

  const docid = row.docid ?? key;
  const page = renderRecordPage({ collection, key, docid, body });
  return {
    html: layout({
      title: `${docid} — Relaton API`,
      activeNav: "collections",
      css: CSS + RECORD_CSS,
      head: page.head,
      body: page.body,
    }),
  };
}

export type { AppEnv };
