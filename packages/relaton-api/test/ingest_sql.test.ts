import { describe, expect, it } from "vitest";
import { buildIngestStatements, buildReconcileStatements, type IngestChunkLike } from "../src/lib/ingest_sql";

// D1 rejects any single SQL statement longer than 100KB, so every
// statement the builder emits must stay under it — including the
// documents_v2 upserts whose data column carries full document JSON.
const STMT_BYTE_CAP = 90_000;

function row(key: string, dataBytes = 100): { key: string; file: string; data: Record<string, unknown>; keys: string[] } {
  return {
    key,
    file: `data/${key}.yaml`,
    data: { docidentifier: [{ content: key, type: "ISO", primary: true }], pad: "x".repeat(dataBytes) },
    keys: [key.replace(/\s+/g, "")],
  };
}

function chunk(rows: IngestChunkLike["rows"]): IngestChunkLike {
  return { flavor: "iso", repo: "relaton/relaton-data-iso", rows, blobs: {}, final: true };
}

const rendered = (s: { sql: string; binds: unknown[] }) =>
  s.sql.length + s.binds.reduce<number>((n, b) => n + String(b).length, 0);

describe("buildIngestStatements", () => {
  it("splits groups by the bind cap for small rows", () => {
    const stmts = buildIngestStatements(chunk(Array.from({ length: 200 }, (_, i) => row(`ISO ${i}`))), "2026-11-12T00:00:00Z");
    const docUpserts = stmts.filter((s) => s.sql.includes("INSERT INTO documents_v2"));
    // 5 columns x 90 binds = 18 rows per statement: 200 rows -> 12
    expect(docUpserts.length).toBe(12);
    for (const s of stmts) expect(rendered(s)).toBeLessThan(STMT_BYTE_CAP + 5000);
  });

  it("flushes groups early when document JSON is large", () => {
    // 200 rows of ~40KB each: bind cap would allow 18 per statement
    // (~720KB), but D1 rejects statements over 100KB — the byte cap must
    // win.
    const stmts = buildIngestStatements(chunk(Array.from({ length: 200 }, (_, i) => row(`ISO ${i}`, 40_000))), "2026-11-12T00:00:00Z");
    const docUpserts = stmts.filter((s) => s.sql.includes("INSERT INTO documents_v2"));
    expect(docUpserts.length).toBeGreaterThan(18);
    for (const s of docUpserts) expect(rendered(s)).toBeLessThan(120_000);
    // every row present exactly once
    const inserted = docUpserts.flatMap((s) => s.binds.filter((_, i) => i % 5 === 0));
    expect(inserted).toHaveLength(200);
  });

  it("keeps projection and token statements under the cap with wide tables", () => {
    const stmts = buildIngestStatements(chunk(Array.from({ length: 100 }, (_, i) => row(`ISO ${i}`, 30_000))), "2026-11-12T00:00:00Z");
    for (const s of stmts) {
      expect(s.sql.length).toBeLessThan(120_000);
      expect(s.binds.length).toBeLessThanOrEqual(90);
    }
    expect(stmts.some((s) => s.sql.includes("flavors_v2"))).toBe(true);
  });

  it("emits the final-chunk flavor row and meta once", () => {
    const stmts = buildIngestStatements(chunk([row("ISO 1")]), "2026-11-12T00:00:00Z");
    expect(stmts.filter((s) => s.sql.includes("flavors_v2"))).toHaveLength(1);
    expect(stmts.filter((s) => s.sql.includes("relaton_version"))).toHaveLength(0);
  });
});

describe("buildReconcileStatements", () => {
  it("deletes stale rows in bounded rounds and recounts the flavor", () => {
    const stmts = buildReconcileStatements("iso", "2026-11-12T00:00:00Z");
    const docKeyDeletes = stmts.filter((s) => s.sql.includes("DELETE FROM doc_keys"));
    const docDeletes = stmts.filter((s) => s.sql.includes("DELETE FROM documents_v2"));
    // a flavor-wide DELETE with FK cascades times the D1 import endpoint
    // out (~60s, code 7009) - the deletes must be bounded rounds
    expect(docKeyDeletes.length).toBeGreaterThan(10);
    expect(docDeletes.length).toBeGreaterThan(10);
    expect(docKeyDeletes.every((s) => s.sql.includes("LIMIT 500"))).toBe(true);
    expect(docDeletes.every((s) => s.sql.includes("LIMIT 500"))).toBe(true);
    expect(stmts.at(-1)!.sql).toContain("doc_count");
    for (const s of stmts) expect(s.binds.length).toBeLessThanOrEqual(2);
  });
});
