#!/usr/bin/env node
// Contract runner (TODO.api/12): runs contract/fixtures.json against a base
// URL and exits non-zero on drift. Plain node, no framework, so the Ruby
// gem's CI can run the same file.
//   RELATON_API_BASE_URL=https://api.relaton.org node contract/run.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const base = (process.env.RELATON_API_BASE_URL ?? "https://api.relaton.org").replace(/\/+$/, "");
const only = process.argv[2];

const { version, fixtures } = JSON.parse(await readFile(join(dir, "fixtures.json"), "utf8"));
console.log(`relaton-api contract v${version}: ${fixtures.length} fixtures against ${base}\n`);

let failed = 0;
for (const fixture of fixtures) {
  if (only && !fixture.name.includes(only)) continue;
  const url = `${base}${fixture.path}`;
  try {
    const res = await fetch(url, { headers: fixture.headers ?? {} });
    const problems = [];
    const want = fixture.expect ?? {};

    if (want.status !== undefined && res.status !== want.status) {
      problems.push(`status ${res.status} != ${want.status}`);
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (want.contentType !== undefined && contentType !== want.contentType) {
      problems.push(`content-type ${contentType} != ${want.contentType}`);
    }
    const body = await res.text();
    for (const needle of want.bodyContains ?? []) {
      if (!body.includes(needle)) problems.push(`body lacks ${JSON.stringify(needle)}`);
    }
    for (const [path, test] of Object.entries(want.json ?? {})) {
      const value = path.split(".").reduce((acc, key) => acc?.[key], JSON.parse(body));
      if (test === ">0" ? !(value > 0) : String(value) !== test) {
        problems.push(`json ${path}=${value} fails ${test}`);
      }
    }

    if (problems.length) {
      failed += 1;
      console.error(`FAIL ${fixture.name} (${url})`);
      for (const problem of problems) console.error(`     ${problem}`);
    } else {
      console.log(`ok   ${fixture.name}`);
    }
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${fixture.name} (${url})`);
    console.error(`     ${error.cause?.code ?? error.message}`);
  }
}

console.log(`\ncontract v${version}: ${fixtures.length - failed}/${fixtures.length} fixtures pass against ${base}`);
process.exit(failed ? 1 : 0);
