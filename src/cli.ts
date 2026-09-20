#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { TypeSafeJev } from "./jev.js";
import { isValidReading, normalizeReading } from "./kana.js";
import { MIN_SCORE, Resolver, type ResolveResult } from "./resolve.js";
import { SearchChain, SearchExhausted, providersFromEnv } from "./search.js";

const providerLabel = (r: ResolveResult): string => {
  const base = r.providerUsed && r.providerUsed !== r.provider ? `${r.provider} via ${r.providerUsed}` : r.provider;
  return r.passes === 2 ? `${base} (2nd pass)` : base;
};

/** カレントディレクトリ → パッケージルート の順で .env を探し、未設定の変数だけ環境に入れる。 */
function loadDotenv(): void {
  const pkgRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  for (const dir of [process.cwd(), pkgRoot]) {
    let text: string;
    try {
      text = readFileSync(resolvePath(dir, ".env"), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

function usage(): void {
  console.error("usage: jev-vtuber-ime [-v] [--json] <読み> [<読み> ...]");
}

async function main(argv: string[]): Promise<number> {
  loadDotenv();
  const verbose = argv.includes("-v") || argv.includes("--verbose");
  const json = argv.includes("--json");
  const readings = argv.filter((a) => !a.startsWith("-"));
  if (readings.length === 0) {
    usage();
    return 2;
  }
  const apiKey = process.env["TYPESAFE_API_KEY"];
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY が設定されていません。環境変数か .env (.env.example 参照) で指定してください。");
    return 2;
  }
  const resolver = new Resolver({ jev: new TypeSafeJev({ apiKey }), search: new SearchChain(providersFromEnv(process.env)) });

  const results = [];
  for (const raw of readings) {
    const reading = normalizeReading(raw);
    if (!isValidReading(reading)) {
      console.log(`${raw} → 読み (ひらがな/カタカナ、20 文字以内) を入力してください`);
      continue;
    }
    try {
      const r = await resolver.resolve(reading);
      results.push(r);
      if (json) continue;
      if (r.best) {
        console.log(
          `${r.reading} → ${r.best.name}  (who ${r.best.probability.toFixed(2)} × vtuber ${r.best.isVtuber.toFixed(2)} × ` +
            `reading ${r.best.readingMatch.toFixed(2)}, ${providerLabel(r)}, ${r.hits} hits)`,
        );
      } else {
        console.log(`${r.reading} → 見つかりませんでした  [${providerLabel(r)}, ${r.hits} hits]`);
      }
      if (verbose) {
        for (const c of r.candidates.slice(0, 6)) {
          if (c.probability < 0.005) continue;
          const mark = c.score >= MIN_SCORE ? "*" : " ";
          console.log(
            `  ${mark} ${c.name.padEnd(14)} who=${c.probability.toFixed(2)} vtuber=${c.isVtuber.toFixed(2)} ` +
              `reading=${c.readingMatch.toFixed(2)}  ${c.evidence[0] ?? ""}`,
          );
        }
      }
    } catch (e) {
      if (e instanceof SearchExhausted) {
        console.log(`${reading} → 本日の検索は終了しました  (${e.message})`);
      } else {
        throw e;
      }
    }
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
