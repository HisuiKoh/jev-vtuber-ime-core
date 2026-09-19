/**
 * 個人勢の検索再現率。鍵が要る。既定は検索のみ。`--resolve` で Jev まで。
 *   npm run eval:indie
 *   npm run eval:indie -- --resolve きねつきのあ
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Brave, MONID_DEFAULTS, Monid, Resolver, SearchChain, TypeSafeJev, extractCandidates, normalizeReading, providersFromEnv } from "../src/index.ts";

type Case = { reading: string; expect: string[] };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(resolve(root, "eval/indie-cases.json"), "utf8")) as { cases: Case[] };
const argv = process.argv.slice(2);
const doResolve = argv.includes("--resolve");
const only = argv.filter((a) => !a.startsWith("-")).map(normalizeReading);
const cases = only.length ? spec.cases.filter((c) => only.includes(normalizeReading(c.reading))) : spec.cases;

function provider(name: "monid" | "brave") {
  if (name === "brave") {
    if (!process.env["BRAVE_API_KEY"]) throw new Error("BRAVE_API_KEY missing");
    return new Brave(process.env["BRAVE_API_KEY"]);
  }
  if (!process.env["MONID_API_KEY"]) throw new Error("MONID_API_KEY missing");
  return new Monid({
    apiKey: process.env["MONID_API_KEY"],
    provider: MONID_DEFAULTS.provider,
    endpoint: MONID_DEFAULTS.endpoint,
  });
}

let failed = 0;
for (const c of cases) {
  const reading = normalizeReading(c.reading);
  for (const pname of ["monid", "brave"] as const) {
    try {
      const hits = await provider(pname).search(`${reading} VTuber`, 10);
      const names = [...extractCandidates(reading, hits).keys()];
      const hit = c.expect.some((e) => names.includes(e));
      if (!hit) failed += 1;
      console.log(`${hit ? "HIT " : "MISS"} ${pname.padEnd(6)} ${reading} expect=${c.expect.join("|")} names=${names.slice(0, 8).join("|")}`);
    } catch (e) {
      failed += 1;
      console.log(`ERR  ${pname.padEnd(6)} ${reading} ${e instanceof Error ? e.message : e}`);
    }
  }
}

if (doResolve) {
  if (!process.env["TYPESAFE_API_KEY"]) throw new Error("TYPESAFE_API_KEY missing");
  const resolver = new Resolver({
    jev: new TypeSafeJev({ apiKey: process.env["TYPESAFE_API_KEY"] }),
    search: new SearchChain(providersFromEnv(process.env)),
  });
  for (const c of cases) {
    const r = await resolver.resolve(c.reading);
    const ok = r.best ? c.expect.includes(r.best.name) : false;
    if (!ok) failed += 1;
    const detail = r.best
      ? `${r.best.name} score=${r.best.score.toFixed(2)} who=${r.best.probability.toFixed(2)} vtuber=${r.best.isVtuber.toFixed(2)} reading=${r.best.readingMatch.toFixed(2)}`
      : "見つかりませんでした";
    console.log(`${ok ? "OK  " : "FAIL"} resolve ${r.reading} → ${detail}`);
  }
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("eval:indie ok");
