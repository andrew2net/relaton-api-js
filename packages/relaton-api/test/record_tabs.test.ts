import { describe, expect, it } from "vitest";
import { renderRecordPage } from "../src/routes/ui/record";

// The tab-switch script shows the wrapper whose id is 'wrap-' + data-pane
// and hides all other wrappers. Each tab button must point to a wrapper
// that exists. If it does not, a click on the tab hides all panes.

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bibdata type="standard">
  <docidentifier type="ISO" primary="true">ISO/CD 19115-1</docidentifier>
  <title language="en" script="Latn" type="main">Geographic information - Metadata</title>
  <date type="published"><on>2024-01-01</on></date>
</bibdata>`;

describe("record page format tabs", () => {
  const { body } = renderRecordPage({
    collection: "iso",
    key: "data/iso-cd-19115-1",
    docid: "ISO/CD 19115-1",
    body: XML,
  });

  const panes = [...body.matchAll(/class="tab-btn"[^>]*data-pane="([^"]+)"/g)].map((m) => m[1]);
  const wraps = new Set([...body.matchAll(/class="pane-wrap" id="([^"]+)"/g)].map((m) => m[1]));

  it("renders more than one format tab", () => {
    expect(panes).toEqual(expect.arrayContaining(["yaml", "xml", "asciibib"]));
  });

  it("points each tab button to an existing pane wrapper", () => {
    for (const pane of panes) expect(wraps.has(`wrap-${pane}`)).toBe(true);
  });

  it("matches wrappers by 'wrap-' + data-pane in the script", () => {
    expect(body).toContain("p.hidden = p.id !== 'wrap-' + btn.dataset.pane;");
  });
});
