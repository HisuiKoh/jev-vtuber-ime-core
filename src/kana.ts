/** かな処理と名前の分節。 */

export type SegmentKind = "kana" | "kanji" | "other";

export interface Segment {
  kind: SegmentKind;
  text: string;
}

const KANA_RE = /[\u3041-\u309f\u30a1-\u30fa\u30fc-\u30ff]/u; // 中黒 (U+30FB) は除く
const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u; // 々 含む
/** 名前の区切りとして読みに現れない文字: 空白・中黒。「グウェル・オス・ガール」の読みは「ぐうぇるおすがーる」。 */
const SEPARATOR_RE = /[\s\u3000\u30fb]/u;

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
