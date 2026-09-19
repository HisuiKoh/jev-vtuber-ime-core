import { describe, expect, it } from "vitest";

import { isValidReading, kataToHira, normalizeReading, readingCompatible, segment } from "./kana.js";
import { extractCandidates, isPlausibleName, rankCandidates, tokenize } from "./resolve.js";

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
    expect(names("ぎるざれんさんせい", "ギルザレンⅢ世 にじさんじ所属 - YouTube")).toEqual(["ギルザレンⅢ世"]);
    expect(names("ぐうぇるおすがーる", "グウェル・オス・ガール にじさんじ VTuber ・オス・")).toEqual(["グウェル・オス・ガール"]);
    expect(names("ないおとん", "ないおトン / 渡辺太 - YouTube")).toEqual(["ないおトン", "渡辺太"]);
    expect(names("かなえ", "叶 - YouTube 叶（かなえ）にじさんじ所属")[0]).toBe("叶");
    expect(names("あいりす", "IRyS Ch. hololive-EN")).toContain("IRyS");
    expect(names("にのまえいなにす", "Ninomae Ina'nis Ch. hololive-EN")).toContain("Ninomae Ina'nis");
  });

  it("ranks the token confirmed by a parenthesised reading first and trims leading stopwords", () => {
    const ranked = names("がうるぐら", "YouTube Gawr Gura（がうる・ぐら）は hololive English 所属 VTuber Gawr Gura");
    expect(ranked[0]).toBe("Gawr Gura");
    expect(ranked).not.toContain("YouTube Gawr Gura");
    expect(names("あいりす", "hololive-EN IRyS（アイリス）")[0]).toBe("IRyS");
  });
});
