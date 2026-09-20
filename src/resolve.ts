/** 読み → 表記の解決。Web 検索で根拠を集め、Jev に「どの表記がその VTuber か」を選ばせる。 */

import { parenConfirmedNames, isPlausibleName, tokenize } from "./evidence.js";
import { type Answer, type JevClient, type Question, noulOf } from "./jev.js";
import { normalizeReading, readingCompatible } from "./kana.js";
import type { SearchHit, SearchProvider } from "./search.js";

export { isPlausibleName, parenConfirmedNames, tokenize } from "./evidence.js";
export type { Token } from "./evidence.js";
export { MAX_NAME_LENGTH } from "./kana.js";

export const NONE = "NONE";
export const MAX_CANDIDATES = 40;
/** 上位何候補に「VTuber か」「読み全体が一致するか」を訊くか。 */
export const CHECK_TOP = 10;
/** who × is_vtuber × reading_match がこれ未満なら「見つかりませんでした」。 */
export const MIN_SCORE = 0.3;

/** 名前候補と、その根拠。 */
export interface Extracted {
  /** 根拠 URL */
  evidence: string[];
  /** 「表記（読み）」の括弧書きで読みが入力と一致した回数。抽出段階で得られる最も強い根拠 */
  readingConfirmed: number;
}

export interface ResolveCandidate {
  name: string;
  /** who (Choice) の確率 */
  probability: number;
  /** 候補ごとの Noul。VTuber でないものは返さない (実在人物を解決する道具にしない) */
  isVtuber: number;
  /** 候補ごとの Noul。名前全体の読みが reading と一致するか (断片を弾く) */
  readingMatch: number;
  /** probability × isVtuber × readingMatch */
  score: number;
  /** 根拠 URL */
  evidence: string[];
}

export interface ResolveResult {
  reading: string;
  /** score 降順。MIN_SCORE 未満も含む (表示側で切る) */
  candidates: ResolveCandidate[];
  /** MIN_SCORE 以上の最上位。無ければ null = 見つかりませんでした */
  best: ResolveCandidate | null;
  provider: string;
  hits: number;
  model?: string | undefined;
}

/** 検索結果から名前候補と根拠を集める。 */
export function extractCandidates(reading: string, hits: SearchHit[]): Map<string, Extracted> {
  const out = new Map<string, Extracted>();
  const add = (tok: string, url: string, confirmed: boolean): void => {
    // 全かな名は表記 = 読みなので、入力そのものも候補になる
    if (!isPlausibleName(tok)) return;
    if (!readingCompatible(tok, reading)) return;
    const e = out.get(tok) ?? { evidence: [], readingConfirmed: 0 };
    if (url && !e.evidence.includes(url)) e.evidence.push(url);
    if (confirmed) e.readingConfirmed++;
    out.set(tok, e);
  };
  for (const h of hits) {
    const text = `${h.title} ${h.snippet}`;
    const tokens = tokenize(text);
    // 括弧書きの読みが入力と一致する表記は最優先
    for (const name of parenConfirmedNames(text, tokens, reading)) add(name, h.url, true);
    for (const t of tokens) add(t.text, h.url, false);
  }
  return out;
}

/** 括弧書きで読みが確認できたもの → 根拠の多いもの の順。 */
export function rankCandidates(found: Map<string, Extracted>): string[] {
  return [...found.entries()]
    .sort(([, a], [, b]) => b.readingConfirmed - a.readingConfirmed || b.evidence.length - a.evidence.length)
    .map(([name]) => name);
}

export interface ResolverOptions {
  jev: JevClient;
  search: SearchProvider;
  /** 検索クエリ。既定は「<読み> VTuber」の 1 本 (無料枠を節約)。 */
  queries?: ((reading: string) => string)[];
}

export class Resolver {
  private readonly jev: JevClient;
  private readonly search: SearchProvider;
  private readonly queries: ((reading: string) => string)[];

  constructor(opts: ResolverOptions) {
    this.jev = opts.jev;
    this.search = opts.search;
    this.queries = opts.queries ?? [(r) => `${r} VTuber`];
  }

  async resolve(rawReading: string): Promise<ResolveResult> {
    const reading = normalizeReading(rawReading);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const q of this.queries) {
      for (const h of await this.search.search(q(reading), 10)) {
        if (!seen.has(h.url)) {
          seen.add(h.url);
          hits.push(h);
        }
      }
    }
    const found = extractCandidates(reading, hits);
    if (found.size === 0) {
      return { reading, candidates: [], best: null, provider: this.search.name, hits: hits.length };
    }

    // 上位 MAX_CANDIDATES を Jev に渡す
    const ranked = rankCandidates(found).slice(0, MAX_CANDIDATES);
    const criteria: Record<string, string | null> = Object.fromEntries(ranked.map((n) => [n, null]));
    criteria[NONE] = "None of the candidates is the VTuber with this reading";

    const questions: Record<string, Question> = {
      who: {
        type: "choice",
        instructions:
          "`reading` is the hiragana reading of a VTuber's name. `search_results` are web search hits for that " +
          "reading. Choose the candidate that is the written (official) name of the VTuber whose FULL name is read " +
          "exactly as `reading` (not a partial match), based on the evidence in `search_results`. A VTuber may be listed " +
          "with several names side by side (「A / B」, 「A（B）」, 「A - B」): those are separate names, so choose the one " +
          `that is read as \`reading\`. Choose ${NONE} if none fits.`,
        criteria,
      },
    };
    // 候補ごとに「VTuber か」「名前全体の読みが一致するか」を独立に訊く (同じ 1 コールに載る)。
    const checked = ranked.slice(0, CHECK_TOP);
    checked.forEach((n, i) => {
      questions[`v${i}`] = {
        type: "noul",
        instructions:
          `According to the evidence in \`search_results\`, is 「${n}」 a VTuber (virtual YouTuber / virtual liver: ` +
          "a streamer or video creator who appears as a 2D/3D avatar)? Answer no for real-life celebrities, voice " +
          "actors, ordinary people, places, and common nouns.",
      };
      questions[`r${i}`] = {
        type: "noul",
        instructions:
          `Is 「${n}」 a complete name (not a fragment or part of a longer name) whose entire reading is exactly ` +
          `\`reading\`? Use the evidence in \`search_results\`. Answer no if 「${n}」 is only part of a longer name, ` +
          "or if its reading differs from `reading`. Another name written next to it as an alias (「A / B」, 「A（B）」, " +
          "「A - B」) is a separate name and does not make 「" + n + "」 a fragment.",
      };
    });

    const resp = await this.jev.systemOne(
      { reading, search_results: hits.slice(0, 16).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })) },
      questions,
    );
    const who = resp.answers["who"];
    const probabilities = who ? choiceProbabilities(who) : {};

    const candidates: ResolveCandidate[] = [];
    for (const [name, p] of Object.entries(probabilities)) {
      if (name === NONE) continue;
      const i = checked.indexOf(name);
      const isVtuber = i >= 0 ? noulOf(resp.answers[`v${i}`]) : 0;
      const readingMatch = i >= 0 ? noulOf(resp.answers[`r${i}`]) : 0;
      candidates.push({ name, probability: p, isVtuber, readingMatch, score: p * isVtuber * readingMatch, evidence: found.get(name)?.evidence ?? [] });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] && candidates[0].score >= MIN_SCORE ? candidates[0] : null;
    return { reading, candidates, best, provider: this.search.name, hits: hits.length, model: resp.model };
  }
}

function choiceProbabilities(answer: Answer): Record<string, number> {
  switch (answer.type) {
    case "choice":
      return answer.probabilities;
    case "noul":
      return {};
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}
