import { describe, expect, it } from "vitest";

import type { JevClient } from "./jev.js";
import { extractReadings, rankReadings, ReadingResolver } from "./reading.js";
import type { SearchHit, SearchProvider } from "./search.js";

const suiseiHits: SearchHit[] = [
  {
    title: "星街すいせい（ほしまちすいせい）さんは、ホロライブ（ホロライブ）所属",
    url: "https://example.test/suisei",
    snippet: "星街（ほしまち）すいせいさんは VTuber。hololive（ホロライブ） JP/ID(インドネシア)",
  },
];

const kineHits: SearchHit[] = [
  {
    title: "Vtuberの『杵月のあ（きねつきのあ）』です",
    url: "https://example.test/kine-paren",
    snippet: "個人勢のVTuber。",
  },
  {
    title: "自己紹介",
    url: "https://example.test/kine-bare",
    snippet: "はじめまして！『きねつきのあ』です。Ci-en（シエン）もやってます。",
  },
];

const guraHits: SearchHit[] = [
  {
    title: "Gawr Gura（がうる・ぐら） - Vtuberデータベース",
    url: "https://example.test/gura-paren",
    snippet: "がうるぐら（Gawr Gura）とは、ホロライブENに所属する VTuber。",
  },
  {
    title: "がうる・ぐら - Wikipedia",
    url: "https://example.test/gura-wiki",
    snippet: "Gawr Gura。",
  },
];

describe("extractReadings", () => {
  it("confirms ほしまちすいせい and drops agency / country noise", () => {
    const found = extractReadings("星街すいせい", suiseiHits);
    const ranked = rankReadings(found);
    expect(ranked[0]).toBe("ほしまちすいせい");
    expect(found.get("ほしまちすいせい")?.confirmed).toBeGreaterThan(0);
    expect(ranked).not.toContain("ほろらいぶ");
    expect(ranked).not.toContain("いんどねしあ");
  });

  it("keeps きねつきのあ from paren and bare kana with multiple evidence", () => {
    const found = extractReadings("杵月のあ", kineHits);
    expect([...found.keys()]).toContain("きねつきのあ");
    expect(found.get("きねつきのあ")?.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("confirms がうるぐら from both paren directions and keeps dotted surface", () => {
    const found = extractReadings("Gawr Gura", guraHits);
    const e = found.get("がうるぐら");
    expect(e).toBeDefined();
    expect(e!.confirmed).toBe(2);
    expect(e!.surface).toBe("がうる・ぐら");
  });
});

describe("ReadingResolver.resolve", () => {
  it("returns the chosen reading, multiplies score, and drops NONE", async () => {
    const search: SearchProvider = {
      name: "fake",
      search: async () => suiseiHits,
    };
    const jev: JevClient = {
      systemOne: async () => ({
        model: "fake-jev",
        answers: {
          reading: {
            type: "choice",
            choice: "ほしまちすいせい",
            confidence: 0.9,
            probabilities: { ほしまちすいせい: 0.9, NONE: 0.1 },
          },
          c0: { type: "noul", noul: 0.8 },
          v: { type: "noul", noul: 1 },
        },
      }),
    };
    const r = await new ReadingResolver({ jev, search }).resolve("星街すいせい");
    expect(r.best?.reading).toBe("ほしまちすいせい");
    expect(r.best?.score).toBeCloseTo(0.9 * 0.8 * 1);
    expect(r.candidates.map((c) => c.reading)).not.toContain("NONE");
    expect(r.candidates).toHaveLength(1);
  });
});
