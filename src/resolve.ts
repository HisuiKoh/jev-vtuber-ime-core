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

// 名前を構成する文字。日本語の連なり (かな・長音・中黒・漢字・々) と、英数字・ローマ数字の語 (Ⅲ世、IRyS、Gawr Gura)。
const JA = "\\u3041-\\u3096\\u30a1-\\u30fa\\u30fb\\u30fc\\u4e00-\\u9fff\\u3005";
const ALNUM = "A-Za-z0-9\\u2160-\\u217f\\uff10-\\uff19\\uff21-\\uff3a\\uff41-\\uff5a";
// 英数字の語。' ’ . - は語の内側にだけ許す (Ina'nis、ROF-MAO、V.W.P)
const WORD = `[${ALNUM}](?:[${ALNUM}'’.\\-]*[${ALNUM}])?`;
// 日本語の連なりと英数字の語が交互に並ぶ塊 (ギルザレンⅢ世、AZKi)。JA と WORD の先頭文字は排他なので
// 分割の仕方が一意で、失敗時に指数的なバックトラックを起こさない。
const JA_RUN = `[${JA}]+`;
const TOKEN = `(?:${JA_RUN}(?:${WORD}${JA_RUN})*(?:${WORD})?|${WORD}(?:${JA_RUN}${WORD})*(?:${JA_RUN})?)`;
const TOKEN_RE = new RegExp(TOKEN, "gu");
const WORD_RE = new RegExp(`^${WORD}$`, "u");
// 名前には日本語か英字が少なくとも 1 文字は要る (年号・数字・ローマ数字だけの語を弾く)
const NAME_LETTER_RE = new RegExp(`[${JA}A-Za-z\\uff21-\\uff3a\\uff41-\\uff5a]`, "u");
const KANJI_ONLY_RE = /^[\u4e00-\u9fff\u3005]$/u;
// 「星街すいせい（ほしまち すいせい）」「Gawr Gura（がうる・ぐら）」のように括弧書きされた読み。表記側は直前のトークンを位置で引く
const PAREN_READING_RE = /[（(]\s*([\u3041-\u3096\u30a1-\u30fa\u30fb\u30fc\s]+?)\s*[）)]/gu;
/** 空白区切りの英字名は最大何語までを 1 つの名前とみなすか (Ninomae Ina'nis、Kizuna AI) */
const MAX_LATIN_WORDS = 3;
/** 表記の最大文字数。読みの上限 (20) に中黒などが加わる分だけ余裕を持たせる */
export const MAX_NAME_LENGTH = 24;
const STOPWORDS = new Set(
  [
    "チャンネル", "公式", "ホロライブ", "にじさんじ", "ぶいすぽ",
    "vtuber", "vtubers", "youtube", "youtuber", "twitter", "twitch", "tiktok", "channel", "ch", "official", "hololive",
    "nijisanji", "vspo", "wiki", "wikipedia", "pixiv", "fandom", "en", "jp", "id", "the", "of", "and", "live", "news",
  ].map((s) => s.toLowerCase()),
);

const DIGIT_RE = /[0-9\u2160-\u217f\uff10-\uff19]/u;
const KANA_OR_LATIN_RE = /[\u3041-\u3096\u30a1-\u30fa\u30fcA-Za-z\uff21-\uff3a\uff41-\uff5a]/u;
const isStopword = (tok: string): boolean => STOPWORDS.has(tok.toLowerCase());

/**
 * 名前としてあり得るトークンか。1 文字は漢字のみ (叶)。数字・ローマ数字を含むなら、かなか英字も要る
 * (ギルザレンⅢ世 は通し、2024年・5期生 は弾く)。
 */
export function isPlausibleName(token: string): boolean {
  const len = [...token].length;
  if (len === 0 || len > MAX_NAME_LENGTH) return false;
  if (isStopword(token)) return false;
  if (len === 1) return KANJI_ONLY_RE.test(token);
  if (DIGIT_RE.test(token) && !KANA_OR_LATIN_RE.test(token)) return false;
  return NAME_LETTER_RE.test(token);
}

/** 名前候補と、その根拠。 */
export interface Extracted {
  /** 根拠 URL */
  evidence: string[];
  /** 「表記（読み）」の括弧書きで読みが入力と一致した回数。抽出段階で得られる最も強い根拠 */
  readingConfirmed: number;
}

/** 大文字始まり (または数字始まり) の英字語で、ストップワードでないもの。空白区切りで連ねて 1 つの名前とみなす対象。 */
const isNameWord = (tok: string): boolean =>
  WORD_RE.test(tok) && /^[A-Z0-9\u2160-\u217f\uff10-\uff19\uff21-\uff3a]/u.test(tok) && !isStopword(tok);

/** 中黒だけの端を落とす (「・オス・」のような切れ端)。 */
const trimToken = (tok: string): string => tok.replace(/^\u30fb+|\u30fb+$/gu, "");

export interface Token {
  text: string;
  /** 元テキスト上の終了位置 (exclusive)。括弧書きの読みの直前にあるトークンを引くのに使う */
  end: number;
}

/**
 * テキストから名前らしいトークンを列挙する。空白 1 つで連なる名前語 (大文字始まり・非ストップワード) は
 * 2〜MAX_LATIN_WORDS 語の連結も候補にする (Gawr Gura、Ninomae Ina'nis)。
 */
export function tokenize(text: string): Token[] {
  const matches = [...text.matchAll(TOKEN_RE)];
  const out: Token[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const single = trimToken(m[0]);
    if (single) out.push({ text: single, end: m.index + m[0].length });
    if (!isNameWord(m[0])) continue;
    let joined = m[0];
    let end = m.index + m[0].length;
    for (let j = i + 1; j < matches.length && j - i < MAX_LATIN_WORDS; j++) {
      const next = matches[j]!;
      if (text.slice(end, next.index) !== " " || !isNameWord(next[0])) break;
      joined += ` ${next[0]}`;
      end = next.index + next[0].length;
      out.push({ text: joined, end });
    }
  }
  return out;
}

/**
 * 「表記（読み）」の括弧書きで読みが `reading` と一致する表記を返す。表記は括弧の直前で終わるトークンのうち最長のもの:
 * 「YouTube Gawr Gura（がうる・ぐら）」→「Gawr Gura」(YouTube はストップワードなので連結に入らない)。
 */
export function parenConfirmedNames(text: string, tokens: Token[], reading: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PAREN_READING_RE)) {
    if (normalizeReading(m[1]!) !== reading) continue;
    const before = text.slice(0, m.index).trimEnd().length;
    const ending = tokens.filter((t) => t.end === before);
    if (ending.length === 0) continue;
    out.push(ending.reduce((a, b) => (b.text.length > a.text.length ? b : a)).text);
  }
  return out;
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
