import { describe, expect, it } from "vitest";

import { type Answer, type JevClient, type Question, type SystemOneResponse } from "./jev.js";
import { NONE, Resolver, defaultSecondChanceQueries } from "./resolve.js";
import { type SearchHit, type SearchProvider } from "./search.js";

const TARGET = "狐火えあこん";

const foxNoise: SearchHit = {
  title: "きつねびえあこん まとめサイト",
  url: "https://news.example/fox",
  snippet: "キツネの話題",
};

const channelHit: SearchHit = {
  title: "狐火えあこん - YouTube",
  url: "https://www.youtube.com/kitunebi",
  snippet: "狐火えあこん のチャンネル",
};

/** who=1.0 は TARGET と一致する候補だけ。その v/r は 0.95、それ以外は 0。 */
function fakeJev(calls: { n: number }): JevClient {
  return {
    async systemOne(_state, questions: Record<string, Question>): Promise<SystemOneResponse> {
      calls.n += 1;
      const whoQ = questions["who"];
      const probabilities: Record<string, number> = {};
      if (whoQ?.type === "choice") {
        for (const name of Object.keys(whoQ.criteria)) {
          probabilities[name] = name === TARGET ? 1 : 0;
        }
      }
      const answers: Record<string, Answer> = {
        who: {
          type: "choice",
          choice: probabilities[TARGET] === 1 ? TARGET : NONE,
          confidence: 1,
          probabilities,
        },
      };
      for (const [key, q] of Object.entries(questions)) {
        if (q.type !== "noul") continue;
        const m = q.instructions.match(/「(.+?)」/u);
        answers[key] = { type: "noul", noul: m?.[1] === TARGET ? 0.95 : 0 };
      }
      return { answers };
    },
  };
}

function dispatchSearch(hitsByQuery: Record<string, SearchHit[]>, queries: string[]): SearchProvider {
  return {
    name: "fake",
    async search(query: string): Promise<SearchHit[]> {
      queries.push(query);
      return hitsByQuery[query] ?? [foxNoise];
    },
  };
}

describe("defaultSecondChanceQueries", () => {
  it("splits 5+ mora readings before the last 4 and last 3 kana, skipping a short head", () => {
    expect(defaultSecondChanceQueries("きつねびえあこん")).toEqual([
      "きつねび えあこん VTuber",
      "きつねびえ あこん VTuber",
    ]);
    expect(defaultSecondChanceQueries("さくらみこ")).toEqual(["さく らみこ VTuber"]);
    expect(defaultSecondChanceQueries("みこ")).toEqual([]);
  });
});

describe("Resolver second chance", () => {
  it("re-searches with a space before the given name and re-judges when a new candidate appears", async () => {
    const issued: string[] = [];
    const jevCalls = { n: 0 };
    const search = dispatchSearch(
      {
        "きつねび えあこん VTuber": [channelHit],
      },
      issued,
    );
    const r = await new Resolver({ jev: fakeJev(jevCalls), search }).resolve("きつねびえあこん");
    expect(r.best?.name).toBe(TARGET);
    expect(r.passes).toBe(2);
    expect(r.queries).toHaveLength(3);
    expect(r.queries).toEqual([
      "きつねびえあこん VTuber",
      "きつねび えあこん VTuber",
      "きつねびえ あこん VTuber",
    ]);
    expect(jevCalls.n).toBe(2);
    expect(issued).toHaveLength(3);
  });

  it("does not call Jev again when second-chance hits add no new names (passes is still 2)", async () => {
    const issued: string[] = [];
    const jevCalls = { n: 0 };
    // 全クエリが同じ URL を返すので、セカンドチャンスで候補は増えない
    const search = dispatchSearch({}, issued);
    const r = await new Resolver({ jev: fakeJev(jevCalls), search }).resolve("きつねびえあこん");
    expect(r.best).toBeNull();
    expect(r.passes).toBe(2);
    expect(r.queries).toHaveLength(3);
    expect(jevCalls.n).toBe(1);
    expect(issued).toHaveLength(3);
  });

  it("issues a single search when secondChance is false", async () => {
    const issued: string[] = [];
    const jevCalls = { n: 0 };
    const search = dispatchSearch({}, issued);
    const r = await new Resolver({ jev: fakeJev(jevCalls), search, secondChance: false }).resolve("きつねびえあこん");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toBe("きつねびえあこん VTuber");
    expect(r.passes).toBe(1);
    expect(r.queries).toEqual(["きつねびえあこん VTuber"]);
    expect(jevCalls.n).toBe(1);
    expect(r.best).toBeNull();
  });
});
