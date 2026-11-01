import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import schemaSql from "../../../migrations/0001_init.sql?raw";
import storageV2Sql from "../../../migrations/0007_storage_v2.sql?raw";

// The model-faithful GraphQL schema (TODO.api/04) over storage v2.
const ISO_DOC = {
  doctype: "standard",
  language: ["en"],
  script: ["Latn"],
  edition: 3,
  docidentifier: [
    { content: "ISO 19115-1:2018", type: "ISO", primary: true },
    { content: "10.2600/19115-1", type: "DOI" },
  ],
  title: [
    { content: "Geographic information - Metadata", type: "main", language: ["en"], script: ["Latn"] },
    { content: "Information géographique - Métadonnées", type: "main", language: ["fr"] },
  ],
  date: [{ type: "published", on: "2018-11-01" }],
  contributor: [
    { organization: { name: "International Organization for Standardization", abbreviation: "ISO", url: "https://www.iso.org" }, role: [{ type: "publisher" }] },
  ],
  relation: [{ type: "updates", bibitem: { docidentifier: [{ content: "ISO 19115:2003", type: "ISO" }] } }],
  series: [{ title: { content: "ISO Geographic information", type: "main" }, abbreviation: "GIS" }],
  classification: [{ type: "ICS", value: "35.240.70" }],
  status: { stage: { value: "60" }, substage: { value: "60" } },
};

const RFC_DOC = {
  doctype: "standard",
  docidentifier: [{ content: "RFC 8446", type: "IETF", primary: true }],
  title: [{ content: "The Transport Layer Security (TLS) Protocol Version 1.3", type: "main" }],
  date: [{ type: "published", on: "2018-08-01" }],
  relation: [{ type: "obsoletes", bibitem: { docidentifier: [{ content: "RFC 8446", type: "IETF" }] } }],
};

const XML = (key: string) => `<bibdata type="standard"><docidentifier primary="true">${key}</docidentifier></bibdata>`;

function auth(init: RequestInit = {}): RequestInit {
  const token = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  };
}

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await SELF.fetch("http://localhost/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json<{ data?: Record<string, unknown>; errors?: { message: string }[] }>();
}

beforeAll(async () => {
  for (const sql of [schemaSql, storageV2Sql]) {
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  }
  await SELF.fetch("http://localhost/admin/ingest-v2/iso", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flavor: "iso",
      repo: "relaton/relaton-data-iso",
      final: true,
      relatonVersion: "3.0.4",
      rows: [
        { key: "ISO 19115-1:2018", file: "data/iso-19115-1-2018.yaml", data: ISO_DOC, keys: ["ISO19115-1:2018"] },
      ],
      blobs: { "iso/data/iso-19115-1-2018": XML("ISO 19115-1:2018") },
    }),
  }));
  await SELF.fetch("http://localhost/admin/ingest-v2/rfcs", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flavor: "rfcs",
      repo: "relaton/relaton-data-rfcs",
      final: true,
      rows: [
        { key: "RFC 8446", file: "rfc8446.yaml", data: RFC_DOC, keys: ["RFC8446"] },
      ],
      blobs: {},
    }),
  }));
});

describe("model-faithful GraphQL", () => {
  it("serves the full BibliographicItem projection from the model JSON", async () => {
    const { data, errors } = await gql(`{
      document(key: "ISO 19115-1:2018") {
        key flavor doctype editions languages scripts
        docids { content type primary }
        titles { content language script type }
        dates { type on }
        contributors { role organization { name abbreviation url } }
        relations { type target }
        series { title abbreviation }
        classifications { type value }
        status { stage substage }
      }
    }`);
    expect(errors).toBeUndefined();
    const doc = data!.document as Record<string, unknown>;
    expect(doc.key).toBe("ISO 19115-1:2018");
    expect(doc.doctype).toBe("standard");
    expect(doc.editions).toEqual(["3"]);
    expect(doc.languages).toEqual(["en"]);
    expect(doc.scripts).toEqual(["Latn"]);
    expect(doc.docids).toEqual([
      { content: "ISO 19115-1:2018", type: "ISO", primary: true },
      { content: "10.2600/19115-1", type: "DOI", primary: false },
    ]);
    expect(doc.titles).toEqual([
      { content: "Geographic information - Metadata", language: "en", script: "Latn", type: "main" },
      { content: "Information géographique - Métadonnées", language: "fr", script: null, type: "main" },
    ]);
    expect(doc.dates).toEqual([{ type: "published", on: "2018-11-01" }]);
    expect(doc.contributors).toEqual([
      { role: "publisher", organization: { name: "International Organization for Standardization", abbreviation: "ISO", url: "https://www.iso.org" } },
    ]);
    expect(doc.relations).toEqual([{ type: "updates", target: "ISO 19115:2003" }]);
    expect(doc.series).toEqual([{ title: "ISO Geographic information", abbreviation: "GIS" }]);
    expect(doc.classifications).toEqual([{ type: "ICS", value: "35.240.70" }]);
    expect(doc.status).toEqual({ stage: "60", substage: "60" });
  });

  it("serves the opt-in xml field from the R2 blob", async () => {
    const { data } = await gql(`{ document(key: "ISO 19115-1:2018") { xml } }`);
    expect((data!.document as { xml: string }).xml).toBe(XML("ISO 19115-1:2018"));
    const missing = await gql(`{ document(key: "RFC 8446") { xml } }`);
    expect((missing.data!.document as { xml: string | null }).xml).toBeNull();
  });

  it("paginates the connection with the shared storage v2 SQL", async () => {
    const page1 = await gql(`{ documents(first: 1) { edges { cursor node { key } } pageInfo { hasNextPage endCursor } } }`);
    const conn1 = page1.data!.documents as { edges: { cursor: string; node: { key: string } }[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
    expect(conn1.edges[0]!.node.key).toBe("ISO 19115-1:2018");
    expect(conn1.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(
      `query($after: String) { documents(first: 1, after: $after) { edges { node { key } } pageInfo { hasNextPage } } }`,
      { after: conn1.pageInfo.endCursor },
    );
    const conn2 = page2.data!.documents as { edges: { node: { key: string } }[]; pageInfo: { hasNextPage: boolean } };
    expect(conn2.edges[0]!.node.key).toBe("RFC 8446");
    expect(conn2.pageInfo.hasNextPage).toBe(false);
  });

  it("filters by title, contributor, and relation", async () => {
    const tls = await gql(`{ documents(title: "Transport Layer Security") { edges { node { key } } } }`);
    expect((tls.data!.documents as { edges: { node: { key: string } }[] }).edges.map((e) => e.node.key))
      .toEqual(["RFC 8446"]);

    const iso = await gql(`{ documents(contributor: "ISO") { edges { node { key } } } }`);
    expect((iso.data!.documents as { edges: { node: { key: string } }[] }).edges.map((e) => e.node.key))
      .toEqual(["ISO 19115-1:2018"]);

    const updated = await gql(`{ documents(relation: { type: "updates" }) { edges { node { key } } } }`);
    expect((updated.data!.documents as { edges: { node: { key: string } }[] }).edges.map((e) => e.node.key))
      .toEqual(["ISO 19115-1:2018"]);
  });

  it("traverses a relation target to its BibliographicItem", async () => {
    const { data } = await gql(`{ document(key: "RFC 8446") { relations { type target item { key flavor docids { content } } } } }`);
    const [relation] = ((data!.document as { relations: { type: string; target: string; item: unknown }[] }).relations);
    expect(relation!.type).toBe("obsoletes");
    // The obsoletes target names RFC 8446 itself; the traversal resolves
    // whatever key it names — here the same document.
    expect((relation!.item as { key: string }).key).toBe("RFC 8446");
  });

  it("reports flavors and version from storage v2", async () => {
    const { data } = await gql(`{ flavors { flavor repo docCount } version { release relaton } }`);
    expect(data!.flavors).toEqual([
      { flavor: "iso", repo: "relaton/relaton-data-iso", docCount: 1 },
      { flavor: "rfcs", repo: "relaton/relaton-data-rfcs", docCount: 1 },
    ]);
    expect((data!.version as { relaton: string }).relaton).toBe("3.0.4");
  });
});
