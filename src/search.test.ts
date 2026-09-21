import { describe, expect, it } from "vitest";

import { Resolver } from "./resolve.js";
import { DEFAULT_SEARCH_ORDER, Monid, SearchChain, SearchUnavailable, Wikipedia, providersFromEnv, type SearchHit, type SearchProvider } from "./search.js";

describe("providersFromEnv", () => {
  it("uses Monid then Brave then Google when all keys exist and order is unset", () => {
    const ps = providersFromEnv({
      MONID_API_KEY: "m",
      BRAVE_API_KEY: "b",
      GOOGLE_CSE_KEY: "g",
      GOOGLE_CSE_CX: "cx",
    });
    expect(DEFAULT_SEARCH_ORDER).toEqual(["monid", "brave", "google"]);
    expect(ps.map((p) => p.name)).toEqual(["monid", "brave", "google"]);
  });

  it("skips providers without keys and trims spaces in SEARCH_ORDER", () => {
    const ps = providersFromEnv({
      BRAVE_API_KEY: "b",
      MONID_API_KEY: "m",
      SEARCH_ORDER: "brave, monid, google",
    });
    expect(ps.map((p) => p.name)).toEqual(["brave", "monid"]);
  });

  it("falls back to Wikipedia when nothing is configured", () => {
    const ps = providersFromEnv({});
    expect(ps).toHaveLength(1);
    expect(ps[0]).toBeInstanceOf(Wikipedia);
  });
});

const completedRun = {
  runId: "r1",
  status: "COMPLETED",
  output: { results: [{ title: "t", url: "https://x", snippet: "s" }] },
};

describe("Monid 429 retry", () => {
  const base = { apiKey: "k", provider: "tinyfish", endpoint: "/search" };

  it("retries once on 429 then returns hits", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify(completedRun), { status: 200, headers: { "content-type": "application/json" } });
    };
    const hits = await new Monid({
      ...base,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    }).search("query");
    expect(hits).toEqual([{ title: "t", url: "https://x", snippet: "s" }]);
    expect(sleeps).toEqual([2000]);
    expect(calls).toBe(2);
  });

  it("retries twice on 429 with default backoff then returns hits", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls <= 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify(completedRun), { status: 200, headers: { "content-type": "application/json" } });
    };
    const hits = await new Monid({
      ...base,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    }).search("query");
    expect(hits).toEqual([{ title: "t", url: "https://x", snippet: "s" }]);
    expect(sleeps).toEqual([2000, 4000]);
    expect(calls).toBe(3);
  });

  it("throws SearchUnavailable after one retry when both responses are 429", async () => {
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async () => new Response("rate limited", { status: 429 });
    await expect(
      new Monid({
        ...base,
        retryOn429: 1,
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); },
      }).search("query"),
    ).rejects.toMatchObject({ name: "SearchUnavailable", status: 429 });
    expect(sleeps).toHaveLength(1);
  });

  it("does not retry a non-429 failure", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("error", { status: 500 });
    };
    await expect(
      new Monid({
        ...base,
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); },
      }).search("query"),
    ).rejects.toMatchObject({ name: "SearchUnavailable", status: 500 });
    expect(sleeps).toHaveLength(0);
    expect(calls).toBe(1);
  });
});

class FakeProvider implements SearchProvider {
  constructor(
    readonly name: string,
    private readonly impl: () => Promise<SearchHit[]>,
  ) {}
  search(): Promise<SearchHit[]> {
    return this.impl();
  }
}

const sampleHits: SearchHit[] = [{ title: "t", url: "https://x", snippet: "s" }];

describe("SearchChain lastProvider", () => {
  it("starts with lastProvider null and lastWasFallback false", () => {
    const chain = new SearchChain([new FakeProvider("a", async () => sampleHits)]);
    expect(chain.lastProvider).toBeNull();
    expect(chain.lastWasFallback).toBe(false);
  });

  it("records the second provider and lastWasFallback when the first throws SearchUnavailable", async () => {
    const first = new FakeProvider("monid", async () => {
      throw new SearchUnavailable("monid", "HTTP 429", 429);
    });
    const second = new FakeProvider("brave", async () => sampleHits);
    const chain = new SearchChain([first, second]);
    await expect(chain.search("よやみいずも")).resolves.toEqual(sampleHits);
    expect(chain.lastProvider).toBe(second.name);
    expect(chain.lastWasFallback).toBe(true);
  });

  it("records the first provider and lastWasFallback false when the first succeeds", async () => {
    const first = new FakeProvider("monid", async () => sampleHits);
    const second = new FakeProvider("brave", async () => [{ title: "other", url: "https://y", snippet: "" }]);
    const chain = new SearchChain([first, second]);
    await expect(chain.search("よやみいずも")).resolves.toEqual(sampleHits);
    expect(chain.lastProvider).toBe(first.name);
    expect(chain.lastWasFallback).toBe(false);
  });

  it("treats an empty array from the first provider as success and does not fall over", async () => {
    let secondCalls = 0;
    const first = new FakeProvider("monid", async () => []);
    const second = new FakeProvider("brave", async () => {
      secondCalls += 1;
      return sampleHits;
    });
    const chain = new SearchChain([first, second]);
    await expect(chain.search("query")).resolves.toEqual([]);
    expect(secondCalls).toBe(0);
    expect(chain.lastProvider).toBe(first.name);
    expect(chain.lastWasFallback).toBe(false);
  });
});

describe("Resolver search metadata", () => {
  const unusedJev = { systemOne: async () => { throw new Error("jev should not run on empty hits"); } };

  it("sets providerUsed and fallback from SearchChain after failover", async () => {
    const chain = new SearchChain([
      new FakeProvider("monid", async () => { throw new SearchUnavailable("monid", "HTTP 429", 429); }),
      new FakeProvider("brave", async () => []),
    ]);
    const r = await new Resolver({ jev: unusedJev, search: chain }).resolve("よやみいずも");
    expect(r.provider).toBe("monid>brave");
    expect(r.providerUsed).toBe("brave");
    expect(r.fallback).toBe(true);
    expect(r.best).toBeNull();
  });

  it("sets fallback false when the primary provider answers", async () => {
    const chain = new SearchChain([
      new FakeProvider("monid", async () => []),
      new FakeProvider("brave", async () => sampleHits),
    ]);
    const r = await new Resolver({ jev: unusedJev, search: chain }).resolve("よやみいずも");
    expect(r.providerUsed).toBe("monid");
    expect(r.fallback).toBe(false);
  });
});
