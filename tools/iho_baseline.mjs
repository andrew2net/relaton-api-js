// Shape probe: dumps the @pubid/pubid IHO grammar's output for the IHO
// form corpus plus a cross-flavor spot check, as JSON — diff the output
// before/after a pubid release to see exactly which shapes moved.
//   node tools/iho_baseline.mjs > /tmp/iho-shapes-before.json
import { grammarImplementation } from "@pubid/pubid/dist/flavors/index.js";

const IHO_FORMS = [
  // bare series
  "IHO S-44", "IHO S-57", "IHO S-100", "IHO S-101", "IHO S-158:100",
  "IHO P-1", "IHO P-5", "IHO P-6", "IHO B-7", "IHO B-12", "IHO M-3",
  "IHO C-55", "IHO D-2", "IHO INT 1",
  // dotted version tails (edition series)
  "IHO S-44 5.0.0", "IHO S-44 6.1.0", "IHO S-44 Edition 6.1.0", "IHO B-12 3.0",
  // year-identified series
  "IHO B-7 2022", "IHO P-5 2024", "IHO P-6 2024", "IHO P-5 1850", "IHO B-12 3.0",
  // volume/issue-identified series
  "IHO P-1 Vol. 30", "IHO P-1 Vol. 30 (2)", "IHO P-1 Vol. 30 Issue 2",
  // other components
  "IHO S-44 Ap. A", "IHO S-44 Part 1", "IHO S-44 Annex B", "IHO S-44 Suppl 1",
  // unparseable controls
  "S-44", "P-1 Vol. 30",
];

const SPOT_FLAVORS = ["iso", "iec", "ieee", "nist", "bsi", "itu"];
const SPOT_FORMS = {
  iso: ["ISO 19115-1:2014", "ISO/IEC 27001:2022"],
  iec: ["IEC 61010-2-201:2015"],
  ieee: ["IEEE Std 802.3-2022"],
  nist: ["NIST SP 800-113"],
  bsi: ["BS 5750:1987"],
  itu: ["ITU-T H.222.0"],
};

function probe(flavor, code) {
  const impl = grammarImplementation(flavor);
  if (!impl) return { flavor, code, engine: false };
  try {
    const id = impl.parse(code);
    return {
      flavor,
      code,
      engine: true,
      hash: id.toHash(),
      human: id.toHuman(),
      urn: id.toUrn?.() ?? null,
      publisher: id.publisher ? String(id.publisher?.publisher ?? id.publisher?.body ?? id.publisher) : null,
    };
  } catch (e) {
    return { flavor, code, engine: true, error: String(e.message) };
  }
}

const out = { iho: [], spot: [] };
for (const code of IHO_FORMS) out.iho.push(probe("iho", code));
for (const flavor of SPOT_FLAVORS) for (const code of SPOT_FORMS[flavor] ?? []) out.spot.push(probe(flavor, code));
console.log(JSON.stringify(out, null, 2));
