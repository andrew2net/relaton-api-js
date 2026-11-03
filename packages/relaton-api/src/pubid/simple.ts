import type { Identifier } from "./types.ts";

// Flavors whose canonical form is the (update_codes-normalized) input itself.
export function parseSimple(flavor: string, input: string): Identifier {
  const normalized = flavor === "iec" ? input.replace(/-\/(\d)/, "/$1") : input;
  let year: string | undefined;
  if (flavor === "itu") {
    year = normalized.match(/\((\d{4})\)\s*$/)?.[1];
  } else {
    year = normalized.match(/:(\d{4})(?=[^-]*$)/)?.[1];
  }
  return {
    flavor,
    publishers: [],
    number: normalized,
    year,
    supplements: [],
    canonical: normalized,
    raw: input,
  };
}
