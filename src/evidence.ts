/** 検索ヒットから名前・読みの根拠を拾う。トークン化と括弧書きの対は読み→表記・表記→読みで共有する。 */

import { MAX_LATIN_WORDS, MAX_NAME_LENGTH, normalizeReading } from "./kana.js";

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
const KANA_INNER = "[\\u3041-\\u3096\\u30a1-\\u30fa\\u30fb\\u30fc\\s]+?";
const LATIN_INNER = `${WORD}(?: ${WORD}){0,${MAX_LATIN_WORDS - 1}}`;
/** 「X（Y）」の括弧書き。Y はかな (中黒・長音・空白可) か英字語。 */
const PAREN_PAIR_RE = new RegExp(`[（(]\\s*(${KANA_INNER}|${LATIN_INNER})\\s*[）)]`, "gu");

const STOPWORDS = new Set(
  [
    "チャンネル", "公式", "ホロライブ", "にじさんじ", "ぶいすぽ",
    "vtuber", "vtubers", "youtube", "youtuber", "twitter", "twitch", "tiktok", "channel", "ch", "official", "hololive",
    "nijisanji", "vspo", "wiki", "wikipedia", "pixiv", "fandom", "en", "jp", "id", "the", "of", "and", "live", "news",
  ].map((s) => s.toLowerCase()),
);

const DIGIT_RE = /[0-9\u2160-\u217f\uff10-\uff19]/u;
const KANA_OR_LATIN_RE = /[\u3041-\u3096\u30a1-\u30fa\u30fcA-Za-z\uff21-\uff3a\uff41-\uff5a]/u;
export const isStopword = (tok: string): boolean => STOPWORDS.has(tok.toLowerCase());

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

/** 大文字始まり (または数字始まり) の英字語で、ストップワードでないもの。空白区切りで連ねて 1 つの名前とみなす対象。 */
const isNameWord = (tok: string): boolean =>
  WORD_RE.test(tok) && /^[A-Z0-9\u2160-\u217f\uff10-\uff19\uff21-\uff3a]/u.test(tok) && !isStopword(tok);

/** 中黒だけの端を落とす (「・オス・」のような切れ端)。 */
const trimToken = (tok: string): string => tok.replace(/^\u30fb+|\u30fb+$/gu, "");

export interface Token {
  text: string;
  /** 元テキスト上の終了位置 (exclusive)。括弧書きの直前にあるトークンを引くのに使う */
  end: number;
}

export interface ParenPair {
  outer: string;
  inner: string;
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
 * 「X（Y）」の括弧書きを返す。Y はかな塊または英字語。X は括弧の直前で終わるトークンのうち最長のもの。
 * 表記（読み）も 読み（表記）も同じ形。
 */
export function parenPairs(text: string, tokens: Token[]): ParenPair[] {
  const out: ParenPair[] = [];
  for (const m of text.matchAll(PAREN_PAIR_RE)) {
    const inner = m[1]!.trim();
    if (!inner) continue;
    const before = text.slice(0, m.index).trimEnd().length;
    const ending = tokens.filter((t) => t.end === before);
    if (ending.length === 0) continue;
    const outer = ending.reduce((a, b) => (b.text.length > a.text.length ? b : a)).text;
    out.push({ outer, inner });
  }
  return out;
}

/**
 * 「表記（読み）」の括弧書きで読みが `reading` と一致する表記を返す。表記は括弧の直前で終わるトークンのうち最長のもの:
 * 「YouTube Gawr Gura（がうる・ぐら）」→「Gawr Gura」(YouTube はストップワードなので連結に入らない)。
 */
export function parenConfirmedNames(text: string, tokens: Token[], reading: string): string[] {
  const out: string[] = [];
  for (const { outer, inner } of parenPairs(text, tokens)) {
    if (normalizeReading(inner) !== reading) continue;
    out.push(outer);
  }
  return out;
}
