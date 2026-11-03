import type { Identifier } from "./types.ts";

const IEEE_ORDER = ["ISO", "IEC", "IEEE", "ITU"];

function reorderPublishers(prefix: string): string {
  const parts = prefix.split("/");
  const known = IEEE_ORDER.filter((p) => parts.includes(p));
  const rest = parts.filter((p) => !IEEE_ORDER.includes(p));
  return [...known, ...rest].join("/");
}

export function parseIeee(input: string): Identifier | null {
  let m = input.match(/^(IEEE(?:\/ISO|\/IEC|\/ISO\/IEC|\/IEC\/ISO)[^ ]*)\s+(.*)$/);
  let prefix: string;
  let rest: string;
  if (m) {
    prefix = reorderPublishers(m[1] ?? "");
    rest = m[2] ?? "";
  } else {
    m = input.match(/^IEEE\s+(.*)$/);
    if (!m) return null;
    prefix = "IEEE";
    rest = m[1] ?? "";
  }

  const hasStd = /^Std /.test(rest);
  const hasDate = /:\d{4}/.test(rest) || /-\d{4}$/.test(rest) || /-\d{4}\//.test(rest);
  const canonical = `${prefix} ${prefix === "IEEE" && !hasStd && !hasDate ? "Std " : ""}${rest}`;

  const year = rest.match(/[-:](\d{4})(?:$|\))/)?.[1];
  return {
    flavor: "ieee",
    publishers: prefix.split("/"),
    number: rest,
    year,
    supplements: [],
    canonical,
    raw: input,
  };
}
