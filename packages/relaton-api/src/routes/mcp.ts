import * as v2 from "../lib/search2";
import { fromXml, toAsciiBib, toIso690, toYaml, slugAnchor, type RelatonItem } from "relaton";
import { renderCreatePreview, type CreatePayload } from "./create";
import { verifyCode } from "./verify";

// Model Context Protocol server (Streamable HTTP, JSON responses, stateless)
// exposing the Relaton database to AI assistants. Public and read-only.

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "relaton_search",
    description: "Search the Relaton bibliographic database of standards documents by identifier, title, or keywords. Returns matching documents with docid, flavor, year, doctype, status, and links to the full record.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Query: publication identifier (e.g. 'ISO 19115') or title keywords" },
        flavor: { type: "string", description: "Restrict to one collection: iso, iec, ietf, itu, nist, ieee, w3c, 3gpp, …" },
        doctype: { type: "string" },
        status: { type: "string" },
        yearFrom: { type: "integer" },
        yearTo: { type: "integer" },
        page: { type: "integer", minimum: 0 },
        size: { type: "integer", minimum: 10, maximum: 100 },
      },
    },
  },
  {
    name: "relaton_fetch",
    description: "Fetch one bibliographic record by publication identifier and return it as Relaton YAML (valid against the Relaton model).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Publication identifier — dated (e.g. 'ISO 19115-1:2014') resolves that edition, undated (e.g. 'ISO 19115-1') resolves the latest" },
        year: { type: "integer", description: "Restrict an undated reference to this publication year" },
        allParts: { type: "boolean", description: "Return the all-parts aggregate instead of a single part (e.g. 'ISO 690' → all parts)" },
        format: { type: "string", enum: ["yaml", "xml", "json"], description: "Serialization (default yaml)" },
      },
      required: ["code"],
    },
  },
  {
    name: "relaton_cite",
    description: "Get exactly what to enter in a Metanorma document to cite a publication: the citation anchor, the <<anchor>> / cite:[anchor] forms, and the AsciiBib bibliography block to paste under a [bibliography] heading.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        year: { type: "integer" },
        allParts: { type: "boolean" },
      },
      required: ["code"],
    },
  },
  {
    name: "relaton_create_record",
    description: "Build a custom Relaton bibliographic record from structured fields (for documents not in the database). Validates against the Relaton model and returns YAML, XML, JSON, and Metanorma AsciiBib serializations.",
    inputSchema: {
      type: "object",
      properties: {
        docid: { type: "string" },
        docidType: { type: "string", description: "e.g. ISO, IETF, DOI" },
        type: { type: "string", description: "standard, article, book, report, website, software, …" },
        title: { type: "string" },
        language: { type: "string" },
        script: { type: "string" },
        edition: { type: "string" },
        uri: { type: "string" },
        abstract: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        contributors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["organization", "person"] },
              role: { type: "string", enum: ["publisher", "author", "editor", "distributor"] },
              org: { type: "string" },
              abbr: { type: "string" },
              person: { type: "string" },
            },
          },
        },
        dates: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } } } },
      },
    },
  },
  {
    name: "relaton_verify",
    description: "Verify a DOI or ISBN by resolving it live (CrossRef / OpenLibrary — the sources relaton fetch uses) and return the validated Relaton record.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "DOI (10.x/…) or ISBN-10/13" } },
      required: ["code"],
    },
  },
];

const PROMPTS = [
  {
    name: "cite-in-metanorma",
    description: "Find, verify, and cite a document in a Metanorma document",
    arguments: [{ name: "topic", description: "The document or subject to cite", required: true }],
  },
];

interface McpEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

interface RefOptions {
  year?: number;
  allParts?: boolean;
}

// Resolve a code to its stored blob: the projection carries { key,
// flavor, file } and the blob key is derived from the dataset path.
async function findRecord(
  env: McpEnv,
  code: string,
  opts: RefOptions = {},
): Promise<{ blobKey: string } | null> {
  const row = await v2.findDocument(env.DB, {
    code,
    year: opts.year ?? null,
    allParts: opts.allParts ?? false,
  });
  if (!row) return null;
  return { blobKey: v2.blobKeyOf(row.flavor, row.file) };
}

async function fetchRecordXml(env: McpEnv, code: string, opts: RefOptions = {}): Promise<string | null> {
  const record = await findRecord(env, code, opts);
  if (!record) return null;
  const obj = await env.BUCKET.get(record.blobKey);
  if (!obj) return null;
  return obj.text();
}

export async function handleMcp(env: McpEnv, req: JsonRpcRequest): Promise<unknown> {
  const { method, params = {} } = req;

  if (method === "initialize") {
    return {
      protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "relaton", version: "3.0.0", title: "Relaton bibliographic database" },
    };
  }

  if (method === "tools/list") {
    return { tools: TOOLS };
  }

  if (method === "prompts/list") {
    return { prompts: PROMPTS };
  }

  if (method === "prompts/get") {
    const name = params.name as string;
    if (name !== "cite-in-metanorma") throw new Error(`unknown prompt: ${name}`);
    return {
      description: PROMPTS[0]?.description,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `I am editing a Metanorma document and need to cite: ${((params.arguments as Record<string, unknown> | undefined)?.topic as string) ?? "(a document)"}.
Use the relaton_search tool to find it in the Relaton database, relaton_cite to get the citation
anchor and AsciiBib block, and relaton_verify if it is identified by DOI or ISBN. Then give me:
(1) the exact AsciiBib block to paste under my [bibliography] section, and (2) the inline citation
form to use in the text. If the document is not in the database, build a record with
relaton_create_record instead.`,
        },
      }],
    };
  }

  if (method === "tools/call") {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (name === "relaton_search") {
      const params = {
        q: args.q as string | undefined,
        flavor: args.flavor as string | undefined,
        doctype: args.doctype as string | undefined,
        status: args.status as string | undefined,
        yearFrom: typeof args.yearFrom === "number" ? args.yearFrom : null,
        yearTo: typeof args.yearTo === "number" ? args.yearTo : null,
        page: typeof args.page === "number" ? args.page : 0,
        size: typeof args.size === "number" ? args.size : 25,
      };
      const result = await v2.searchDocuments(env.DB, params);
      return textResult(JSON.stringify({
        total: result.total,
        items: result.items.map((d) => ({
          docid: d.docid, flavor: d.flavor, year: d.year, doctype: d.doctype, status: d.status,
          title: d.title,
          record: `https://api.relaton.org/collections/${d.flavor}/entries/${encodeURIComponent(v2.entryKeyOf(d.file))}`,
        })),
      }, null, 2));
    }

    if (name === "relaton_fetch" || name === "relaton_cite") {
      const code = args.code as string;
      const xml = await fetchRecordXml(env, code, {
        year: typeof args.year === "number" ? args.year : undefined,
        allParts: args.allParts === true,
      });
      if (!xml) return textResult(`No document found for: ${code}`);
      const parsed = fromXml(xml);
      if (!parsed.ok) return textResult(`Record for ${code} could not be parsed: ${parsed.errors.map((e) => e.message).join("; ")}`);
      const item = parsed.item as RelatonItem;
      const docid = code;
      const anchor = slugAnchor(docid);
      if (name === "relaton_fetch") {
        const format = (args.format as string) ?? "yaml";
        const body = format === "xml" ? xml : format === "json" ? JSON.stringify(item, null, 2) : toYaml(item);
        return textResult(body);
      }
      const docids = (item as unknown as { docidentifier?: { content?: string }[] }).docidentifier ?? [];
      const primaryDocid = docids.find((d) => d.content)?.content ?? code;
      return textResult(
        `Citation anchor: ${anchor}\n\n` +
        `1) Fetch entry (indexed document — Metanorma fetches the full record at build time;\n` +
        `   pass allParts: true for the aggregate, or omit the year for the latest edition):\n` +
        `   * [[[${anchor},${primaryDocid}]]]\n\n` +
        `2) ISO 690 citation string:\n   ${toIso690(item)}\n\n` +
        `3) Full AsciiBib block (custom/unindexed records, or to override fields):\n\n` +
        toAsciiBib(item, anchor),
      );
    }

    if (name === "relaton_create_record") {
      const preview = renderCreatePreview(args as unknown as CreatePayload);
      if (!preview.ok) return textResult(`Validation failed: ${(preview.errors ?? []).join("; ")}`);
      return textResult(JSON.stringify(preview, null, 2));
    }

    if (name === "relaton_verify") {
      const outcome = await verifyCode(args.code as string);
      if (!outcome.ok || !outcome.item) return textResult(outcome.error ?? "Could not resolve the identifier.");
      return textResult(
        `Resolved (${outcome.kind}) as a validated Relaton record:\n\n${toYaml(outcome.item)}`,
      );
    }

    throw new Error(`unknown tool: ${name}`);
  }

  if (method === "ping") return {};

  throw new Error(`method not found: ${method}`);
}

