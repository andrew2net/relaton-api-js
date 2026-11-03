import type { Identifier, Supplement } from "./types.ts";

const COPUBLISHERS = ["IEC", "IEEE", "ITU", "ASTM", "SAE", "CIE", "HL7", "OASIS", "UN", "W3C", "IETF"];
const STAGES = ["FDIS", "DIS", "AWI", "PRF", "BPUB", "CDTS", "DTR", "DTS", "PWI", "NP", "CD", "WD", "WI", "DDAM", "DAMD", "FDAM", "DCOR", "FDCOR", "DAD", "FDAD", "DSUPPL", "NDTR", "NDIS", "NDTS"];
const TYPES = ["GUIDE", "DIR", "TR", "TS", "PAS", "ISP", "TTA", "IWA", "R", "NSB"];
const SUPPLEMENT_WORDS = ["Amd", "Cor", "Suppl", "Add", "Ext", "Guide"];
const COMPACT_SUPPLEMENTS = ["FDCor", "FDAmd", "FDAM", "FDCOR", "DAmd", "DAM", "DCOR", "DAD", "FDAD", "DSuppl", "DGUIDE"];

const TC_KINDS = ["TC", "JTC"];
const SUB_GROUPS = ["SC", "WG", "QC", "AHG", "AG", "CAG", "TG", "SG", "JWG", "SWG", "MA", "WG"];

function renderSupplement(s: Supplement): string {
  const head = s.stage ? `${s.stage} ${s.word}` : s.word;
  return `/${head}${s.number ? ` ${s.number}` : ""}${s.year ? `:${s.year}` : ""}`;
}

function effectiveYear(baseYear: string | undefined, supplements: Supplement[]): string | undefined {
  const withYears = supplements.filter((s) => s.year);
  if (withYears.length) return withYears[withYears.length - 1]?.year;
  if (supplements.length) return undefined;
  return baseYear;
}

function parseSupplementToken(token: string): Supplement | null {
  let m = token.match(new RegExp(`^(${COMPACT_SUPPLEMENTS.join("|")})\\.?[ ]?(\\d+)?(?::(\\d{4}))?$`));
  if (m) return { word: m[1] as string, number: m[2], year: m[3] };

  m = token.match(new RegExp(`^(CD|DIS|FDIS|PRF|AWI|D|FD)\\s+(${SUPPLEMENT_WORDS.join("|")})\\.?[ ]?(\\d+)?(?::(\\d{4}))?$`));
  if (m) {
    const stage = m[1] === "D" || m[1] === "FD" ? (m[1] === "D" ? "D" : "FD") : (m[1] as string);
    return { stage, word: m[2] as string, number: m[3], year: m[4] };
  }

  m = token.match(new RegExp(`^(${SUPPLEMENT_WORDS.join("|")})\\.?\\s?(\\d+)?(?::(\\d{4}))?$`));
  if (m) return { word: m[1] as string, number: m[2], year: m[3] };

  return null;
}

function normalizeCommitteePath(path: string): string {
  return path
    .replace(/\s*\/\s*/g, "/")
    .replace(new RegExp(`/(${SUB_GROUPS.join("|")})(\\d)`, "g"), "/$1 $2")
    .replace(new RegExp(`^(${SUB_GROUPS.join("|")})(\\d)`), "$1 $2");
}

function parseTcDocument(input: string): Identifier | null {
  const m = input.match(
    new RegExp(`^(ISO(?:/(?:IEC|IEEE|ITU))*)[ /]?(${TC_KINDS.join("|")}) ?(\\d+)(.*)[ \\n]([A-Z])[ ]?(\\d+)$`),
  );
  if (!m) return null;
  const [, publishers, tc, tcNumber, rawPath, kind, docNumber] = m;
  const path = normalizeCommitteePath((rawPath ?? "").trim());
  const canonical = `${publishers}/${tc} ${tcNumber}${path} ${kind} ${docNumber}`;
  return {
    flavor: "iso",
    publishers: (publishers ?? "").split("/"),
    number: docNumber ?? "",
    committeePath: path,
    supplements: [],
    canonical,
    raw: input,
  } as Identifier;
}

const CYRILLIC: [RegExp, string][] = [
  [/Руководства/g, "GUIDE"], [/Руководство/g, "GUIDE"],
  [/ИСО\/МЭК/g, "ISO/IEC"], [/ИСО\/ОПМС/g, "ISO/FDIS"], [/ИСО\/ПМС/g, "ISO/DIS"],
  [/ИСО\/ТО/g, "ISO/TR"], [/ИСО\/ТС/g, "ISO/TS"], [/ИСО/g, "ISO"], [/МЭК/g, "IEC"],
];

export function parseIso(input: string): Identifier | null {
  // Wording pre-normalization handled by the PEG grammar in Ruby pubid
  let pre = input
    .replace(/\bDirectives,?\s*(?:Part\s*)?/, "DIR ")
    .replace(/\bGuide\b/, "GUIDE");
  if (/[а-яА-Я]/.test(pre)) {
    pre = pre.replace(/\s*#\s*.*$/, "");
    for (const [re, replacement] of CYRILLIC) pre = pre.replace(re, replacement);
    pre = pre.trim();
  }

  const tc = parseTcDocument(pre);
  if (tc) return tc;

  // JCGM 200:2008
  let m = pre.match(/^JCGM (\d+)(?:-(\d+))?:(\d{4})$/);
  if (m) {
    return {
      flavor: "iso", publishers: ["JCGM"], number: m[1] ?? "", part: m[2],
      year: m[3], supplements: [], canonical: pre, raw: input,
    };
  }

  // Directives: ISO/IEC DIR 1, ISO/IEC DIR JTC 1, ISO/IEC DIR 1 + IEC SUP:2016-05,
  // already-reordered ISO/IEC JTC 1 DIR:2004
  m = pre.match(/^(ISO(?:[ /](?:IEC|IEEE|ITU))*)[/ ]?DIR[ ]?(.*)$/);
  if (m) {
    const publishers = (m[1] ?? "").replace(/\s/g, "/");
    const rest = (m[2] ?? "").trim();
    const dateFixed = rest.replace(/:(\d{4})-(\d{2})$/, ":$1-$2-$2");
    const bareJtc = /^JTC \d+$/.test(rest);
    const canonical = bareJtc
      ? `${publishers} ${rest} DIR`
      : `${publishers} DIR ${dateFixed}`;
    const combined = /\+/.test(rest);
    const year = combined ? undefined : rest.match(/:(\d{4})$/)?.[1];
    return { flavor: "iso", publishers: publishers.split("/"), type: "DIR", number: "", year, supplements: [], canonical, raw: input };
  }

  m = pre.match(/^(ISO(?:[ /](?:IEC|IEEE|ITU))*)[/ ]?((JTC \d+) DIR)(?::(\d{4}))?( SUP.*)?$/);
  if (m) {
    const publishers = (m[1] ?? "").replace(/\s/g, "/");
    const year = m[4];
    const sup = (m[5] ?? "").trim();
    const canonical = `${publishers} ${m[2]}${year ? `:${year}` : ""}${sup ? ` ${sup}` : ""}`;
    return { flavor: "iso", publishers: publishers.split("/"), type: "DIR", number: "", year, supplements: [], canonical, raw: input };
  }

  // Bare stage without publisher: "AWI IWA 47"
  m = pre.match(new RegExp(`^(${STAGES.join("|")}) (${TYPES.join("|")}) (\\d+)(?::(\\d{4}))?$`));
  if (m) {
    return {
      flavor: "iso", publishers: [], stage: m[1], type: m[2], number: m[3] ?? "",
      year: m[4], supplements: [], canonical: pre, raw: input,
    };
  }

  // ISO/R legacy: ISO/R 657-4:1969
  m = pre.match(/^ISO\/R ([\dA-Z]+)(?:-([\dA-Z]+))?:(\d{4})$/);
  if (m) {
    return {
      flavor: "iso", publishers: ["ISO"], type: "R", number: m[1] ?? "", part: m[2],
      year: m[3], supplements: [], canonical: pre, raw: input,
    };
  }

  const pubAlt = COPUBLISHERS.join("|");
  const stageAlt = STAGES.join("|");
  const typeAlt = TYPES.join("|");

  const re = new RegExp(
    `^ISO(?:[ /](?:${pubAlt}))*` +
    `[/ ]?(?:(${stageAlt})[/ ])??` +
    `(?:(${typeAlt})[/ ])??` +
    `([\\dA-Z][\\w.]*)(?:-([A-Za-z]?\\d+[A-Za-z]*|[A-Za-z]))?` +
    `(?::(\\d{4})(?:-(\\d{2}))?)?` +
    `((?:/[\\w. :]+)*)` +
    `(?:\\(([A-Za-z]{1,2})\\))?` +
    `(?: \\(all parts\\))?$`,
  );
  m = pre.match(re);
  if (!m) return null;

  const publisherPart = (pre.match(/^ISO(?:[ /](?:IEC|IEEE|ITU|ASTM|SAE|CIE|HL7|OASIS|UN|W3C|IETF))*/) ?? [""])[0] ?? "";
  const publishers = publisherPart.replace(/\s/g, "/").split("/");

  const supplementTokens = ((m[7] ?? "").match(/[^/]+/g) ?? []).map((t) => t.trim());
  const supplements: Supplement[] = [];
  for (const token of supplementTokens) {
    const s = parseSupplementToken(token);
    if (!s) return null;
    supplements.push(s);
  }

  const language = m[8];
  const allParts = / \(all parts\)$/.test(input);
  const baseYear = m[5];

  const sole = publishers.length === 1;
  const prefix = m[2] === "IWA" ? "" : publishers.join("/");
  const sep = prefix && sole ? "/" : " ";
  const canonical =
    prefix +
    (m[1] ? `${prefix ? sep : ""}${m[1]}` : "") +
    (m[2] ? `${m[1] ? " " : prefix ? sep : ""}${m[2]}` : "") +
    ` ${m[3]}` +
    (m[4] ? `-${m[4]}` : "") +
    (baseYear ? `:${baseYear}` : "") +
    supplements.map(renderSupplement).join("") +
    (language ? `(${language})` : "") +
    (allParts ? " (all parts)" : "");

  return {
    flavor: "iso",
    publishers,
    stage: m[1],
    type: m[2],
    number: m[3] ?? "",
    part: m[4],
    year: effectiveYear(baseYear, supplements),
    supplements,
    language,
    allParts,
    canonical,
    raw: input,
  };
}
