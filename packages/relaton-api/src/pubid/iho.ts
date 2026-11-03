import type { Identifier } from "./types.ts";

export function parseIho(input: string): Identifier | null {
  if (!/^[A-Z]-\d/.test(input) && !/^IHO /.test(input)) return null;
  let canonical = /^IHO /.test(input) ? input : `IHO ${input}`;
  canonical = canonical.replace(/ Appendix /, " Ap. ");
  return {
    flavor: "iho",
    publishers: ["IHO"],
    number: input.replace(/^IHO /, ""),
    supplements: [],
    canonical,
    raw: input,
  };
}
