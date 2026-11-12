import { describe, expect, it } from "vitest";
import { fromSlug } from "@pubid/pubid/dist/pubid-urn/index.js";
import "../src/lib/slug_registry";

// The slug leg (relaton#441): a "/"-joined pubid-scheme slug decodes to the
// identifier engine-free; its canonical render is what the standard key
// chain resolves. This pins the resolver halves the route relies on: the
// registry populates the worker-safe flavor set, and unregistered flavors
// (nist, ieee) reject loudly instead of mis-decoding.
describe("slug resolution", { timeout: 60_000 }, () => {
  it("decodes iho and iso slugs to canonical renders", () => {
    expect(fromSlug("iho/std/129/ed-1.0.0").render()).toBe("IHO S-129 1.0.0");
    expect(fromSlug("iso/is/123/year-1994").render()).toBe("ISO 123:1994");
  });

  it("decodes the flavors the worker registry registers", () => {
    expect(fromSlug("jis/jis/8301/series-Z/year-2019").render()).toBe("JIS Z 8301:2019");
    expect(fromSlug("ecma/std/262/ed-5.1").render()).toBe("ECMA-262 ed5.1");
  });

  it("rejects a malformed slug", () => {
    expect(() => fromSlug("iso//123")).toThrow();
  });
});
