import { describe, expect, it } from "vitest";

import { isValidReading, kataToHira, normalizeReading, readingCompatible, segment } from "./kana.js";
import { extractCandidates } from "./resolve.js";

describe("kana", () => {
  it("normalizes katakana, width and spaces", () => {
    expect(normalizeReading("ホシマチ　スイセイ")).toBe("ほしまちすいせい");
    expect(normalizeReading("ｼﾞｮｵ")).toBe("じょお");
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
});
