/** かな処理と名前の分節。入力が読みか表記かの判定も含む。 */

export type SegmentKind = "kana" | "kanji" | "other";
export type Direction = "reading" | "name" | "invalid";

export interface Segment {
  kind: SegmentKind;
  text: string;
}

const KANA_RE = /[\u3041-\u309f\u30a1-\u30fa\u30fc-\u30ff]/u; // 中黒 (U+30FB) は除く
const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u; // 々 含む
/** 名前の区切りとして読みに現れない文字: 空白・中黒。「グウェル・オス・ガール」の読みは「ぐうぇるおすがーる」。 */
const SEPARATOR_RE = /[\s\u3000\u30fb]/u;
/** 表記の最大文字数。読みの上限 (20) に中黒などが加わる分だけ余裕を持たせる */
export const MAX_NAME_LENGTH = 24;
/** 空白区切りの英字名は最大何語までを 1 つの名前とみなすか (Ninomae Ina'nis、Kizuna AI) */
export const MAX_LATIN_WORDS = 3;

const NAME_CHAR_RE = /^[\u3041-\u3096\u30a1-\u30fa\u30fb\u30fc\u4e00-\u9fff\u3005A-Za-z0-9\u2160-\u217f'’.\- ]+$/u;
const KANA_ONLY_RE = /^[\u3041-\u3096\u30a1-\u30fa\u30fb\u30fc]+$/u;
const LATIN_WORD_RE = /^[A-Za-z0-9\u2160-\u217f](?:[A-Za-z0-9\u2160-\u217f'’.\-]*[A-Za-z0-9\u2160-\u217f])?$/u;
const KANJI_ONLY_CHAR_RE = /^[\u4e00-\u9fff\u3005]$/u;
const DIGIT_RE = /[0-9\u2160-\u217f]/u;
const KANA_OR_LATIN_RE = /[\u3041-\u3096\u30a1-\u30fa\u30fcA-Za-z]/u;
const NAME_LETTER_RE = /[\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff\u3005A-Za-z]/u;

/** カタカナ → ひらがな (ァ..ヶ)。長音「ー」はそのまま。 */
export function kataToHira(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

/** 入力の読みを正規化する: NFKC、カナ→かな、空白・中黒除去。キャッシュのキーにも使う。 */
export function normalizeReading(input: string): string {
  return kataToHira(input.normalize("NFKC")).replace(/[\s\u3000\u30fb]+/gu, "");
}

/** 読みとして受け付けるか (ひらがな・カタカナ・長音のみ、1〜20 文字)。公開時の入力制限。 */
export function isValidReading(reading: string): boolean {
  return /^[\u3041-\u3096\u30a1-\u30fa\u30fc]{1,20}$/u.test(reading);
}

/** 入力の表記を正規化する: NFKC、前後トリム、連続空白を半角 1 つに畳む。かな変換はしない。 */
export function normalizeName(text: string): string {
  return text.normalize("NFKC").trim().replace(/[\s\u3000]+/gu, " ");
}

/**
 * 表記として受け付けるか。かなだけは読みなので false。括弧・ URL 文字は弾く。
 * 1 文字は漢字のみ (叶)。数字だけ・年号は弾く。
 */
export function isValidName(text: string): boolean {
  const n = normalizeName(text);
  const len = [...n].length;
  if (len < 1 || len > MAX_NAME_LENGTH) return false;
  if (!NAME_CHAR_RE.test(n)) return false;
  const compact = n.replace(/[\s\u30fb]/gu, "");
  if (KANA_ONLY_RE.test(compact)) return false;
  const parts = n.split(" ");
  if (parts.length > MAX_LATIN_WORDS) return false;
  if (parts.length > 1 && !parts.every((p) => LATIN_WORD_RE.test(p))) return false;
  if (len === 1) return KANJI_ONLY_CHAR_RE.test(n);
  if (DIGIT_RE.test(n) && !KANA_OR_LATIN_RE.test(n)) return false;
  return NAME_LETTER_RE.test(n);
}

export function detectDirection(text: string): Direction {
  if (isValidReading(normalizeReading(text))) return "reading";
  if (isValidName(text)) return "name";
  return "invalid";
}

export function segment(name: string): Segment[] {
  const out: Segment[] = [];
  for (const ch of name) {
    if (SEPARATOR_RE.test(ch)) continue;
    const kind: SegmentKind = KANA_RE.test(ch) ? "kana" : KANJI_RE.test(ch) ? "kanji" : "other";
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else out.push({ kind, text: ch });
  }
  return out;
}

/**
 * 名前の「かな部分」は読みそのままなので、それが reading に順序どおり含まれなければ全体の読みではあり得ない。
 * Jev に渡す前の決定的フィルタ。漢字部分の読みは判定しない (それは Jev と根拠の仕事)。
 */
export function readingCompatible(name: string, reading: string): boolean {
  const segs = segment(name);
  if (segs.some((s) => s.kind === "other")) return true; // 英字などは判定できないので通す
  let kanaTotal = 0;
  let pos = 0;
  for (const s of segs) {
    if (s.kind !== "kana") continue;
    const r = kataToHira(s.text);
    const i = reading.indexOf(r, pos);
    if (i < 0) return false;
    pos = i + r.length;
    kanaTotal += r.length;
  }
  const hasKanji = segs.some((s) => s.kind === "kanji");
  if (!hasKanji) return kanaTotal === reading.length; // 全かな名は完全一致
  return kanaTotal < reading.length; // 漢字があるなら、その読みの分だけ reading が長いはず
}
