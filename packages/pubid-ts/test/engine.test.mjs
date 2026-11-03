// Node-side cross-check against the released @pubid/pubid grammar engine
// (run with `node --test`, not vitest: the engine's parsanol/parg runtime
// walks the filesystem from import.meta.url, which vitest's module runner
// virtualizes). The engine cannot load inside the worker runtime at all,
// so the worker serves the local key derivation; this harness pins the
// engine's own contract on the sampled corpus codes: the canonical
// rendering parses back to itself. Year/component parity with the Ruby
// corpus stays with the local-parser harness (corpus.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { grammarImplementation } from "@pubid/pubid/dist/flavors/index.js";

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8"));
const ENGINES = ["iso", "iec", "itu", "bipm", "bsi", "gost", "ogc", "w3c"];

for (const flavor of ENGINES) {
  test(`@pubid/pubid engine, flavor ${flavor}: canonical form round-trips`, () => {
    const impl = grammarImplementation(flavor);
    if (!impl) return; // engine has not ported this flavor yet
    for (const entry of corpus.filter((e) => e.parseable && e.flavor === flavor)) {
      let first;
      try {
        first = impl.parse(entry.input);
      } catch {
        continue;
      }
      const human = first.toHuman();
      assert.equal(impl.parse(human).toHuman(), human, `${flavor}: ${entry.input}`);
    }
  });
}

test("the corpus samples cover the engine flavors", () => {
  const sampled = corpus.filter((e) => e.parseable && ENGINES.includes(e.flavor));
  assert.ok(sampled.length > 10, `only ${sampled.length} sampled entries`);
});


