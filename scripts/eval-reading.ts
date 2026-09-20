/**
 * 表記→読みの検索再現率。鍵が要る。既定は検索のみ。`--resolve` で Jev まで。
 *   npm run eval:reading
 *   npm run eval:reading -- --resolve 星街すいせい
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Brave, MONID_DEFAULTS, Monid, ReadingResolver, SearchChain, TypeSafeJev, extractReadings, normalizeName, providersFromEnv } from "../src/index.ts";

type Case = { name: string; expect: string[] };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(resolve(root, "eval/reading-cases.json"), "utf8")) as { cases: Case[] };
const argv = process.argv.slice(2);
const doResolve = argv.includes("--resolve");
const only = argv.filter((a) => !a.startsWith("-")).map(normalizeName);
const cases = only.length ? spec.cases.filter((c) => only.includes(normalizeName(c.name))) : spec.cases;

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
  const name = normalizeName(c.name);
  for (const pname of ["monid", "brave"] as const) {
    try {
      const hits = await provider(pname).search(`${name} VTuber 読み`, 10);
      const readings = [...extractReadings(name, hits).keys()];
      const hit = c.expect.length === 0 || c.expect.some((e) => readings.includes(e));
      if (!hit) failed += 1;
      console.log(`${hit ? "HIT " : "MISS"} ${pname.padEnd(6)} ${name} expect=${c.expect.join("|") || "∅"} readings=${readings.slice(0, 8).join("|")}`);
    } catch (e) {
      failed += 1;
      console.log(`ERR  ${pname.padEnd(6)} ${name} ${e instanceof Error ? e.message : e}`);
    }
  }
}

if (doResolve) {
  if (!process.env["TYPESAFE_API_KEY"]) throw new Error("TYPESAFE_API_KEY missing");
  const resolver = new ReadingResolver({
    jev: new TypeSafeJev({ apiKey: process.env["TYPESAFE_API_KEY"] }),
    search: new SearchChain(providersFromEnv(process.env)),
  });
  for (const c of cases) {
    const r = await resolver.resolve(c.name);
    const ok = c.expect.length === 0 ? r.best === null : r.best !== null && c.expect.includes(r.best.reading);
    if (!ok) failed += 1;
    const detail = r.best
      ? `${r.best.reading} score=${r.best.score.toFixed(2)} reading=${r.best.probability.toFixed(2)} correct=${r.best.readingCorrect.toFixed(2)} vtuber=${r.best.isVtuber.toFixed(2)}`
      : "見つかりませんでした";
    console.log(`${ok ? "OK  " : "FAIL"} resolve ${r.name} → ${detail}`);
  }
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("eval:reading ok");
