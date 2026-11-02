// Component search (migration 0005): pubid components of the primary
// docidentifier are ingest-parsed into columns, and the shared search
// engine (the /search page's) filters on them. Seeded per file — the
// workers pool isolates storage per test file.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { searchDocuments } from "../src/lib/search";
import schemaSql from "../../../migrations/0001_init.sql?raw";
import componentsSql from "../../../migrations/0005_document_components.sql?raw";

function seed(
  file: string,
  docid: string,
  components: { publisher: string; number: string; part?: string; edition?: string },
) {
  return env.DB.prepare(
    `INSERT INTO documents
       (flavor, file_path, kind, r2_key, docid, norm, undated_norm, allparts_norm,
        year, published, title_en, doctype, status, publisher, number, part, edition)
     VALUES ('iso', ?1, 'document', ?2, ?3, ?4, ?5, ?6, 2020, '2020-01-01', ?7,
             'standard', NULL, ?8, ?9, ?10, ?11)`,
  ).bind(
    file,
    `iso/${file.replace(/\.yaml$/, "")}`,
    docid,
    docid.toUpperCase().replace(/\s+/g, ""),
    docid.toUpperCase().replace(/\s+/g, "").replace(/:\d{4}$/, ""),
    docid.toUpperCase().replace(/\s+/g, "").replace(/:\d{4}$/, ""),
    `Sample ${docid}`,
    components.publisher,
    components.number,
    components.part ?? null,
    components.edition ?? null,
  );
}

beforeAll(async () => {
  const apply = (sql: string) =>
    env.DB.batch(
      sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
        .map((s) => env.DB.prepare(s)),
    );
  await apply(schemaSql);
  await apply(componentsSql);
  await env.DB.batch([
    seed("data/iso-9001-2015.yaml", "ISO 9001:2015",
      { publisher: "ISO", number: "9001", edition: "5" }),
    seed("data/iso-9001-2008.yaml", "ISO 9001:2008",
      { publisher: "ISO", number: "9001", edition: "4" }),
    seed("data/iso-19115-1-2018.yaml", "ISO 19115-1:2018",
      { publisher: "ISO", number: "19115-1", part: "1" }),
    seed("data/iso-19115-2-2019.yaml", "ISO 19115-2:2019",
      { publisher: "ISO", number: "19115-2", part: "2" }),
    seed("data/iec-31010-2019.yaml", "IEC 31010:2019",
      { publisher: "IEC", number: "31010" }),
  ]);
});

async function search(query: string): Promise<{ total: number; items: { docid: string | null }[] }> {
  const p = new URLSearchParams(query);
  const result = await searchDocuments(env.DB, {
    publisher: p.get("publisher") ?? undefined,
    number: p.get("number") ?? undefined,
    part: p.get("part") ?? undefined,
    edition: p.get("edition") ?? undefined,
    size: Number(p.get("size") ?? 25),
  });
  return result;
}

describe("component search", () => {
  it("filters by publisher and number", async () => {
    const json = await search("?publisher=ISO&number=9001&size=10");

    expect(json.total).toBe(2);
    expect(json.items.map((i) => i.docid).sort())
      .toEqual(["ISO 9001:2008", "ISO 9001:2015"]);
  });

  it("filters by part", async () => {
    const json = await search("?publisher=ISO&part=2&size=10");

    expect(json.items.map((i) => i.docid)).toEqual(["ISO 19115-2:2019"]);
  });

  it("combines components into one filter", async () => {
    const json = await search("?publisher=ISO&number=9001&edition=4&size=10");

    expect(json.items.map((i) => i.docid)).toEqual(["ISO 9001:2008"]);
  });

  it("keeps components out of unrelated results", async () => {
    const json = await search("?publisher=IEC&number=9001&size=10");

    expect(json.total).toBe(0);
  });
});
