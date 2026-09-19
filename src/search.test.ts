import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_ORDER, Wikipedia, providersFromEnv } from "./search.js";

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
