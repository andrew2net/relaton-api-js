#!/usr/bin/env node
// Fills the pubid component columns (publisher / number / part) of
// documents_search by running the @pubid/pubid grammar engine (PARG).
// The engine needs a real filesystem at import time, so this runs under
// plain node — never inside the worker; the projection routes hold the
// columns so only this script writes them.
//
//   ADMIN_TOKEN=… BASE_URL=https://api.relaton.org node tools/set_components.mjs
//
// Re-run after any build-search rebuild (the projection upsert holds the
// columns, so a rebuild never wipes them; this walk only refreshes).
import { grammarImplementation } from "@pubid/pubid/dist/flavors/index.js";

const BASE_URL = process.env.BASE_URL ?? "https://api.relaton.org";
const PAGE = Number(process.env.PAGE ?? 500);
const TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) {
  console.error("set ADMIN_TOKEN");
  process.exit(1);
}

// Deterministic try-parse order, common flavors first. The engine is
// corpus-gated per flavor, so the first grammar that parses the code
// decides the components — no hand parsing here.
const FLAVORS = [
  "iso", "iec", "ieee", "ietf", "itu", "nist", "bsi", "bipm", "jcgm", "jis",
  "gost", "ogc", "w3c", "oasis", "tgpp", "ecma", "iana", "etsi", "ccsds",
  "cie", "gb", "oiml", "easc", "iala", "iho", "plateau", "un", "xsf",
  "calconnect", "amca", "ansi", "api", "ashrae", "asme", "astm", "csa",
  "doi", "evs", "idf", "isbn", "cen_cenelec", "omg",
];

const impls = FLAVORS.map((flavor) => [flavor, grammarImplementation(flavor)]).filter(([, impl]) => impl);

// The model's publisher attribute is a value object per flavor —
// IsoPublisher { publisher, copublisher }, Publisher { body }, or a
// plain string. Normalize from the model's own shapes only.
function publisherString(pub) {
  if (pub == null) return null;
  if (typeof pub === "string") return pub;
  if (Array.isArray(pub)) return pub.map(publisherString).filter(Boolean).join("/") || null;
  if (typeof pub === "object") {
    if (typeof pub.publisher === "string" && Array.isArray(pub.copublisher)) {
      return [pub.publisher, ...pub.copublisher.map(String)].join("/") || null;
    }
    if (typeof pub.body === "string") return pub.body;
    return null;
  }
  return String(pub);
}

function componentsOf(docid) {
  for (const [, impl] of impls) {
    let id;
    let hash;
    try {
      id = impl.parse(docid);
      hash = id.toHash();
    } catch {
      continue;
    }
    const part = hash.part != null
      ? String(hash.part)
      : Array.isArray(hash.parts) && hash.parts.length ? hash.parts.join(String(hash.separator ?? ".")) : null;
    return {
      publisher: publisherString(id.publisher ?? hash.publisher),
      number: hash.number != null ? String(hash.number) : null,
      part,
    };
  }
  return null;
}

async function pageSearch(cursor) {
  const url = `${BASE_URL}/admin/page-search?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`page-search ${res.status}: ${await res.text()}`);
  return res.json();
}

async function setComponents(components) {
  const res = await fetch(`${BASE_URL}/admin/set-components`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ components }),
  });
  if (!res.ok) throw new Error(`set-components ${res.status}: ${await res.text()}`);
  return res.json();
}

let cursor = "";
let total = 0;
let parsed = 0;
while (true) {
  const page = await pageSearch(cursor);
  const updates = [];
  for (const row of page.rows ?? []) {
    if (!row.docid) continue;
    const components = componentsOf(row.docid);
    if (!components) continue;
    if (!components.publisher && !components.number && !components.part) continue;
    updates.push({ key: row.key, ...components });
  }
  if (updates.length) await setComponents(updates);
  total += page.scanned ?? 0;
  parsed += updates.length;
  console.log(`cursor=${String(cursor || "").slice(0, 30)} scanned=${page.scanned} components=${updates.length} total=${total} parsed=${parsed}`);
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}
console.log(`set-components complete: ${parsed} of ${total} rows`);
