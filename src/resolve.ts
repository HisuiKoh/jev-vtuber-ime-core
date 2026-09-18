/** 読み → 表記の解決。Web 検索で根拠を集め、Jev に「どの表記がその VTuber か」を選ばせる。 */

import { type Answer, type JevClient, type Question, noulOf } from "./jev.js";
import { normalizeReading, readingCompatible } from "./kana.js";
import type { SearchHit, SearchProvider } from "./search.js";

export const NONE = "NONE";
export const MAX_CANDIDATES = 40;
/** 上位何候補に「VTuber か」「読み全体が一致するか」を訊くか。 */
export const CHECK_TOP = 10;
/** who × is_vtuber × reading_match がこれ未満なら「見つかりませんでした」。 */
export const MIN_SCORE = 0.3;

// 名前らしいトークン: かな・漢字・長音・々 の 2〜10 文字
const TOKEN_RE = /[\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff々ー]{2,10}/gu;
// 「星街すいせい（ほしまち すいせい）」のように読みが括弧書きされている箇所
const PAREN_RE = /([\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff々ー]{2,10})\s*[（(]\s*([\u3041-\u3096\u30fc\s]+?)\s*[）)]/gu;
const STOPWORDS = new Set(["チャンネル", "公式", "ホロライブ", "にじさんじ"]);

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

/** 検索結果から名前候補と根拠 URL を集める。 */
export function extractCandidates(reading: string, hits: SearchHit[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of hits) {
    const text = `${h.title} ${h.snippet}`;
    const tokens: string[] = [];
    // 括弧書きの読みが入力と一致する表記は最優先
    for (const m of text.matchAll(PAREN_RE)) {
      if (normalizeReading(m[2]!) === reading) tokens.push(m[1]!);
    }
    for (const m of text.matchAll(TOKEN_RE)) tokens.push(m[0]);
    for (const tok of tokens) {
      // 全かな名は表記 = 読みなので、入力そのものも候補になる
      if (STOPWORDS.has(tok)) continue;
      if (!readingCompatible(tok, reading)) continue;
      const urls = out.get(tok) ?? [];
      if (h.url && !urls.includes(h.url)) urls.push(h.url);
      out.set(tok, urls);
    }
  }
  return out;
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

    // 根拠の多い順。上位 MAX_CANDIDATES を Jev に渡す
    const ranked = [...found.keys()].sort((a, b) => found.get(b)!.length - found.get(a)!.length).slice(0, MAX_CANDIDATES);
    const criteria: Record<string, string | null> = Object.fromEntries(ranked.map((n) => [n, null]));
    criteria[NONE] = "None of the candidates is the VTuber with this reading";

    const questions: Record<string, Question> = {
      who: {
        type: "choice",
        instructions:
          "`reading` is the hiragana reading of a VTuber's name. `search_results` are web search hits for that " +
          "reading. Choose the candidate that is the written (official) name of the VTuber whose FULL name is read " +
          `exactly as \`reading\` (not a partial match), based on the evidence in \`search_results\`. Choose ${NONE} if none fits.`,
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
          "or if its reading differs from `reading`.",
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
      candidates.push({ name, probability: p, isVtuber, readingMatch, score: p * isVtuber * readingMatch, evidence: found.get(name) ?? [] });
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
