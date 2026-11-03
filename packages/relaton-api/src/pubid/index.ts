import { parseIeee } from "./ieee.ts";
import { parseIho } from "./iho.ts";
import { parseIso } from "./iso.ts";
import { parseSimple } from "./simple.ts";
import type { Identifier } from "./types.ts";
import { applyUpdateCodes } from "./update-codes.ts";

export type { Identifier, Supplement } from "./types.ts";
export { applyUpdateCodes } from "./update-codes.ts";

export function detectFlavor(code: string): string | null {
  if (/^(ISO|JCGM)/.test(code)) return "iso";
  if (/^IEC/.test(code)) return "iec";
  if (/^IEEE/.test(code)) return "ieee";
  if (/^ITU[- ]/.test(code)) return "itu";
  if (/^(NIST|NBS)/.test(code)) return "nist";
  if (/^(IHO |[A-Z]-\d)/.test(code)) return "iho";
  if (/^(BS|BSI|PAS)/.test(code)) return "bsi";
  if (/^(CCSDS|ETSI)/.test(code)) return "simple";
  return null;
}

const SIMPLE_FLAVORS = new Set(["itu", "nist", "iec", "bsi", "ccsds", "etsi"]);

export function parse(code: string, flavor?: string): Identifier | null {
  const f = flavor ?? detectFlavor(code);
  if (!f) return null;
  const normalized = applyUpdateCodes(code, f);

  switch (f) {
    case "iso":
      return parseIso(normalized);
    case "ieee":
      return parseIeee(normalized);
    case "iho":
      return parseIho(normalized);
    default:
      if (SIMPLE_FLAVORS.has(f)) return parseSimple(f, normalized);
      return null;
  }
}

export function canonicalize(code: string, flavor?: string): string | null {
  return parse(code, flavor)?.canonical ?? null;
}

export function yearOf(code: string, flavor?: string): string | null {
  return parse(code, flavor)?.year ?? null;
}

export * from "./keys.ts";
