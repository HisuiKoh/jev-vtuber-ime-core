import { describe, expect, it } from "vitest";

import { isValidReading, kataToHira, normalizeReading, readingCompatible, segment } from "./kana.js";
import { extractCandidates, isPlausibleName, rankCandidates, readingGuidedCandidates, tokenize } from "./resolve.js";

const names = (reading: string, text: string): string[] =>
  rankCandidates(extractCandidates(reading, [{ title: text, url: "https://example.com", snippet: "" }]));

describe("kana", () => {
  it("normalizes katakana, width, spaces and middle dots", () => {
    expect(normalizeReading("ホシマチ　スイセイ")).toBe("ほしまちすいせい");
    expect(normalizeReading("ｼﾞｮｵ")).toBe("じょお");
    expect(normalizeReading("グウェル・オス・ガール")).toBe("ぐうぇるおすがーる");
    expect(kataToHira("マリンー")).toBe("まりんー");
  });

  it("validates readings", () => {
    expect(isValidReading("ほしまちすいせい")).toBe(true);
    expect(isValidReading("星街")).toBe(false);
    expect(isValidReading("")).toBe(false);
    expect(isValidReading("あ".repeat(20))).toBe(true);
    expect(isValidReading("あ".repeat(21))).toBe(false);
    expect(isValidReading(normalizeReading("ウサダペコラ"))).toBe(true);
  });

  it("segments names", () => {
    expect(segment("月ノ美兎")).toEqual([
      { kind: "kanji", text: "月" },
      { kind: "kana", text: "ノ" },
      { kind: "kanji", text: "美兎" },
    ]);
  });

  it("readingCompatible keeps possible full names and drops fragments", () => {
    expect(readingCompatible("星街すいせい", "ほしまちすいせい")).toBe(true);
    expect(readingCompatible("さくらみこ", "さくらみこ")).toBe(true);
    expect(readingCompatible("さくらみこ", "さくら")).toBe(false); // 全かな名は完全一致
    expect(readingCompatible("碧依さくらさん", "さくら")).toBe(false);
    expect(readingCompatible("碧依", "さくら")).toBe(true); // 漢字のみは通す (Jev の reading_match が弾く)
    expect(readingCompatible("Mori Calliope", "もりかりおぺ")).toBe(true);
    expect(readingCompatible("杵月のあ", "きねつきのあ")).toBe(true);
    // 中黒・ローマ数字は読みに現れないので無視して比較する
    expect(readingCompatible("グウェル・オス・ガール", "ぐうぇるおすがーる")).toBe(true);
    expect(readingCompatible("ギルザレンⅢ世", "ぎるざれんさんせい")).toBe(true);
    expect(readingCompatible("ないおトン", "ないおとん")).toBe(true);
  });
});

describe("tokenize", () => {
  it("keeps symbols inside names and joins capitalised latin words", () => {
    const texts = tokenize("ギルザレンⅢ世（ぎるざれん さんせい） - Gawr Gura Ch. hololive-EN V.W.P 2024年").map((t) => t.text);
    expect(texts).toContain("ギルザレンⅢ世");
    expect(texts).toContain("Gawr Gura");
    expect(texts).toContain("V.W.P");
    expect(texts).not.toContain("Gawr Gura Ch"); // ストップワードで連結を切る
    expect(texts).not.toContain("Ch.");
  });

  it("does not backtrack exponentially on long runs", () => {
    const long = "あ".repeat(80) + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4) + "漢".repeat(80) + "（ぎるざれん）";
    const t = Date.now();
    extractCandidates("ぎるざれんさんせい", [{ title: long, url: "https://x", snippet: long }]);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("isPlausibleName", () => {
  it("allows single kanji, rejects numerals-only and stopwords", () => {
    expect(isPlausibleName("叶")).toBe(true);
    expect(isPlausibleName("の")).toBe(false);
    expect(isPlausibleName("2024年")).toBe(false);
    expect(isPlausibleName("5期生")).toBe(false);
    expect(isPlausibleName("ギルザレンⅢ世")).toBe(true);
    expect(isPlausibleName("IRyS")).toBe(true);
    expect(isPlausibleName("YouTube")).toBe(false);
    expect(isPlausibleName("あ".repeat(25))).toBe(false);
  });
});

describe("extractCandidates", () => {
  it("prefers names with a matching parenthesised reading and keeps kana-only names", () => {
    const hits = [
      { title: "兎田ぺこら（うさだ ぺこら）とは", url: "https://a", snippet: "ホロライブ所属のVTuber。" },
      { title: "さくらみこ - YouTube", url: "https://b", snippet: "エリート巫女VTuber さくらみこ のチャンネル" },
    ];
    expect([...extractCandidates("うさだぺこら", hits).keys()]).toContain("兎田ぺこら");
    expect([...extractCandidates("さくらみこ", hits).keys()]).toContain("さくらみこ");
    expect([...extractCandidates("さくらみこ", hits).keys()]).not.toContain("チャンネル");
  });

  it("extracts names with roman numerals, middle dots, single kanji and latin letters", () => {
    expect(names("ぎるざれんさんせい", "ギルザレンⅢ世 にじさんじ所属 - YouTube")).toContain("ギルザレンⅢ世");
    expect(names("ぎるざれんさんせい", "ギルザレンⅢ世 にじさんじ所属 - YouTube")[0]).toBe("ギルザレンⅢ世");
    expect(names("ぐうぇるおすがーる", "グウェル・オス・ガール にじさんじ VTuber ・オス・")).toEqual(["グウェル・オス・ガール"]);
    expect(names("ないおとん", "ないおトン / 渡辺太 - YouTube")).toEqual(["ないおトン", "渡辺太"]);
    expect(names("かなえ", "叶 - YouTube 叶（かなえ）にじさんじ所属")[0]).toBe("叶");
    expect(names("あいりす", "IRyS Ch. hololive-EN")).toContain("IRyS");
    expect(names("あいりす", "IRyS Ch. hololive-EN")).not.toContain("hololive-EN");
    expect(names("にのまえいなにす", "Ninomae Ina'nis Ch. hololive-EN")).toContain("Ninomae Ina'nis");
    expect(names("よすみ", "yosumi（よすみ） 個人勢のバーチャルYouTuber")).toContain("yosumi");
  });

  it("ranks the token confirmed by a parenthesised reading first and trims leading stopwords", () => {
    const ranked = names("がうるぐら", "YouTube Gawr Gura（がうる・ぐら）は hololive English 所属 VTuber Gawr Gura");
    expect(ranked[0]).toBe("Gawr Gura");
    expect(ranked).not.toContain("YouTube Gawr Gura");
    expect(names("あいりす", "hololive-EN IRyS（アイリス）")[0]).toBe("IRyS");
  });

  it("keeps 杵月のあ when the parenthesised reading matches きねつきのあ", () => {
    const hits = [
      { title: "杵月のあ（きねつきのあ）", url: "https://example.test/kine", snippet: "個人勢のVTuber。" },
    ];
    expect([...extractCandidates("きねつきのあ", hits).keys()]).toContain("杵月のあ");
  });

  it("ranks Japanese names ahead of latin search boilerplate and drops lowercase latin noise", () => {
    const ranked = names(
      "よみ",
      "We've detected that JavaScript is disabled in this browser. Please enable JavaScript... " +
        "About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy & Safety How YouTube works Test new features © 2026 Google LLC " +
        "夜魅🍷 -Yomi- (@Yomi_Vtuber) on X 堕天使系Vtuberの夜魅(よみ)です",
    );
    expect(ranked).toContain("夜魅");
    const yomiAt = ranked.indexOf("夜魅");
    const firstLatinAt = ranked.findIndex((n) => !/[\u3041-\u3096\u30a1-\u30fa\u30fb\u30fc\u4e00-\u9fff\u3005]/u.test(n));
    expect(firstLatinAt).toBeGreaterThanOrEqual(0);
    expect(yomiAt).toBeLessThan(firstLatinAt);
    expect(ranked).not.toContain("detected");
    expect(ranked).not.toContain("disabled");
    expect(ranked).not.toContain("browser");
  });

  it("joins a Japanese family/given pair split by one space", () => {
    expect(names("ねこつきたくみん", "【ゲームチャンネル】猫月 たくみん -nekotsuki takumin-")).toContain("猫月たくみん");
  });

  it("cuts a name glued to surrounding text using the reading as an anchor", () => {
    const glued = names("ねこつきたくみん", "※ 猫月たくみんさん視点 → https://youtu.be/x");
    expect(glued).toContain("猫月たくみん");
    expect(glued).not.toContain("猫月たくみんさん視点");
    expect(names("うらどりぺあ", "気圧と休日に発生する用事というイベントにうらどりぺあ、ついに壊れる")).toContain("うらどりぺあ");
  });

  it("keeps mixed-script kana that normalizes to the reading", () => {
    expect(readingGuidedCandidates("麻雀プロVtuberのないおトン / 渡辺太", "ないおとん")).toContain("ないおトン");
  });

  it("still ranks a parenthesised Japanese name first", () => {
    expect(names("うさだぺこら", "兎田ぺこら（うさだ ぺこら）とは")[0]).toBe("兎田ぺこら");
  });

  it("stays fast on long kana and kanji runs", () => {
    const text = "あ".repeat(300) + "漢".repeat(300);
    const t = Date.now();
    extractCandidates("あ".repeat(20), [{ title: text, url: "https://x", snippet: text }]);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
