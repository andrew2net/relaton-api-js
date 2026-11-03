import { describe, expect, it } from "vitest";
import { allPartsKey, deriveKeys, normalizeCode, normKey, undatedKey } from "@relaton/api";

describe("normalizeCode", () => {
  it("collapses em/en dashes and unicode whitespace", () => {
    expect(normalizeCode("ISO 19115—1")).toBe("ISO 19115-1");
    expect(normalizeCode("ISO 19115–1")).toBe("ISO 19115-1");
    expect(normalizeCode("ISO 19115–1")).toBe("ISO 19115-1");
    expect(normalizeCode("ISO　19115—1")).toBe("ISO 19115-1");
    expect(normalizeCode("  ISO   19115-1  ")).toBe("ISO 19115-1");
  });

  it("unwraps scope wrappers", () => {
    expect(normalizeCode("IEC(IEC 31010)")).toBe("IEC 31010");
    expect(normalizeCode("CN(GM/T 0009-2012)")).toBe("GM/T 0009-2012");
    expect(normalizeCode("ISO(ISO 639-1)")).toBe("ISO 639-1");
  });

  it("leaves mid-string parens alone", () => {
    expect(normalizeCode("ITU-T G.7710/Y.1705 (2001)")).toBe("ITU-T G.7710/Y.1705 (2001)");
  });
});

describe("normKey", () => {
  it("uppercases and removes spaces", () => {
    expect(normKey("iec 31010:2019")).toBe("IEC31010:2019");
    expect(normKey("ISO 19115-1:2014")).toBe("ISO19115-1:2014");
  });
});

describe("undatedKey / allPartsKey", () => {
  it("strips trailing years", () => {
    expect(undatedKey("ISO19115-1:2014")).toBe("ISO19115-1");
    expect(undatedKey("IEC31010")).toBe("IEC31010");
  });

  it("strips parenthesised years (ITU style)", () => {
    expect(undatedKey("G.7710/Y.1705(2001)")).toBe("G.7710/Y.1705");
    expect(undatedKey("G.7710(2001)")).toBe("G.7710");
    expect(undatedKey("IEC31010:2019(E)")).toBe("IEC31010(E)");
  });

  it("strips trailing part for all-parts keys", () => {
    expect(allPartsKey("ISO19115-1:2014")).toBe("ISO19115");
    expect(allPartsKey("ISO53798-2")).toBe("ISO53798");
    expect(allPartsKey("ISO19115")).toBe("ISO19115");
  });
});

import corpus from "./corpus.json";

interface KeyedEntry {
  flavor: string;
  input: string;
  parseable: boolean;
  canonical?: string;
  keys?: { norm: string; undated: string; allparts: string };
}

describe("pubid-ts key derivation parity with pubid ruby (corpus)", () => {
  it("derives the same keys for every corpus entry", () => {
    const entries = (corpus as KeyedEntry[]).filter((e) => e.parseable && e.keys);
    const misses = entries.filter((e) => {
      const k = deriveKeys(e.input, e.flavor);
      return k.norm !== e.keys!.norm || k.undated !== e.keys!.undated || k.allparts !== e.keys!.allparts;
    });
    expect(misses.length).toBe(0);
  });
});
