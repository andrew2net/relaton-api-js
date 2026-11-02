import { layout, escapeHtml } from "./ui/chrome";

// Setup guide and prompt kit for AI assistants using the Relaton database.

const CSS = `
  pre { max-width: 100%; }
  .copy-btn { font: 13px var(--font); padding: 5px 14px; border: 1px solid var(--border); border-radius: 6px;
              background: var(--bg); color: var(--fg-2); cursor: pointer; }
  .copy-btn:hover { color: var(--accent); border-color: var(--accent); }
  .code-block { position: relative; }
  .code-block .copy-btn { position: absolute; top: 8px; right: 8px; }
  h2 { font-size: 20px; margin: 36px 0 10px; }
  .backtick { font-family: var(--mono); }
`;

const CLAUDE_CODE_SNIPPET = `claude mcp add --transport http relaton https://api.relaton.org/mcp`;

const CLIENT_JSON = `{
  "mcpServers": {
    "relaton": {
      "url": "https://api.relaton.org/mcp"
    }
  }
}`;

const SYSTEM_PROMPT = `You have access to the Relaton bibliographic database of standards documents
via MCP tools. When the user is writing or editing a Metanorma document and needs a citation:

1. FIND — call relaton_search with the publication identifier or topic keywords.
2. CITE — call relaton_cite with the exact identifier: it returns the citation anchor and the
   AsciiBib block to paste under the document's [bibliography] heading.
3. VERIFY — if the source is identified by DOI or ISBN, call relaton_verify to resolve it live.
4. CREATE — if the document is not in the database, call relaton_create_record with the known
   fields and paste the returned AsciiBib block.

In the Metanorma text, cite with <<ANCHOR>> or cite:[ANCHOR]. Prefer the anchor relaton_cite
returns (derived from the identifier). Never invent bibliographic details — every field in the
AsciiBib block must come from a tool result.`;

function codeBlock(id: string, code: string): string {
  return `<div class="code-block">
<button type="button" class="copy-btn" data-copy-src="${id}">Copy</button>
<pre><code id="${id}">${escapeHtml(code)}</code></pre>
</div>`;
}

const SCRIPT = `
document.querySelectorAll("[data-copy-src]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var src = document.getElementById(btn.dataset.copySrc);
    if (src && navigator.clipboard) navigator.clipboard.writeText(src.textContent || "");
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = "Copy"; }, 1500);
  });
});
`;

export function renderAiPage(): string {
  const body = `
<h1>Relaton for AI assistants</h1>
<p class="sub">The Relaton database is available as an MCP (Model Context Protocol) server and a
documented HTTP API, so assistants can find, verify, and cite standards documents while editing
Metanorma files.</p>

<h2>Connect the MCP server</h2>
<p>Claude Code:</p>
${codeBlock("mcp-cli", CLAUDE_CODE_SNIPPET)}
<p>Claude Desktop, Cursor, and other MCP clients (add to the client's server config):</p>
${codeBlock("mcp-json", CLIENT_JSON)}
<p>Tools exposed: <code>relaton_search</code>, <code>relaton_fetch</code>, <code>relaton_cite</code>,
<code>relaton_create_record</code>, <code>relaton_verify</code> — plus the
<code>cite-in-metanorma</code> prompt. The endpoint is
<code>https://api.relaton.org/mcp</code> (public, read-only).</p>

<h2>System prompt for citation workflows</h2>
<p>Paste this into agents that edit Metanorma documents:</p>
${codeBlock("system-prompt", SYSTEM_PROMPT)}

<h2>Plain HTTP API</h2>
<p>Assistants without MCP can use the REST endpoints directly —
<a href="/docs">full OpenAPI reference</a>:</p>
<pre><code>GET /v3/documents?q=iso+19115&flavor=iso                 # key-ordered search
GET /v3/documents/RFC%208446                             # record (Accept: json|relaton+xml|yaml)
GET /verify?code=10.17487/RFC8446                        # live DOI/ISBN resolution (page)
GET /collections/ietf/entries/data%2Frfc8446              # browsable record page</code></pre>
<p>A machine-readable guide is published at <a href="/llms.txt">/llms.txt</a>.</p>

<script>${SCRIPT}</script>`;

  return layout({ title: "For AI — Relaton API", body, css: CSS, activeNav: "ai" });
}

