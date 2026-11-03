import { describe, expect, it } from "vitest";
import { canonicalize, parse, yearOf } from "@relaton/api";
import corpus from "./corpus.json";

interface CorpusEntry {
  flavor: string;
  input: string;
  parseable: boolean;
  canonical?: string;
  year?: string | null;
  reason?: string;
}

const entries = corpus as CorpusEntry[];

describe("pubid-ts corpus (generated from Ruby pubid)", () => {
  it("matches canonical renders for all parseable entries", () => {
    const parseable = entries.filter((e) => e.parseable);
    const matched = parseable.filter((e) => canonicalize(e.input, e.flavor) === e.canonical);
    const rate = matched.length / parseable.length;
    if (rate < 1) {
      const misses = parseable.filter((e) => canonicalize(e.input, e.flavor) !== e.canonical).slice(0, 15);
      console.log("sample misses:", misses.map((e) => `${e.input} → ${canonicalize(e.input, e.flavor)} (want ${e.canonical})`));
    }
    expect(rate).toBe(1);
  });

  it("matches years for all parseable entries", () => {
    const parseable = entries.filter((e) => e.parseable);
    const matched = parseable.filter(
      (e) => (yearOf(e.input, e.flavor) ?? null) === (e.year ?? null),
    );
    expect(matched.length / parseable.length).toBe(1);
  });

  it("canonicalizes known specials", () => {
    expect(canonicalize("ISO/IEC Directives Part 1")).toBe("ISO/IEC DIR 1");
    expect(canonicalize("ISO/IEC DIR JTC 1")).toBe("ISO/IEC JTC 1 DIR");
    expect(canonicalize("ISO/TC 184/SC 4 N1110")).toBe("ISO/TC 184/SC 4 N 1110");
    expect(canonicalize("B-10", "iho")).toBe("IHO B-10");
    expect(canonicalize("S-122 Appendix D-2", "iho")).toBe("IHO S-122 Ap. D-2");
    expect(canonicalize("IEEE 802.3")).toBe("IEEE Std 802.3");
    expect(canonicalize("IEEE/ISO/IEC 8802-3")).toBe("ISO/IEC/IEEE 8802-3");
    expect(yearOf("ISO 668:2013/Amd 1:2016")).toBe("2016");
    expect(yearOf("ISO 1942-4:1989/CD Amd 2")).toBeNull();
    expect(yearOf("ITU-T G.7710/Y.1705 (2001)")).toBe("2001");
  });

  it("round-trips plain ISO identifiers unchanged", () => {
    const id = parse("ISO 19115-1:2014");
    expect(id?.canonical).toBe("ISO 19115-1:2014");
    expect(id?.year).toBe("2014");
    expect(id?.part).toBe("1");
  });
});
