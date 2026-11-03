import { logoUrl } from "../lib/publishers";
import type { AppEnv } from "../env";
import { layout, escapeHtml } from "./ui/chrome";
import { STATUS_WORDS } from "./ui/record";
import * as v2 from "../lib/search2";

// Global pubid/keyword search across every flavor, with facets, sorting,
// and pagination. Server-rendered; the API surface is the /v3/documents
// collection (key-ordered, cursor-paged).

const CSS = `
  .search-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 28px; align-items: start; }
  @media (max-width: 900px) { .search-layout { grid-template-columns: minmax(0, 1fr); } }
  .search-bar { display: flex; gap: 8px; margin: 0 0 18px; }
  .search-bar input[name=q] {
    flex: 1; padding: 10px 14px; font-size: 15px; font-family: var(--mono);
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg);
  }
  .search-bar select { padding: 10px; font: 14px var(--font); border: 1px solid var(--border);
    border-radius: 8px; background: var(--bg); color: var(--fg); }
  .search-bar button { padding: 10px 18px; font: 14px var(--font); border: none; border-radius: 8px;
    background: var(--accent); color: #fff; cursor: pointer; }
  .component-row { display: flex; gap: 8px; margin: 0 0 18px; }
  .component-row input { flex: 1; min-width: 0; padding: 8px 10px; font: 13px var(--mono);
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); }
  .abstract-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-2); }
  .facet-card {
    border: 1px solid var(--border); border-radius: 10px; background: var(--bg-soft);
    padding: 10px 12px; margin-bottom: 10px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 26px -16px rgba(16, 24, 40, 0.12);
  }
  .facets h3 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin: 18px 0 6px; }
  .facet-link { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 13.5px;
    color: var(--fg-2); text-decoration: none; border-radius: 6px; }
  .facet-link:hover { background: var(--bg-mute); color: var(--fg); }
  .facet-link.on { background: var(--accent-soft); color: var(--accent); }
  .facet-link .n { color: var(--muted); font-variant-numeric: tabular-nums; }
  .results-info { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
  .collection-hero {
    border: 1px solid var(--border); border-radius: 16px; padding: 18px 22px 16px;
    margin: 0 0 16px; overflow: hidden;
    background:
      radial-gradient(120% 150% at 100% 0%, var(--accent-soft) 0%, transparent 55%),
      linear-gradient(180deg, var(--bg-soft) 0%, var(--bg) 100%);
  }
  .collection-hero h1 { margin: 0; display: flex; align-items: center; gap: 12px; }
  .collection-hero .meta { margin: 4px 0 0; }
  .coll-mark {
    flex: none; width: 46px; height: 46px; border: 1px solid var(--border); border-radius: 10px;
    background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .coll-mark .coll-logo { height: 30px; width: auto; margin: 0; }
  .result { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
  .result-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .result-docid { font-size: 15.5px; font-weight: 650; color: var(--accent); text-decoration: none; letter-spacing: 0.01em; }
  .result-docid:hover { text-decoration: underline; }
  .result-chip { background: var(--bg-mute); border: 1px solid var(--border); border-radius: 999px;
    padding: 1px 9px; font-size: 11.5px; color: var(--fg-2); }
  .result-chip.flavor { color: var(--accent); border-color: var(--accent-soft); }
  .result-title { margin: 5px 0 0; font-size: 14.5px; color: var(--fg-2); line-height: 1.45; }
  .result-logo {
    width: 22px; height: 22px; object-fit: contain; background: #fff; border-radius: 5px;
    padding: 1px; flex: none; align-self: center; margin-right: 2px;
  }
  .result-head { align-items: center; }
  .pager { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
  .pager a, .pager span { padding: 8px 14px; font-size: 13px; border: 1px solid var(--border);
    border-radius: 8px; text-decoration: none; color: var(--fg); background: var(--bg); }
  .pager .info { margin-right: auto; color: var(--muted); border: none; background: none; }
  .empty { color: var(--muted); padding: 32px 0; text-align: center; }
  .empty-state {
    border: 1px dashed var(--border); border-radius: 12px; background: var(--bg-soft);
    padding: 30px 24px; text-align: center; margin: 4px 0;
  }
  .empty-title { font-size: 16px; font-weight: 600; color: var(--fg); margin: 0 0 6px; }
  .empty-hint { color: var(--muted); font-size: 14px; margin: 0; }
  .empty-hint a { color: var(--accent); }
  .coll-logo { height: 34px; width: auto; vertical-align: middle; margin-right: 10px; }
`;

function facetHref(current: URLSearchParams, dimension: string, value: string): string {
  const params = new URLSearchParams(current);
  params.set(dimension, value);
  params.delete("page");
  return `/search?${params.toString()}`;
}

function clearHref(current: URLSearchParams, dimension: string): string {
  const params = new URLSearchParams(current);
  params.delete(dimension);
  params.delete("page");
  return `/search?${params.toString()}`;
}

function pageHref(current: URLSearchParams, page: number): string {
  const params = new URLSearchParams(current);
  if (page > 0) params.set("page", String(page)); else params.delete("page");
  return `/search?${params.toString()}`;
}

function parseParams(url: URL): v2.SearchParamsV2 {
  const num = (name: string): number | null => {
    const v = url.searchParams.get(name);
    return v && /^\d+$/.test(v) ? Number(v) : null;
  };
  // Without a text query there is no relevance to rank — publication
  // date is the meaningful default, and the selector says so.
  const sortRaw = url.searchParams.get("sort") ??
    (url.searchParams.get("q") ? "relevance" : "year_desc");
  const sort = (["relevance", "year_desc", "year_asc", "docid"] as const).includes(sortRaw as never)
    ? (sortRaw as v2.SearchParamsV2["sort"])
    : "relevance";
  return {
    q: url.searchParams.get("q")?.trim() || undefined,
    flavor: url.searchParams.get("flavor") || undefined,
    doctype: url.searchParams.get("doctype") || undefined,
    status: url.searchParams.get("status") || undefined,
    publisher: url.searchParams.get("publisher")?.trim() || undefined,
    number: url.searchParams.get("number")?.trim() || undefined,
    part: url.searchParams.get("part")?.trim() || undefined,
    edition: url.searchParams.get("edition")?.trim() || undefined,
    inAbstract: url.searchParams.get("abstract") === "1",
    semantic: url.searchParams.get("semantic") === "1",
    yearFrom: num("yearFrom"),
    yearTo: num("yearTo"),
    sort,
    page: num("page") ?? 0,
    size: num("size") ?? 25,
  };
}

function renderFacet(
  params: URLSearchParams,
  dimension: string,
  selected: string | undefined,
  counts: { value: string; count: number }[] | undefined,
): string {
  if (!counts?.length) return "";
  const links = counts.map((f) => {
    const on = selected === f.value;
    return `<a class="facet-link${on ? " on" : ""}" href="${on ? clearHref(params, dimension) : facetHref(params, dimension, escapeHtml(f.value))}">
      <span>${escapeHtml(f.value)}${on ? " ✕" : ""}</span><span class="n">${f.count.toLocaleString("en-US")}</span></a>`;
  }).join("");
  return `<div class="facet-card"><h3>${dimension}</h3>${links}</div>`;
}

interface RenderItem {
  docid: string | null;
  flavor: string;
  entryKey: string;
  title: string | null;
  year: number | null;
  doctype: string | null;
  status: string | null;
}

function renderItemsOf(items: v2.SearchHitV2[]): RenderItem[] {
  return items.map((d) => ({
    docid: d.docid,
    flavor: d.flavor,
    entryKey: v2.entryKeyOf(d.file),
    title: d.title,
    year: d.year,
    doctype: d.doctype,
    status: d.status,
  }));
}

function renderResults(items: RenderItem[], collection: string | undefined, query: string): string {
  if (items.length === 0) {
    const where = collection ? ` in ${escapeHtml(collection)}` : "";
    return `<div class="empty-state">
      <p class="empty-title">No records match${where}.</p>
      <p class="empty-hint">Try the identifier without the year (ISO 9001 finds every edition), or
      ${collection
        ? `<a href="/search?q=${encodeURIComponent(query)}">search all collections</a> instead.`
        : `browse the <a href="/collections">collections</a>.`}</p>
    </div>`;
  }
  return items.map((d) => {
    const href = `/collections/${escapeHtml(d.flavor)}/entries/${encodeURIComponent(d.entryKey)}`;
    // Status vocabularies are publisher-specific; translate the opaque
    // codes, pass everything else through verbatim.
    const statusWord = d.status ? (STATUS_WORDS[d.status] ?? d.status) : "";
    const chips = [
      `<span class="result-chip flavor">${escapeHtml(d.flavor)}</span>`,
      d.doctype ? `<span class="result-chip">${escapeHtml(d.doctype)}</span>` : "",
      statusWord ? `<span class="result-chip">${escapeHtml(statusWord)}</span>` : "",
      d.year ? `<span class="result-chip">${escapeHtml(String(d.year))}</span>` : "",
    ].filter(Boolean).join("");
    return `<div class="result">
      <div class="result-head">
        ${logoUrl(d.flavor) ? `<img class="result-logo" src="${logoUrl(d.flavor)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <a class="result-docid" href="${href}">${escapeHtml(d.docid ?? d.entryKey)}</a>
        ${chips}
      </div>
      ${d.title ? `<p class="result-title">${escapeHtml(d.title)}</p>` : ""}
    </div>`;
  }).join("");
}

function renderPager(r: v2.SearchResultV2, params: URLSearchParams): string {
  const info = `${(r.total).toLocaleString("en-US")} results · page ${r.page + 1}`;
  return `<div class="pager">
    ${r.hasPrev ? `<a href="${pageHref(params, r.page - 1)}">&larr; Previous</a>` : "<span></span>"}
    <span class="info">${info}</span>
    ${r.hasNext ? `<a href="${pageHref(params, r.page + 1)}">Next &rarr;</a>` : "<span></span>"}
  </div>`;
}

export interface SearchPageOptions {
  scopeFlavor?: string;
  title?: string;
  activeNav?: string;
}

export async function renderSearchPage(
  env: AppEnv["Bindings"],
  db: D1Database,
  url: URL,
  opts: SearchPageOptions = {},
): Promise<string> {
  const params = parseParams(url);
  const result = await v2.hybridSearch(db, env as never, params, { scopeFlavor: opts.scopeFlavor });
  const items = renderItemsOf(result.items);
  const qs = new URLSearchParams(url.searchParams);
  qs.delete("page");

  const action = opts.scopeFlavor ? `/collections/${escapeHtml(opts.scopeFlavor)}` : "/search";
  const facetHtml = opts.scopeFlavor
    ? renderFacet(qs, "doctype", params.doctype, result.facets.doctype) +
      renderFacet(qs, "status", params.status, result.facets.status)
    : renderFacet(qs, "flavor", params.flavor, result.facets.flavor) +
      renderFacet(qs, "doctype", params.doctype, result.facets.doctype) +
      renderFacet(qs, "status", params.status, result.facets.status);

  const hidden = opts.scopeFlavor ? `<input type="hidden" name="flavor" value="${escapeHtml(opts.scopeFlavor)}">` : "";
  const logoSrc = opts.scopeFlavor && /^[a-z0-9-]+$/.test(opts.scopeFlavor)
    ? logoUrl(opts.scopeFlavor)
    : null;
  const scopeMeta = opts.scopeFlavor
    ? `<p class="meta"><a href="/collections/${escapeHtml(opts.scopeFlavor)}/manifest">manifest.json</a> ·
<a href="/collections">all collections</a> ·
<a href="/create">create a custom record</a></p>`
    : "";

  const body = `
<div class="collection-hero">
<h1>${logoSrc ? `<a class="coll-mark" href="/collections/${escapeHtml(opts.scopeFlavor ?? "")}"><img class="coll-logo" src="${logoSrc}" alt="" onerror="this.remove()"></a>` : ""}${opts.title ?? "Search"}</h1>
${scopeMeta}
</div>
<form class="search-bar" method="get" action="${action}">
  <input name="q" value="${escapeHtml(params.q ?? "")}" placeholder="Publication identifier or title — e.g. ISO 19115, TLS, risk assessment…" aria-label="Search">
  <label class="abstract-toggle"><input type="checkbox" name="abstract" value="1"${params.inAbstract ? " checked" : ""}> search abstracts</label>
  <label class="abstract-toggle"><input type="checkbox" name="semantic" value="1"${params.semantic ? " checked" : ""}> semantic</label>
  <select name="yearFrom" aria-label="Year from">
    <option value="">any year</option>
    ${Array.from({ length: 8 }, (_, i) => 2026 - i * 5).map((y) =>
      `<option value="${y}"${params.yearFrom === y ? " selected" : ""}>${y}+</option>`).join("")}
  </select>
  <select name="sort" aria-label="Sort">
    <option value="year_desc"${params.sort === "year_desc" ? " selected" : ""}>Newest first</option>
    <option value="year_asc"${params.sort === "year_asc" ? " selected" : ""}>Oldest first</option>
    <option value="relevance"${params.sort === "relevance" ? " selected" : ""}>Relevance</option>
    <option value="docid"${params.sort === "docid" ? " selected" : ""}>Identifier</option>
  </select>
<div class="component-row">
  <input name="publisher" value="${escapeHtml(params.publisher ?? "")}" placeholder="Publisher — ISO, IEEE…" aria-label="Publisher">
  <input name="number" value="${escapeHtml(params.number ?? "")}" placeholder="Number — 9001, 802.3…" aria-label="Document number">
  <input name="part" value="${escapeHtml(params.part ?? "")}" placeholder="Part" aria-label="Part">
  <input name="edition" value="${escapeHtml(params.edition ?? "")}" placeholder="Edition" aria-label="Edition">
</div>
  ${hidden}
  <button type="submit">Search</button>
</form>

<div class="search-layout">
  <aside class="facets">
    ${facetHtml || `<p class="empty" style="padding:8px 0">No facets</p>`}
  </aside>
  <div>
    <p class="results-info">${result.total.toLocaleString("en-US")} documents</p>
    ${renderResults(items, opts.scopeFlavor, params.q ?? "")}
    ${renderPager(result, qs)}
  </div>
</div>`;

  return layout({
    title: `${opts.title ?? "Search"} — Relaton API`,
    activeNav: opts.activeNav ?? "search",
    css: CSS,
    body,
  });
}

