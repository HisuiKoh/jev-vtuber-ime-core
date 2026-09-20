/** 読み → 表記の解決。Web 検索で根拠を集め、Jev に「どの表記がその VTuber か」を選ばせる。 */

import { type Answer, type JevClient, type Question, noulOf } from "./jev.js";
import { normalizeReading, readingCompatible } from "./kana.js";
import { SearchChain, type SearchHit, type SearchProvider } from "./search.js";

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
const HAS_JA_RE = new RegExp(`[${JA}]`, "u");
/** かな・長音・中黒・漢字・々 を 1 文字でも含むか。 */
const hasJapanese = (token: string): boolean => HAS_JA_RE.test(token);
/** 大文字または数字始まり。ラテン名 (IRyS、Gawr Gura) と小文字のボイラープレートを分ける。 */
const NAME_WORD_START_RE = /^[A-Z0-9\u2160-\u217f\uff10-\uff19\uff21-\uff3a]/u;
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
  WORD_RE.test(tok) && NAME_WORD_START_RE.test(tok) && !isStopword(tok);

/** 中黒だけの端を落とす (「・オス・」のような切れ端)。 */
const trimToken = (tok: string): string => tok.replace(/^\u30fb+|\u30fb+$/gu, "");

export interface Token {
  text: string;
  /** 元テキスト上の終了位置 (exclusive)。括弧書きの読みの直前にあるトークンを引くのに使う */
  end: number;
}

const isNameSpace = (ch: string): boolean => ch === " " || ch === "\u3000";

/**
 * テキストから名前らしいトークンを列挙する。空白 1 つで連なる名前語 (大文字始まり・非ストップワード) は
 * 2〜MAX_LATIN_WORDS 語の連結も候補にする (Gawr Gura、Ninomae Ina'nis)。
 * 日本語を含むトークンが空白 1 つ (U+0020 または U+3000) で隣り合うときは、空白なしの連結も出す (最大 2 語)。
 */
export function tokenize(text: string): Token[] {
  const matches = [...text.matchAll(TOKEN_RE)];
  const out: Token[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const single = trimToken(m[0]);
    if (single) out.push({ text: single, end: m.index + m[0].length });
    const jaNext = matches[i + 1];
    if (jaNext && hasJapanese(m[0]) && hasJapanese(jaNext[0])) {
      const gap = text.slice(m.index + m[0].length, jaNext.index);
      if (gap.length === 1 && isNameSpace(gap)) {
        const joinedJa = trimToken(m[0] + jaNext[0]);
        if (joinedJa) out.push({ text: joinedJa, end: jaNext.index + jaNext[0].length });
      }
    }
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

/** 読み案内の対象となるかな (ひらがな・カタカナ・長音・中黒)。 */
const isGuidedKana = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30fa) || c === 0x30fc || c === 0x30fb;
};

/** 漢字・々。名前の漢字列はこれで始まる。 */
const isKanjiCore = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || c === 0x3005;
};

/** 漢字列の内側に許す ヶ・ノ (月ノ美兔)。 */
const isKanjiInner = (ch: string): boolean => isKanjiCore(ch) || ch === "\u30f6" || ch === "\u30ce";

/**
 * 読みに錨を置いてテキストから表記候補を拾う。かな列が読みそのもの、または漢字 1〜4 字 + 読み末尾のかな。
 * `reading` は正規化済みひらがな。
 */
export function readingGuidedCandidates(text: string, reading: string): string[] {
  if (!reading) return [];
  const chars = [...text];
  const n = chars.length;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const suffixes: string[] = [];
  for (let k = 2; k <= reading.length - 1; k++) {
    suffixes.push(reading.slice(reading.length - k));
  }

  let i = 0;
  while (i < n) {
    if (!isGuidedKana(chars[i]!)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isGuidedKana(chars[j]!)) j++;

    for (let s = i; s < j; s++) {
      let norm = "";
      for (let e = s; e < j; e++) {
        norm += normalizeReading(chars[e]!);
        if (norm.length === 0) continue;
        if (!reading.startsWith(norm)) break;
        if (norm === reading) add(chars.slice(s, e + 1).join(""));
      }
    }

    if (suffixes.length > 0) {
      let kanjiEnd = i;
      if (kanjiEnd > 0 && isNameSpace(chars[kanjiEnd - 1]!)) kanjiEnd--;
      let kanjiStart = kanjiEnd;
      while (kanjiStart > 0 && isKanjiInner(chars[kanjiStart - 1]!)) kanjiStart--;
      while (kanjiStart < kanjiEnd && !isKanjiCore(chars[kanjiStart]!)) kanjiStart++;
      const kanjiLen = kanjiEnd - kanjiStart;
      if (kanjiLen > 0) {
        for (const suffix of suffixes) {
          let norm = "";
          let matchedEnd = -1;
          for (let e = i; e < j; e++) {
            norm += normalizeReading(chars[e]!);
            if (norm.length === 0) continue;
            if (!suffix.startsWith(norm)) break;
            if (norm === suffix) {
              matchedEnd = e + 1;
              break;
            }
          }
          if (matchedEnd < 0) continue;
          const kanaPart = chars.slice(i, matchedEnd).join("");
          const maxK = Math.min(4, kanjiLen);
          for (let len = 1; len <= maxK; len++) {
            const pieceStart = kanjiEnd - len;
            const first = chars[pieceStart];
            if (!first || !isKanjiCore(first)) continue;
            add(chars.slice(pieceStart, kanjiEnd).join("") + kanaPart);
          }
        }
      }
    }

    i = j;
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
  /** 実際に答えたプロバイダ名。チェーンなら SearchChain.lastProvider */
  providerUsed?: string | undefined;
  /** 一次プロバイダ以外が答えたか。この resolve 中のどの検索でもフォールバックなら true */
  fallback: boolean;
  hits: number;
  model?: string | undefined;
  /**
   * 検索パスの回数。セカンドチャンスの検索を発行したら 2
   * (候補が増えず Jev を再呼び出ししなかった場合も含む)。
   */
  passes: 1 | 2;
  /** 発行した検索クエリ (1st + セカンドチャンス) */
  queries: string[];
}

function searchMeta(search: SearchProvider): Pick<ResolveResult, "providerUsed" | "fallback"> {
  if (search instanceof SearchChain) {
    return { providerUsed: search.lastProvider ?? undefined, fallback: search.lastWasFallback };
  }
  return { providerUsed: search.name, fallback: false };
}

/** 検索結果から名前候補と根拠を集める。 */
export function extractCandidates(reading: string, hits: SearchHit[]): Map<string, Extracted> {
  const out = new Map<string, Extracted>();
  const add = (tok: string, url: string, confirmed: boolean): void => {
    // 全かな名は表記 = 読みなので、入力そのものも候補になる
    if (!isPlausibleName(tok)) return;
    // ラテン専用の小文字始まりは検索ボイラープレート。括弧書きで読みが確認された表記は通す
    if (!confirmed && !hasJapanese(tok) && !NAME_WORD_START_RE.test(tok)) return;
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
    for (const name of readingGuidedCandidates(text, reading)) add(name, h.url, false);
  }
  return out;
}

/** 括弧書きで読みが確認できたもの → 日本語を含むもの → 根拠の多いもの の順。 */
export function rankCandidates(found: Map<string, Extracted>): string[] {
  return [...found.entries()]
    .sort(([nameA, a], [nameB, b]) =>
      b.readingConfirmed - a.readingConfirmed ||
      Number(hasJapanese(nameB)) - Number(hasJapanese(nameA)) ||
      b.evidence.length - a.evidence.length)
    .map(([name]) => name);
}

export interface ResolverOptions {
  jev: JevClient;
  search: SearchProvider;
  /** 検索クエリ。既定は「<読み> VTuber」の 1 本 (無料枠を節約)。 */
  queries?: ((reading: string) => string)[] | undefined;
  /** 1 本目で決まらなかったときに、読みを末尾で区切ったクエリを追加で試す。既定 true。 */
  secondChance?: boolean | undefined;
  /** セカンドチャンス用のクエリ。既定は defaultSecondChanceQueries。 */
  secondChanceQueries?: ((reading: string) => string[]) | undefined;
}

interface Judged {
  candidates: ResolveCandidate[];
  best: ResolveCandidate | null;
  model?: string | undefined;
}

/**
 * 読みが 5 文字以上なら、末尾 4・3 文字の前に空白を入れた VTuber クエリ。
 * head が 2 文字未満になる分割は出さない。
 */
export function defaultSecondChanceQueries(reading: string): string[] {
  if (reading.length < 5) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [4, 3] as const) {
    const headLen = reading.length - n;
    if (headLen < 2) continue;
    const q = `${reading.slice(0, headLen)} ${reading.slice(headLen)} VTuber`;
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

export class Resolver {
  private readonly jev: JevClient;
  private readonly search: SearchProvider;
  private readonly queries: ((reading: string) => string)[];
  private readonly secondChance: boolean;
  private readonly secondChanceQueries: (reading: string) => string[];

  constructor(opts: ResolverOptions) {
    this.jev = opts.jev;
    this.search = opts.search;
    this.queries = opts.queries ?? [(r) => `${r} VTuber`];
    this.secondChance = opts.secondChance ?? true;
    this.secondChanceQueries = opts.secondChanceQueries ?? defaultSecondChanceQueries;
  }

  async resolve(rawReading: string): Promise<ResolveResult> {
    const reading = normalizeReading(rawReading);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const issued: string[] = [];
    let fallback = false;
    let providerUsed: string | undefined;

    const searchOnce = async (query: string): Promise<void> => {
      issued.push(query);
      for (const h of await this.search.search(query, 10)) {
        if (!seen.has(h.url)) {
          seen.add(h.url);
          hits.push(h);
        }
      }
      const meta = searchMeta(this.search);
      if (meta.providerUsed !== undefined) providerUsed = meta.providerUsed;
      fallback = fallback || meta.fallback;
    };

    for (const q of this.queries) {
      await searchOnce(q(reading));
    }

    const foundFirst = extractCandidates(reading, hits);
    const judgedFirst = foundFirst.size === 0 ? null : await this.judge(reading, hits, foundFirst);
    const firstBest = judgedFirst?.best ?? null;
    const scQueries = this.secondChance && firstBest === null ? this.secondChanceQueries(reading) : [];

    if (scQueries.length === 0) {
      return this.pack(reading, judgedFirst, hits, issued, 1, providerUsed, fallback);
    }

    for (const q of scQueries) {
      await searchOnce(q);
    }
    const foundSecond = extractCandidates(reading, hits);
    let gained = false;
    for (const name of foundSecond.keys()) {
      if (!foundFirst.has(name)) {
        gained = true;
        break;
      }
    }
    if (gained) {
      const judgedSecond = await this.judge(reading, hits, foundSecond);
      return this.pack(reading, judgedSecond, hits, issued, 2, providerUsed, fallback);
    }
    return this.pack(reading, judgedFirst, hits, issued, 2, providerUsed, fallback);
  }

  private pack(
    reading: string,
    judged: Judged | null,
    hits: SearchHit[],
    issued: string[],
    passes: 1 | 2,
    providerUsed: string | undefined,
    fallback: boolean,
  ): ResolveResult {
    return {
      reading,
      candidates: judged?.candidates ?? [],
      best: judged?.best ?? null,
      provider: this.search.name,
      providerUsed,
      fallback,
      hits: hits.length,
      model: judged?.model,
      passes,
      queries: issued,
    };
  }

  private async judge(reading: string, hits: SearchHit[], found: Map<string, Extracted>): Promise<Judged> {
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
    return { candidates, best, model: resp.model };
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
