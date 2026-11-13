// The record page: a human-readable overview first, then the serializations.
// The overview renders the record (converted to the Relaton YAML shape by
// lib/bibdata) with field labels linking to the model documentation on
// relaton.org so users learn what each field means in place.

import { logoUrl } from "../../lib/publishers";
import { escapeHtml } from "./chrome";
import { fromXml, toXml, toAsciiBib, slugAnchor, toYaml, toIso690, toChicago, toApa, toBibtex, toRis, toCslJson } from "relaton";
import { highlightXml, highlightYaml } from "../../lib/highlight";

// Field → relaton.org model documentation page
const FIELD_DOCS: Record<string, string> = {
  title: "/model/title",
  docid: "/model/identifiers",
  date: "/model/production",
  contributor: "/model/contributor",
  relation: "/model/relations",
  edition: "/model/edition",
  series: "/model/series",
  type: "/model/bibtype",
  link: "/model/location",
  abstract: "/model/additional-info",
  keyword: "/model/additional-info",
  copyright: "/model/additional-info",
  status: "/model/production",
  language: "/model/serializations",
  script: "/model/serializations",
};

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function contentOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    const c = (value as Record<string, unknown>).content;
    if (typeof c === "string") return c;
    if (typeof c === "number") return String(c);
  }
  return "";
}

function fieldLabel(field: string, text: string): string {
  const href = FIELD_DOCS[field];
  const label = escapeHtml(text);
  return href
    ? `<a class="ov-label" href="https://www.relaton.org${href}" target="_blank" rel="noopener" title="What does this field mean?">${label} ↗</a>`
    : `<span class="ov-label">${label}</span>`;
}

function section(field: string, title: string, rowsHtml: string): string {
  if (!rowsHtml.trim()) return "";
  return `<section class="ov-section">
<h3>${fieldLabel(field, title)}</h3>
${rowsHtml}
</section>`;
}

// Each publisher speaks its own status vocabulary (ISO stage codes, RFC
// states, BSI current/withdrawn, ...). Codes known to be opaque get a
// reader-friendly form; every other value renders verbatim.
export const STATUS_WORDS: Record<string, string> = {
  "60.60": "Published", "60.00": "Published", "50.00": "Final draft",
  "50.20": "Final draft", "40.00": "Draft", "40.20": "Draft",
  "90.92": "Withdrawn", "90.93": "Withdrawn", "95.99": "Withdrawn",
  "90.60": "Under review", "60.98": "Cancelled",
};
const STATUS_CLASS: Record<string, string> = {
  Published: "ok", "Final draft": "warn", Draft: "warn", "Under review": "warn",
  Withdrawn: "bad", Cancelled: "bad",
};

const LANG_NAMES: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ru: "Russian", ar: "Arabic",
  pt: "Portuguese", nl: "Dutch", sv: "Swedish", no: "Norwegian", da: "Danish",
  fi: "Finnish", pl: "Polish", cs: "Czech", tr: "Turkish", hu: "Hungarian",
  el: "Greek", he: "Hebrew", th: "Thai", vi: "Vietnamese", uk: "Ukrainian",
  ro: "Romanian", bg: "Bulgarian", hr: "Croatian", sk: "Slovak", sl: "Slovenian",
  et: "Estonian", lv: "Latvian", lt: "Lithuanian", sr: "Serbian", id: "Indonesian",
  ms: "Malay", fa: "Persian", hi: "Hindi", bn: "Bengali", la: "Latin",
};
const langName = (code: string): string =>
  LANG_NAMES[code.toLowerCase()] ?? (code ? code.toUpperCase() : "");

const ID_TYPE_LABELS: Record<string, string> = {
  "iso-undated": "ISO (undated)", "iso-reference": "ISO (reference)",
  "iso-tc": "ISO (TC)", ISSN: "ISSN", ISBN: "ISBN", URN: "URN", DOI: "DOI",
};

/**
 * The reading header: status, the standard's own number, and its titles —
 * every language equal, none a translation. Monospace never appears here;
 * it belongs to copy targets only.
 */
/** The record's call number and primary-language title — shared by the
 * page header and the meta tags, so previews always match the page. */
function recordHeading(record: Record<string, unknown>): { docid: string; title: string } {
  const docids = asArray(record.docidentifier as unknown[]);
  const pick = docids.find((d) =>
    typeof d === "object" && d !== null && (d as Record<string, unknown>).primary === true);
  const first = (pick ?? docids[0]) as Record<string, unknown> | undefined;
  const docid = first ? (contentOf(first) || (typeof first === "string" ? first : "")) : "";

  type TitleSlots = { intro: string; main: string; part: string; composite: string };
  const byLang = new Map<string, TitleSlots>();
  for (const item of asArray(record.title as unknown[])) {
    const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const text = contentOf(item);
    if (!text) continue;
    const lang = typeof obj.language === "string" ? obj.language.toLowerCase() : "";
    const slot = byLang.get(lang) ?? { intro: "", main: "", part: "", composite: "" };
    if (obj.type === "title-intro") slot.intro ||= text;
    else if (obj.type === "title-part") slot.part ||= text;
    else if (obj.type === "main") slot.composite ||= text;
    else slot.main ||= text;
    byLang.set(lang, slot);
  }
  const compose = (s: TitleSlots): string =>
    [s.intro, s.main].filter(Boolean).join(" — ") || s.composite;
  const langs = [...byLang.keys()];
  const headingLang = langs.includes("en") ? "en" : langs[0] ?? "";
  const title = byLang.has(headingLang) ? compose(byLang.get(headingLang)!) : "";
  return { docid, title };
}

function renderRecordHead(record: Record<string, unknown>, familyQuery: string, collection: string): string {
  const type = typeof record.type === "string" ? record.type : "";
  const typeLabel = type ? type.replace(/(^|[\s_-])(\p{L})/gu, (m, s, c) => s + c.toUpperCase()) : "";

  let statusLabel = "";
  const status = record.status as Record<string, unknown> | undefined;
  if (typeof status === "object" && status !== null) {
    const stage = contentOf(status.stage);
    const substage = contentOf(status.substage);
    const code = stage && substage ? `${stage}.${substage}` : stage || substage;
    if (code) statusLabel = STATUS_WORDS[code] ?? code;
  }
  const statusPill = statusLabel
    ? `<span class="status-pill status-${STATUS_CLASS[statusLabel] ?? "neutral"}"><span class="dot"></span>${escapeHtml(statusLabel)}</span>`
    : "";
  const typeChip = typeLabel ? `<span class="type-chip">${escapeHtml(typeLabel)}</span>` : "";

  const { docid: headingDocid, title: headingTitle } = recordHeading(record);

  type TitleSlots = { intro: string; main: string; part: string; composite: string };
  const titlesByLang = new Map<string, TitleSlots>();
  for (const t of asArray(record.title as unknown[])) {
    const obj = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const text = contentOf(t);
    if (!text) continue;
    const lang = typeof obj.language === "string" ? obj.language.toLowerCase() : "";
    const slot = titlesByLang.get(lang) ?? { intro: "", main: "", part: "", composite: "" };
    if (obj.type === "title-intro") slot.intro ||= text;
    else if (obj.type === "title-part") slot.part ||= text;
    else if (obj.type === "main") slot.composite ||= text;
    else slot.main ||= text;
    titlesByLang.set(lang, slot);
  }
  const composedOf = (s: TitleSlots): string => {
    const base = [s.intro, s.main].filter(Boolean).join(" — ") || s.composite;
    return [base, s.part].filter(Boolean).join(" — ");
  };
  const langs = [...titlesByLang.keys()];
  const headingLang = langs.includes("en") ? "en" : langs[0] ?? "";
  const otherTitleRows = langs
    .filter((l) => l !== headingLang)
    .map((l) => {
      const title = composedOf(titlesByLang.get(l)!);
      if (!title || title === headingTitle) return "";
      return `<div class="title-row"><span class="title-lang">${escapeHtml(langName(l))}</span><span class="title-text">${escapeHtml(title)}</span></div>`;
    })
    .join("");

  // The publisher's mark belongs on the card, like a letterhead; the
  // logo resolves through the publisher mapping (itu-r shares ITU's).
  const markSrc = logoUrl(collection);
  const publisherMark = markSrc
    ? `<a class="publisher-mark" href="/collections/${encodeURIComponent(collection)}" title="${escapeHtml(collection)} collection"><img src="${markSrc}" alt="${escapeHtml(collection)}" loading="lazy" onerror="this.parentElement.remove()"></a>`
    : "";

  return `
<div class="record-head">
${publisherMark}
<div class="record-head-main">
<div class="record-eyebrow">${statusPill}${typeChip}</div>
${headingDocid ? `<p class="doc-number">${escapeHtml(headingDocid)}</p>` : ""}
${headingTitle ? `<h1 class="doc-h1">${escapeHtml(headingTitle)}</h1>` : ""}
${otherTitleRows ? `<div class="title-parallel">${otherTitleRows}</div>` : ""}
${familyQuery ? `<a class="series-link" href="/collections/${escapeHtml(collection)}?q=${encodeURIComponent(familyQuery)}">More in the ${escapeHtml(familyQuery)} series</a>` : ""}
</div>
</div>`;
}

function renderOverview(record: Record<string, unknown>): string {
  // The record reads as a catalogue card: a language-neutral call number
  // heads it, and every field — title languages included — is an equally
  // weighted, labeled row. Standards are multilingual by institution;
  // no language is a "translation" of another.
  const type = typeof record.type === "string" ? record.type : "";
  const docids = asArray(record.docidentifier as unknown[]);

  // Identifiers: labeled rows keyed by the identifier type; DOIs resolve.
  const identifierRows = docids.map((d) => {
    const obj = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    const id = contentOf(obj) || (typeof d === "string" ? d : "");
    if (!id) return "";
    const rawIdType = typeof obj.type === "string" ? obj.type : "";
    const idType = ID_TYPE_LABELS[rawIdType] ?? rawIdType;
    const isDoi = idType === "DOI" || /^10\.\d+\//.test(id);
    const value = isDoi
      ? `<a href="https://doi.org/${encodeURIComponent(id)}" target="_blank" rel="noopener">${escapeHtml(id)} ↗</a>`
      : escapeHtml(id);
    const primary = obj.primary === true ? ` <span class="row-note">primary</span>` : "";
    const copy = `<button type="button" class="icon-btn" data-copy-text="${escapeHtml(id)}" title="Copy ${escapeHtml(idType || "identifier")}" aria-label="Copy ${escapeHtml(idType || "identifier")}"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg></button>`;
    return `<div class="ov-row"><span class="ov-key">${escapeHtml(idType || "Identifier")}</span><span class="ov-value">${value}${primary}</span>${copy}</div>`;
  }).join("");

  // Record facts as labeled fields — never as tags.
  const facts: [string, string][] = [];
  if (type) facts.push(["Type", type.replace(/(^|[\s_-])(\p{L})/gu, (m, s, c) => s + c.toUpperCase())]);
  const edition = contentOf(record.edition);
  if (edition) facts.push(["Edition", edition]);
  const langList = asArray(record.language).map(String).map(langName).filter(Boolean).join(", ");
  if (langList) facts.push(["Languages", langList]);
  const factRows = facts
    .map(([k, v]) => `<div class="ov-row"><span class="ov-key">${escapeHtml(k)}</span><span class="ov-value">${escapeHtml(v)}</span></div>`)
    .join("");

  const dates = asArray(record.date as unknown[]).map((d) => {
    const obj = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    const DATE_LABELS: Record<string, string> = {
      published: "Published", issued: "Published", created: "Created", updated: "Updated",
      obsoleted: "Obsoleted", confirmed: "Confirmed", corrected: "Corrected",
      amended: "Amended", accessed: "Accessed", implemented: "Implemented",
      transmitted: "Transmitted", circulated: "Circulated", adapted: "Adapted",
      announced: "Announced", "vote-started": "Vote started", "vote-ended": "Vote ended",
      "stable-until": "Stable until", copied: "Copied", unchanged: "Unchanged",
    };
    const typeAttr = typeof obj.type === "string"
      ? (DATE_LABELS[obj.type] ?? obj.type.replace(/^./, (c) => c.toUpperCase()))
      : "Date";
    const value = contentOf(obj.at);
    const from = contentOf(obj.from);
    const to = contentOf(obj.to);
    const when = value || (from && to ? `${from} – ${to}` : from || to);
    if (!when) return "";
    return `<div class="ov-row"><span class="ov-key">${typeAttr}</span><span>${escapeHtml(when)}</span></div>`;
  }).join("");

  const contributors = asArray(record.contributor as unknown[]).map((c) => {
    const obj = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const role = obj.role;
    const rawRole = Array.isArray(role) ? contentOf(role[0]) : contentOf(role);
    const ROLE_LABELS: Record<string, string> = {
      publisher: "Published by", author: "Written by", performer: "Performed by",
      editor: "Edited by", translator: "Translated by", distributor: "Distributed by",
    };
    const roleLabel = ROLE_LABELS[rawRole] ?? rawRole.replace(/^./, (c) => c.toUpperCase());
    const org = obj.organization as Record<string, unknown> | undefined;
    const person = obj.person as Record<string, unknown> | undefined;
    let name = "";
    if (typeof org === "object" && org !== null) {
      name = contentOf(org.name) || contentOf(org.abbreviation);
      const abbr = contentOf(org.abbreviation);
      if (abbr && name !== abbr) name = `${name} (${abbr})`;
    } else if (typeof person === "object" && person !== null) {
      const personName = person.name as Record<string, unknown> | undefined;
      name = contentOf(personName?.completename) ||
        [contentOf(personName?.given), contentOf(personName?.surname)].filter(Boolean).join(" ");
    }
    if (!name) return "";
    return `<div class="ov-row"><span class="ov-key">${escapeHtml(roleLabel || "Contributor")}</span><span>${escapeHtml(name)}</span></div>`;
  });
  const seenContrib = new Set<string>();
  const contributorsHtml = contributors.filter((row) => {
    const key = row.replace(/<[^>]+>/g, "");
    if (seenContrib.has(key)) return false;
    seenContrib.add(key);
    return true;
  }).join("");

  const links = asArray(record.source as unknown[]).map((l) => {
    const obj = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
    const url = contentOf(l);
    const SOURCE_LABELS: Record<string, string> = {
      src: "Source", obp: "Online browsing", rss: "RSS feed", doi: "DOI",
      git: "Repository", email: "Email", uri: "URI", issn: "ISSN", isbn: "ISBN",
    };
    if (!url || !/^https?:\/\//.test(url)) return "";
    const sourceType = typeof obj.type === "string" ? obj.type : "";
    const label = SOURCE_LABELS[sourceType] ?? "Link";
    const host = new URL(url).host.replace(/^www\./, "");
    return `<div class="ov-row"><span class="ov-key">${escapeHtml(label)}</span><span><a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}">${escapeHtml(host)}</a></span></div>`;
  }).join("");

  const abstracts = asArray(record.abstract as unknown[]).map((a) => {
    const text = contentOf(a);
    if (!text) return "";
    // NOTE entries render as separate lines (they are list items in the source)
    const html = text
      .split(/(?=NOTE\s+\d)/g)
      .map((seg) => seg.trim())
      .filter(Boolean)
      .map((seg) => `<p${/^NOTE\s+\d/.test(seg) ? ' class="note"' : ""}>${escapeHtml(seg)}</p>`)
      .join("");
    return html || `<p>${escapeHtml(text)}</p>`;
  }).join("");

  const keywords = asArray(record.keyword as unknown[]).map((k) => {
    const obj = (typeof k === "object" && k !== null ? k : {}) as Record<string, unknown>;
    const vocab = obj.vocab as Record<string, unknown> | undefined;
    const text = typeof k === "string" ? k : contentOf(vocab);
    return text ? `<span class="chip">${escapeHtml(text)}</span>` : "";
  }).join("");

  const relations = asArray(record.relation as unknown[]).map((r) => {
    const obj = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const RELATION_LABELS: Record<string, string> = {
      obsoletes: "Obsoletes", obsoletedBy: "Obsoleted by",
      supersedes: "Supersedes", supersededBy: "Superseded by",
      updates: "Updates", updatedBy: "Updated by",
      amends: "Amends", amendedBy: "Amended by",
      corrects: "Corrects", correctedBy: "Corrected by",
      replaces: "Replaces", replacedBy: "Replaced by",
      cites: "Cites", isCitedIn: "Cited in",
      isDescribedIn: "Described in", describes: "Describes",
      hasPart: "Has part", partOf: "Part of",
      includes: "Includes", includedIn: "Included in",
      successorOf: "Successor of", adaptedFrom: "Adapted from",
      hasAdaptation: "Has adaptation", adoptedFrom: "Adopted from",
      adoptedAs: "Adopted as", reviewOf: "Review of", hasReview: "Has review",
      commentaryOf: "Commentary on", hasCommentary: "Has commentary",
      hasComplement: "Has complement", complementOf: "Complement of",
      related: "Related to", instanceOf: "Instance of", hasInstance: "Has instance",
      manifestationOf: "Manifestation of", excerptOf: "Excerpt of", hasExcerpt: "Has excerpt",
    };
    const rawType = typeof obj.type === "string" ? obj.type : "";
    const typeAttr = rawType
      ? escapeHtml(RELATION_LABELS[rawType] ??
        rawType.replace(/[-_](.)/g, (_, c) => ` ${c.toUpperCase()}`).replace(/^./, (c) => c.toUpperCase()))
      : "Related";
    // Relations are a graph: this record either acts on another (→) or is
    // acted on by it (←).
    const PASSIVE = new Set([
      "obsoletedBy", "supersededBy", "updatedBy", "amendedBy", "correctedBy", "replacedBy",
      "isCitedIn", "isDescribedIn", "partOf", "includedIn", "adaptedFrom", "adoptedFrom",
      "successorOf", "complementOf", "instanceOf", "manifestationOf", "excerptOf",
    ]);
    const arrow = PASSIVE.has(rawType)
      ? `<span class="rel-arrow back" aria-hidden="true">←</span>`
      : `<span class="rel-arrow" aria-hidden="true">→</span>`;
    const bibitem = obj.bibitem as Record<string, unknown> | undefined;
    const relatedDocid = asArray(bibitem?.docidentifier as unknown[])
      .map((d) => contentOf(typeof d === "object" && d !== null ? (d as Record<string, unknown>).content : d))
      .find(Boolean);
    const ref = contentOf(bibitem?.formattedref) || relatedDocid ||
      contentOf(Array.isArray(bibitem?.title) ? bibitem.title[0] : bibitem?.title);
    if (!ref) return "";
    const target = relatedDocid
      ? `<a href="/search?q=${encodeURIComponent(relatedDocid)}" title="Open this document">${escapeHtml(ref)} ↗</a>`
      : escapeHtml(ref);
    return `<div class="ov-row"><span class="ov-key">${typeAttr}</span><span>${arrow}${target}</span></div>`;
  }).join("");

  const series = asArray(record.series as unknown[]).map((s) => {
    const obj = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    const titleText = contentOf(obj.title);
    const number = contentOf(obj.number);
    const part = contentOf(obj.partnumber);
    const text = [titleText, number ? `no. ${escapeHtml(number)}` : "", part ? `part ${escapeHtml(part)}` : ""].filter(Boolean).join(" · ");
    if (!text) return "";
    return `<div class="ov-row"><span>${escapeHtml(text)}</span></div>`;
  }).join("");

  const copyright = record.copyright as Record<string, unknown> | undefined;
  let copyrightHtml = "";
  if (typeof copyright === "object" && copyright !== null) {
    const owner = copyright.owner as Record<string, unknown> | undefined;
    const ownerOrg = owner?.organization as Record<string, unknown> | undefined;
    const ownerName = contentOf(ownerOrg?.name) || contentOf(owner?.name);
    const from = contentOf(copyright.from);
    const to = contentOf(copyright.to);
    const text = [ownerName, from && to ? `${from}–${to}` : from].filter(Boolean).join(" · ");
    if (text) {
      copyrightHtml = `<div class="ov-row">${escapeHtml(text)}</div>`;
    }
  }

  return `
${(factRows || identifierRows || dates) ? `<section class="ov-section"><h3>General information</h3>${factRows}${identifierRows}${dates}</section>` : ""}
${section("contributor", "Contributors", contributorsHtml)}
${section("link", "Links", links)}
${abstracts ? `<section class="ov-section"><h3>${fieldLabel("abstract", "Abstract")}</h3>${abstracts}</section>` : ""}
${keywords ? `<section class="ov-section"><h3>${fieldLabel("keyword", "Keywords")}</h3><div class="ov-chips">${keywords}</div></section>` : ""}
${section("relation", "Relations", relations)}
${section("series", "Series", series)}
${section("copyright", "Copyright", copyrightHtml)}
`;
}

/**
 * Series family for "other documents in this series": the primary docid
 * minus its year and trailing part/edition segment (ISO 19115-3:2023 →
 * "ISO 19115"; S-100 → "S" within the iho collection).
 */
function primaryDocidText(record: Record<string, unknown> | null, fallback: string): string {
  if (record && Array.isArray(record.docidentifier)) {
    for (const d of record.docidentifier as unknown[]) {
      const obj = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
      if (obj.primary === true) {
        const c = contentOf(obj.content);
        if (c) return c;
      }
    }
    const first = (record.docidentifier as unknown[])[0];
    const c0 = contentOf(first);
    if (c0) return c0;
  }
  return fallback;
}

function familyQueryOf(record: Record<string, unknown> | null, fallbackDocid: string): string {
  const docid = primaryDocidText(record, fallbackDocid);
  return (
    docid.replace(/:[-–]?\d{4}(?=[^-]*$)/, "").replace(/[-–][\d.]+$/, "").trim() || docid
  );
}

export interface RecordPageInput {
  collection: string;
  key: string;
  docid: string;
  body: string;
}

export function renderRecordPage({ collection, key, docid, body }: RecordPageInput): { body: string; head: string } {
  const isXml = body.trimStart().startsWith("<");
  const parsed = isXml ? fromXml(body) : null;
  const item = parsed?.ok ? parsed.item : null;
  const record = item as unknown as Record<string, unknown> | null;

  const anchor = slugAnchor(docid);
  const yamlText = item ? toYaml(item) : null;
  const asciibib = item ? toAsciiBib(item, anchor) : null;

  const entryPath = `/collections/${escapeHtml(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}`;
  const citeStyles = [
    { label: "ISO 690", text: item ? toIso690(item) : "" },
    { label: "Chicago", text: item ? toChicago(item) : "" },
    { label: "APA 7th", text: item ? toApa(item) : "" },
  ].filter((s) => s.text);
  const primaryDocid = (() => {
    const docids = Array.isArray(record?.docidentifier) ? record?.docidentifier : record?.docidentifier ? [record.docidentifier] : [];
    const first = docids[0] as Record<string, unknown> | undefined;
    return typeof first?.content === "string" ? first.content : docid;
  })();
  const fetchEntry = `* [[[${anchor},${primaryDocid}]]]`;
  const citeTools = `
<section class="tool-card">
<h3>Cite this record</h3>
${citeStyles.length ? `<div class="cite-styles">${citeStyles.map((s) => `
<div class="cite-style-row">
<span class="cite-style-label">${escapeHtml(s.label)}</span>
<span class="cite-style-text">${escapeHtml(s.text)}</span>
<button type="button" class="icon-btn" data-copy-text="${escapeHtml(s.text)}" title="Copy the ${escapeHtml(s.label)} citation" aria-label="Copy the ${escapeHtml(s.label)} citation"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg></button>
</div>`).join("")}</div>` : ""}
<div class="anchor-row">
<span class="ov-key">Anchor</span><code class="anchor-code">${escapeHtml(anchor)}</code>
<button type="button" class="icon-btn" data-copy-text="cite:[${escapeHtml(anchor)}]" title="Copy cite:[${escapeHtml(anchor)}]" aria-label="Copy citation anchor"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg></button>
</div>
</section>
${asciibib ? `
<details class="mn-reveal">
<summary>
<img class="mn-icon mn-light-bg" src="/assets/metanorma-icon-light-bg.svg" alt="">
<img class="mn-icon mn-dark-bg" src="/assets/metanorma-icon-dark-bg.svg" alt="">
<span class="mn-cta-text"><strong>Cite in Metanorma</strong><br>
<small>Fetch entry and AsciiBib, shown before you copy</small></span>
<svg class="mn-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
</summary>
<div class="mn-body">
<p class="mn-step">1 · Add the fetch entry under a <code>[bibliography]</code> heading — Metanorma fetches the full record at build time:</p>
<pre class="mn-code">${escapeHtml(fetchEntry)}</pre>
<button type="button" class="copy-btn" data-copy-text="${escapeHtml(fetchEntry)}">Copy fetch entry</button>
<p class="mn-step">2 · Or pin this exact record as AsciiBib instead:</p>
<pre class="mn-code">${escapeHtml(asciibib)}</pre>
<button type="button" class="copy-btn" data-copy-text="${escapeHtml(asciibib)}">Copy AsciiBib</button>
<p class="mn-step">3 · Cite it as <code>&lt;&lt;${escapeHtml(anchor)}&gt;&gt;</code> or <code>cite:[${escapeHtml(anchor)}]</code>.</p>
</div>
</details>` : ""}
<section class="tool-card">
<h3>Download</h3>
<div class="cite-styles">
<div class="cite-style-row"><span class="cite-style-label">BibTeX</span><span class="cite-style-text">Reference managers and LaTeX</span><a class="dl-link" href="/collections/${escapeHtml(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}/export.bib" download>Download</a></div>
<div class="cite-style-row"><span class="cite-style-label">RIS</span><span class="cite-style-text">EndNote, Zotero, RefWorks</span><a class="dl-link" href="/collections/${escapeHtml(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}/export.ris" download>Download</a></div>
<div class="cite-style-row"><span class="cite-style-label">CSL</span><span class="cite-style-text">Citation Style Language JSON</span><a class="dl-link" href="/collections/${escapeHtml(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}/export.csl.json" download>Download</a></div>
<div class="cite-style-row"><span class="cite-style-label">JSON-LD</span><span class="cite-style-text">schema.org RDF for linked data</span><a class="dl-link" href="/collections/${escapeHtml(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}/export.jsonld" download>Download</a></div>
</div>
</section>
<p class="cite-hint">Citation fields are explained on <a href="https://www.relaton.org/model/" target="_blank" rel="noopener">relaton.org/model</a>.</p>`;

  const tabs: string[] = [];
  const panes: string[] = [];
  const addTab = (id: string, label: string, contentHtml: string, rawText: string) => {
    const first = tabs.length === 0;
    tabs.push(`<button class="tab-btn" id="tab-btn-${id}" role="tab" aria-selected="${first}" aria-controls="pane-${id}" data-pane="${id}">${label}</button>`);
    panes.push(`<div class="pane-wrap" id="wrap-${id}"${first ? "" : " hidden"}><div class="pane-bar"><button type="button" class="copy-btn" data-copy-text="${escapeHtml(rawText)}">Copy ${label}</button></div><pre id="pane-${id}" role="tabpanel" aria-labelledby="tab-btn-${id}">${contentHtml}</pre></div>`);
  };

  const bibtex = item ? toBibtex(item) : "";
  const ris = item ? toRis(item) : "";
  const csl = item ? toCslJson(item) : "";
  if (yamlText) addTab("yaml", "Relaton YAML", highlightYaml(yamlText), yamlText);
  addTab("xml", isXml ? "Relaton XML" : "Source", highlightXml(body), body);
  if (asciibib) addTab("asciibib", "AsciiBib", escapeHtml(asciibib), asciibib);
  if (bibtex) addTab("bibtex", "BibTeX", escapeHtml(bibtex), bibtex);
  if (ris) addTab("ris", "RIS", escapeHtml(ris), ris);
  if (csl) addTab("csl", "CSL-JSON", escapeHtml(csl), csl);

  // Link previews, structured citations, and print — the surfaces a
  // record meets outside the browser window.
  const { docid: metaDocid, title: metaTitleText } = record ? recordHeading(record) : { docid: "", title: "" };
  const metaTitle = `${metaDocid || docid}${metaTitleText ? ` — ${metaTitleText}` : ""}`;
  const metaDescription = `${docid}${metaTitleText ? ` — ${metaTitleText}` : ""}. Relaton bibliographic record, ${collection} collection.`;
  const canonical = `https://api.relaton.org/collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(key.replace(/^data\//, ""))}`;
  const metaLogo = /^[a-z0-9-]+$/.test(collection)
    ? `https://www.relaton.org/logos/${collection}-logo.svg`
    : "";
  const metaYear = record?.date
    ? (JSON.stringify(record.date).match(/\d{4}/)?.[0] ?? "")
    : "";
  const ldJson = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: metaTitleText || docid,
    identifier: metaDocid || docid,
    url: canonical,
    ...(metaYear ? { datePublished: metaYear } : {}),
    ...(metaLogo ? { publisher: { "@type": "Organization", name: collection.toUpperCase(), logo: metaLogo } } : {}),
  };
  const recordHead = `
<meta name="description" content="${escapeHtml(metaDescription)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(metaTitle)}">
<meta property="og:description" content="${escapeHtml(metaDescription)}">
<meta property="og:url" content="${canonical}">
${metaLogo ? `<meta property="og:image" content="${metaLogo}">` : ""}
<script type="application/ld+json">${JSON.stringify(ldJson).replace(/</g, "\\u003c")}</script>`;

  const pageBody = `
<p class="meta">${escapeHtml(collection)} collection ·
<a href="${entryPath}?raw=1">raw bytes</a> ·
<a href="/v3/documents/${encodeURIComponent(docid)}" title="/v3/documents/${encodeURIComponent(docid)}">API</a> ·
<a href="/collections/${escapeHtml(collection)}">all ${escapeHtml(collection)} records</a></p>
${record ? renderRecordHead(record, familyQueryOf(record, key), collection) : ""}
<div class="record-body">
<div class="record-main">${record ? renderOverview(record) : ""}</div>
<aside class="record-tools">${citeTools}</aside>
</div>
<section class="machine-forms">
<h2>Machine forms</h2>
<p class="machine-hint">Copyable source of this record — monospace on purpose.</p>
<div class="tabs" role="tablist">
${tabs.join("\n")}
</div>
<div class="panes">
${panes.join("\n")}
</div>
</section>
<script>
document.querySelectorAll('.tab-btn[data-pane]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn[data-pane]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b === btn));
    });
    document.querySelectorAll('.pane-wrap').forEach(function (p) {
      p.hidden = p.id !== 'wrap-' + btn.dataset.pane;
    });
  });
});
document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = btn.getAttribute('data-copy-text');
    var ta = document.createElement('textarea');
    ta.value = text;
    document.documentElement.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(function () { btn.classList.remove('copied'); }, 1500);
  });
});
</script>`;
  return { body: pageBody, head: recordHead };
}

export const RECORD_CSS = `
  .ov-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
  .ov-chips .chip {
    background: var(--accent-soft); border: 1px solid transparent; border-radius: 999px;
    padding: 2px 10px; font-size: 12.5px; color: var(--accent);
  }
  .chip-type { color: var(--accent); border-color: var(--accent-soft); }
  .chip-status { color: var(--aqua); border-color: rgba(0,138,100,0.3); }
  .ov-docids { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
  .record-head {
    margin: 4px 0 22px; display: flex; gap: 20px; align-items: flex-start;
    position: relative; border: 1px solid var(--border); border-radius: 16px;
    padding: 20px 22px 18px; overflow: hidden;
    background:
      radial-gradient(120% 150% at 100% 0%, var(--accent-soft) 0%, transparent 55%),
      linear-gradient(180deg, var(--bg-soft) 0%, var(--bg) 100%);
  }
  .publisher-mark {
    flex: none; width: 64px; height: 64px; border: 1px solid var(--border); border-radius: 14px;
    background: #fff; display: flex; align-items: center; justify-content: center; margin-top: 6px;
    text-decoration: none; overflow: hidden;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 6px 16px -8px rgba(16, 24, 40, 0.12);
    transition: border-color 0.12s, transform 0.12s;
  }
  .publisher-mark:hover { transform: translateY(-1px); }
  @media (prefers-reduced-motion: reduce) { .publisher-mark:hover { transform: none; } }
  .publisher-mark:hover { border-color: var(--accent); }
  .publisher-mark img { max-width: 46px; max-height: 46px; object-fit: contain; }
  .record-head-main { min-width: 0; }
  @media (max-width: 600px) { .record-head { flex-direction: column-reverse; gap: 10px; } .publisher-mark { margin-top: 0; align-self: flex-end; width: 48px; height: 48px; } .publisher-mark img { max-width: 34px; max-height: 34px; } }
  .record-eyebrow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 2px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--border);
    border-radius: 999px; padding: 3px 11px 3px 9px; font-size: 12.5px; font-weight: 600; color: var(--fg-2);
    background: var(--bg-soft);
  }
  .status-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .status-pill.status-ok .dot { background: #12a150; box-shadow: 0 0 0 3px rgba(18, 161, 80, 0.16); }
  .status-pill.status-warn .dot { background: #d69e2e; box-shadow: 0 0 0 3px rgba(214, 158, 46, 0.16); }
  .status-pill.status-bad .dot { background: #e5484d; box-shadow: 0 0 0 3px rgba(229, 72, 61, 0.16); }
  .type-chip {
    display: inline-flex; border: 1px solid var(--accent-soft); color: var(--accent);
    border-radius: 999px; padding: 3px 11px; font-size: 12.5px; font-weight: 600; background: var(--bg);
  }
  .doc-number { margin: 10px 0 0; font-size: 20px; font-weight: 700; letter-spacing: 0.01em; line-height: 1.2; }
  .doc-h1 { font-size: 29px; font-weight: 800; line-height: 1.2; margin: 2px 0 10px; letter-spacing: -0.012em; }
  .row-note { font-size: 11px; color: var(--muted); margin-left: 8px; }
  .ov-row .icon-btn { margin-left: auto; align-self: center; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border: 1px solid transparent; border-radius: 7px;
    background: none; color: var(--muted); cursor: pointer; flex: none;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .icon-btn:hover { color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft); }
  .icon-btn:focus-visible, .copy-btn:focus-visible, .mn-reveal summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .icon-btn.copied { color: var(--success); border-color: var(--success); }
  .title-parallel { border-left: 1px solid var(--border); }
  .title-row {
    display: grid; grid-template-columns: 108px 1fr; gap: 14px; align-items: baseline;
    padding: 8px 0 8px 14px; position: relative;
  }
  .title-row + .title-row { border-top: 1px dashed var(--border); }
  .title-lang {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted);
  }
  .title-text { font-size: 17.5px; line-height: 1.4; font-weight: 500; }
  .record-body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 32px; align-items: start; margin-top: 4px; }
  @media (max-width: 920px) { .record-body { grid-template-columns: 1fr; } }
  .ov-section { margin: 22px 0; }
  .ov-section:first-child { margin-top: 6px; }
  .ov-section h3 {
    font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin: 0 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px;
  }
  .ov-label { color: var(--muted); text-decoration: none; }
  .ov-label:hover { color: var(--accent); }
  .ov-row { display: flex; gap: 12px; padding: 3px 0; font-size: 14.5px; }
  .ov-key { min-width: 96px; color: var(--muted); font-size: 13px; padding-top: 2px; }
  .ov-section p { font-size: 14.5px; line-height: 1.65; margin: 0 0 10px; }
  .ov-section p.note {
    font-size: 13px; color: var(--fg-2); border-left: 2px solid var(--border);
    padding-left: 12px; margin-top: -2px;
  }
  .series-link {
    display: inline-block; margin-top: 10px; font-size: 13px; font-weight: 600;
    padding: 5px 13px; border: 1px solid var(--accent-soft); border-radius: 999px;
    color: var(--accent); text-decoration: none; background: var(--bg);
    transition: border-color 0.12s, background 0.12s;
  }
  .series-link:hover { border-color: var(--accent); background: var(--accent-soft); }
  .rel-arrow { color: var(--accent); margin-right: 7px; }
  .rel-arrow.back { color: var(--muted); }
  .record-tools { display: flex; flex-direction: column; gap: 14px; }
  .tool-card {
    border: 1px solid var(--border); border-radius: 12px; background: var(--bg-soft);
    padding: 14px 16px; margin: 0;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 12px 32px -16px rgba(16, 24, 40, 0.14);
    transition: box-shadow 0.15s, transform 0.15s;
  }
  .tool-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 16px 40px -16px rgba(16, 24, 40, 0.18);
  }
  @media (prefers-reduced-motion: reduce) { .tool-card { transition: none; } .tool-card:hover { transform: none; } }
  .tool-card h3 {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--muted); margin: 0 0 10px;
  }
  .anchor-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .anchor-row .ov-key { min-width: 0; }
  .anchor-code { font-family: var(--mono); font-size: 12.5px; background: var(--accent-soft); color: var(--accent); padding: 3px 8px; border-radius: 6px; }
  .copy-btn { font: 13px var(--font); padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px;
              background: var(--bg); color: var(--fg-2); cursor: pointer; }
  .copy-btn code { font-size: 12px; }
  .copy-btn:hover { color: var(--accent); border-color: var(--accent); }
  .copy-btn.copied { color: var(--success); border-color: var(--success); }
  .mn-reveal {
    border: 1px solid rgba(114, 94, 219, 0.45); border-radius: 12px;
    background: rgba(124, 96, 230, 0.07); overflow: hidden;
  }
  .mn-reveal summary {
    display: flex; align-items: center; gap: 11px; padding: 12px 14px;
    cursor: pointer; list-style: none; color: var(--fg-2); font-size: 14px; line-height: 1.4;
    transition: background 0.12s;
  }
  .mn-reveal summary::-webkit-details-marker { display: none; }
  .mn-reveal summary:hover { background: rgba(124, 96, 230, 0.09); }
  .mn-reveal[open] summary { border-bottom: 1px dashed rgba(114, 94, 219, 0.4); }
  .mn-reveal strong { color: var(--fg); }
  .mn-reveal small { color: var(--muted); font-size: 12px; }
  .mn-icon { width: 26px; height: 26px; display: block; flex: none; }
  .mn-reveal .mn-light-bg { display: none; }
  html.dark .mn-reveal .mn-light-bg { display: block; }
  html.dark .mn-reveal .mn-dark-bg { display: none; }
  .mn-chevron { margin-left: auto; color: var(--muted); transition: transform 0.15s ease; flex: none; }
  .mn-reveal[open] .mn-chevron { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .mn-chevron { transition: none; } }
  .mn-body { padding: 4px 14px 14px; }
  .mn-step {
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin: 12px 0 6px;
  }
  .mn-step code, .cite-hint code { font-family: var(--mono); font-size: 11.5px; background: var(--bg); border: 1px solid var(--border); padding: 1px 5px; border-radius: 4px; }
  .mn-code {
    font-family: var(--mono); font-size: 12px; line-height: 1.55; margin: 0 0 8px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px; white-space: pre-wrap; word-break: break-word;
    max-height: 240px; overflow: auto;
  }
  .cite-hint { color: var(--muted); font-size: 12.5px; margin: 0; }
  .dl-link {
    font-size: 12.5px; font-weight: 600; color: var(--accent); text-decoration: none;
    border: 1px solid var(--accent-soft); border-radius: 999px; padding: 3px 10px;
    justify-self: end; white-space: nowrap;
  }
  .dl-link:hover { border-color: var(--accent); background: var(--accent-soft); }
  .cite-styles { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .cite-style-row { display: grid; grid-template-columns: 64px 1fr 26px; gap: 8px; align-items: baseline; }
  .cite-style-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .cite-style-text { font-size: 14px; }
  .tok-tag { color: var(--accent); }
  .tok-attr { color: var(--aqua); }
  .tok-str { color: #b7791f; }
  .dark .tok-str { color: #d69e2e; }
  .tok-com { color: var(--muted); font-style: italic; }
  .tok-key { color: var(--accent); }
  .tok-val { color: inherit; }
  @media print {
    .record-body { grid-template-columns: 1fr; }
    .record-tools, .machine-forms, .meta, .cite-style-row .copy-btn, .icon-btn, .dl-link { display: none !important; }
    .record-head { border: 1px solid var(--border); background: none; }
    .ov-section { break-inside: avoid; }
  }
  .machine-forms { margin-top: 30px; border-top: 1px solid var(--border); padding-top: 20px; }
  .machine-forms h2 { font-size: 15px; font-weight: 700; margin: 0 0 2px; letter-spacing: -0.01em; }
  .machine-hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .pane-wrap { position: relative; }
  .pane-bar { display: flex; justify-content: flex-end; margin-bottom: -34px; padding: 6px 8px; position: relative; z-index: 2; }
  .pane-bar .copy-btn { font-size: 12px; padding: 5px 12px; background: var(--bg); }
`;
