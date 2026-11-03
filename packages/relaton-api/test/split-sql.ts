// Split a migration file into statements, respecting BEGIN..END trigger
// bodies (their inner semicolons are not statement terminators).
export function splitSqlStatements(sql: string): string[] {
  const clean = sql.replace(/^--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of clean) {
    buf += ch;
    if (/\bBEGIN\s*$/i.test(buf)) depth += 1;
    else if (depth === 0 && ch === ";") {
      out.push(buf.trim());
      buf = "";
    } else if (depth > 0 && /\bEND\s*;\s*$/i.test(buf)) {
      out.push(buf.trim());
      buf = "";
      depth = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
