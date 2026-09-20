import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_ORDER, Monid, Wikipedia, providersFromEnv } from "./search.js";

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
    expect(sleeps).toHaveLength(1);
    expect(calls).toBe(2);
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
