/**
 * Web 検索プロバイダ。読み→表記の解決で「根拠」を集める。
 * 役割分担: 検索エンジンが再現率 (かな→表記の解決と網羅)、Jev が精度 (根拠を見て確定)。
 * どのプロバイダも VTuber のデータは持たず、毎回問い合わせる。
 */

import { defaultFetch } from "./http.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, n?: number): Promise<SearchHit[]>;
}

/** 無料枠の枯渇・レート制限・障害。チェーンは次のプロバイダへ進む。 */
export class SearchUnavailable extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SearchUnavailable";
  }
}

/** すべてのプロバイダが使えなかった。呼び出し側は「本日の検索は終了しました」を出す。 */
export class SearchExhausted extends Error {
  constructor(readonly causes: SearchUnavailable[]) {
    super(`all search providers unavailable: ${causes.map((c) => c.message).join("; ")}`);
    this.name = "SearchExhausted";
  }
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "");

async function getJson(url: string, headers: Record<string, string>, provider: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { "user-agent": "jev-vtuber-ime/0.1", ...headers } });
  if (!res.ok) throw new SearchUnavailable(provider, `HTTP ${res.status}`, res.status);
  return res.json();
}

/** Google Programmable Search JSON API。無料 100 回/日。「検索するサイト」に VTuber のいるドメインを列挙して使う。 */
export class GoogleCse implements SearchProvider {
  readonly name = "google";
  constructor(
    private readonly apiKey: string,
    private readonly cx: string,
    private readonly fetchImpl: typeof fetch = defaultFetch,
  ) {}

  async search(query: string, n = 10): Promise<SearchHit[]> {
    const q = new URLSearchParams({ key: this.apiKey, cx: this.cx, q: query, num: String(Math.min(n, 10)), hl: "ja", lr: "lang_ja" });
    const d = (await getJson(`https://www.googleapis.com/customsearch/v1?${q}`, {}, this.name, this.fetchImpl)) as {
      items?: { title?: string; link?: string; snippet?: string }[];
    };
    return (d.items ?? []).map((i) => ({ title: i.title ?? "", url: i.link ?? "", snippet: i.snippet ?? "" }));
  }
}

/** Brave Search API。無料 2,000 回/月。 */
export class Brave implements SearchProvider {
  readonly name = "brave";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = defaultFetch,
  ) {}

  async search(query: string, n = 10): Promise<SearchHit[]> {
    const q = new URLSearchParams({ q: query, count: String(Math.min(n, 20)), country: "JP", search_lang: "ja" });
    const d = (await getJson(
      `https://api.search.brave.com/res/v1/web/search?${q}`,
      { accept: "application/json", "x-subscription-token": this.apiKey },
      this.name,
      this.fetchImpl,
    )) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (d.web?.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: stripTags(r.description ?? "") }));
  }
}

/** 日本語版 Wikipedia 検索。鍵不要だが大手しか載っていないので開発用フォールバック。 */
export class Wikipedia implements SearchProvider {
  readonly name = "wikipedia";
  constructor(private readonly fetchImpl: typeof fetch = defaultFetch) {}

  async search(query: string, n = 10): Promise<SearchHit[]> {
    const q = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(n), format: "json", srprop: "snippet" });
    const d = (await getJson(`https://ja.wikipedia.org/w/api.php?${q}`, {}, this.name, this.fetchImpl)) as {
      query?: { search?: { title: string; snippet?: string }[] };
    };
    return (d.query?.search ?? []).map((r) => ({
      title: r.title,
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
      snippet: stripTags(r.snippet ?? ""),
    }));
  }
}

export interface MonidOptions {
  apiKey: string;
  /** Monid 上の検索ツールの provider 名 (例: "tinyfish") */
  provider: string;
  /** そのツールの endpoint (例: "/search") */
  endpoint: string;
  /** endpoint に渡す入力。`{query}` と `{n}` を置換する。既定: TinyFish 用 {"query":"{query}","location":"JP","language":"ja"} */
  inputTemplate?: Record<string, unknown> | undefined;
  /** 入力を body で渡すか queryParams で渡すか (`monid inspect` の Input 欄に従う)。既定: queryParams */
  inputKind?: "body" | "queryParams" | undefined;
  baseUrl?: string | undefined;
  /** ポーリング上限 (ms)。Monid の run は非同期で 1〜120 秒かかる */
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** HTTP 429 の再試行回数。既定 2。TinyFish 上流の RATE_LIMIT_EXCEEDED はおよそ 10〜15 秒続く */
  retryOn429?: number | undefined;
  /** 429 再試行の待ち時間 (ms)。試行回数を掛けて backoff。既定 2000 (2 秒 + 4 秒) */
  retryDelayMs?: number | undefined;
  /** 待ち時間の実装。テスト用。既定は setTimeout */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const MONID_DEFAULTS = {
  provider: "tinyfish",
  endpoint: "/search",
  inputKind: "queryParams" as const,
  inputTemplate: { query: "{query}", location: "JP", language: "ja" },
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Monid (https://monid.ai) 経由の検索。Monid は多数のツールを 1 つの残高で呼ぶ仲介で、
 * 既定の TinyFish /search は $0/call。run を投げて runId をポーリングする非同期 API (typ. 3 秒)。
 * ツールごとに入出力が違うので provider / endpoint / 入力は設定で与え、出力は
 * 「url を持つオブジェクトの配列」を探して SearchHit に寄せる。
 * HTTP 429 は TinyFish 上流の RATE_LIMIT_EXCEEDED で、およそ 10〜15 秒の窓で続く。
 * 既定では 2 回再試行 (2 秒 + 4 秒) してから SearchUnavailable にする。
 */
export class Monid implements SearchProvider {
  readonly name = "monid";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryOn429: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MonidOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.monid.ai";
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retryOn429 = opts.retryOn429 ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let retries = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", "x-monid-client": "jev-vtuber-ime" },
        body: body === undefined ? null : JSON.stringify(body),
      });
      if (res.status === 429 && retries < this.retryOn429) {
        retries += 1;
        await this.sleep(this.retryDelayMs * retries);
        continue;
      }
      if (!res.ok) throw new SearchUnavailable(this.name, `HTTP ${res.status}`, res.status);
      return res.status === 204 ? null : res.json();
    }
  }

  async search(query: string, n = 10): Promise<SearchHit[]> {
    const template = this.opts.inputTemplate ?? MONID_DEFAULTS.inputTemplate;
    const filled = JSON.parse(JSON.stringify(template).replace(/"\{n\}"/g, String(n)).replace(/\{query\}/g, query.replace(/"/g, '\\"')));
    const input = (this.opts.inputKind ?? MONID_DEFAULTS.inputKind) === "body" ? { body: filled } : { queryParams: filled };
    const started = (await this.request("POST", "/v1/run", { provider: this.opts.provider, endpoint: this.opts.endpoint, input })) as {
      runId?: string;
      status?: string;
    };
    if (!started.runId) throw new SearchUnavailable(this.name, "no runId in response");

    const deadline = Date.now() + this.timeoutMs;
    let run: Record<string, unknown> = started;
    while (!isTerminal(run["status"])) {
      if (Date.now() > deadline) throw new SearchUnavailable(this.name, "run timed out");
      await this.sleep(1500);
      run = (await this.request("GET", `/v1/runs/${encodeURIComponent(started.runId)}`)) as Record<string, unknown>;
    }
    if (run["status"] !== "COMPLETED") {
      // BLOCKED = ワークスペースの予算/回数上限。FAILED も含めて「このプロバイダは今使えない」
      throw new SearchUnavailable(this.name, `run ${String(run["status"])}`);
    }
    return extractHits(run).slice(0, n);
  }
}

const isTerminal = (s: unknown): boolean => s === "COMPLETED" || s === "FAILED" || s === "BLOCKED" || s === "STOPPED" || s === "TIMED_OUT";

/** 任意の JSON から「url を持つオブジェクトの配列」を最初に見つけて SearchHit に寄せる。 */
export function extractHits(data: unknown, depth = 0): SearchHit[] {
  if (depth > 6 || data === null || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    const objs = data.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x));
    const withUrl = objs.filter((o) => typeof (o["url"] ?? o["link"]) === "string");
    if (withUrl.length > 0 && withUrl.length >= objs.length / 2) {
      return withUrl.map((o) => ({
        title: String(o["title"] ?? o["name"] ?? ""),
        url: String(o["url"] ?? o["link"]),
        snippet: stripTags(String(o["snippet"] ?? o["description"] ?? o["content"] ?? o["text"] ?? "")).slice(0, 500),
      }));
    }
    for (const item of data) {
      const hits = extractHits(item, depth + 1);
      if (hits.length) return hits;
    }
    return [];
  }
  for (const v of Object.values(data as Record<string, unknown>)) {
    const hits = extractHits(v, depth + 1);
    if (hits.length) return hits;
  }
  return [];
}

/**
 * プロバイダを順に試し、SearchUnavailable なら次へ。全滅で SearchExhausted。
 * 空配列も成功としてチェーンを止め、次のプロバイダへは進まない。
 * 直近の成功は lastProvider / lastWasFallback で参照できる。
 */
export class SearchChain implements SearchProvider {
  readonly name: string;
  private _lastProvider: string | null = null;
  private _lastWasFallback = false;

  constructor(private readonly providers: SearchProvider[]) {
    this.name = providers.map((p) => p.name).join(">");
  }

  /** 直近の search で実際に答えたプロバイダ名。呼び出し前、および全滅時は null */
  get lastProvider(): string | null {
    return this._lastProvider;
  }

  /** 直近の成功がチェーン先頭以外のプロバイダによるものか。呼び出し前は false */
  get lastWasFallback(): boolean {
    return this._lastWasFallback;
  }

  async search(query: string, n = 10): Promise<SearchHit[]> {
    this._lastProvider = null;
    this._lastWasFallback = false;
    const causes: SearchUnavailable[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i]!;
      try {
        const hits = await p.search(query, n);
        this._lastProvider = p.name;
        this._lastWasFallback = i > 0;
        return hits;
      } catch (e) {
        causes.push(e instanceof SearchUnavailable ? e : new SearchUnavailable(p.name, e instanceof Error ? e.message : String(e)));
      }
    }
    throw new SearchExhausted(causes);
  }
}

export interface SearchEnv {
  GOOGLE_CSE_KEY?: string | undefined;
  GOOGLE_CSE_CX?: string | undefined;
  BRAVE_API_KEY?: string | undefined;
  MONID_API_KEY?: string | undefined;
  /** 既定 "tinyfish" */
  MONID_SEARCH_PROVIDER?: string | undefined;
  /** 既定 "/search" */
  MONID_SEARCH_ENDPOINT?: string | undefined;
  /** JSON。既定 {"query":"{query}","location":"JP","language":"ja"} */
  MONID_SEARCH_INPUT?: string | undefined;
  /** "body" | "queryParams"。既定 queryParams */
  MONID_SEARCH_INPUT_KIND?: string | undefined;
  /** カンマ区切りで順序を指定。未設定時は DEFAULT_SEARCH_ORDER */
  SEARCH_ORDER?: string | undefined;
}

/** 鍵があるプロバイダだけが使われる。Google の鍵はこのデモでは入れない。 */
export const DEFAULT_SEARCH_ORDER = ["monid", "brave", "google"] as const;

/** 環境変数にある鍵からチェーンを組む。既定の優先: Monid → Brave → Google → (何も無ければ Wikipedia)。 */
export function providersFromEnv(env: SearchEnv, fetchImpl: typeof fetch = defaultFetch): SearchProvider[] {
  const available = new Map<string, SearchProvider>();
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) available.set("google", new GoogleCse(env.GOOGLE_CSE_KEY, env.GOOGLE_CSE_CX, fetchImpl));
  if (env.BRAVE_API_KEY) available.set("brave", new Brave(env.BRAVE_API_KEY, fetchImpl));
  if (env.MONID_API_KEY) {
    available.set(
      "monid",
      new Monid({
        apiKey: env.MONID_API_KEY,
        provider: env.MONID_SEARCH_PROVIDER || MONID_DEFAULTS.provider,
        endpoint: env.MONID_SEARCH_ENDPOINT || MONID_DEFAULTS.endpoint,
        inputTemplate: env.MONID_SEARCH_INPUT ? (JSON.parse(env.MONID_SEARCH_INPUT) as Record<string, unknown>) : undefined,
        inputKind: env.MONID_SEARCH_INPUT_KIND === "body" ? "body" : env.MONID_SEARCH_INPUT_KIND === "queryParams" ? "queryParams" : undefined,
        fetchImpl,
      }),
    );
  }
  const order = (env.SEARCH_ORDER ?? DEFAULT_SEARCH_ORDER.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const out = order.map((k) => available.get(k)).filter((p): p is SearchProvider => p !== undefined);
  if (out.length === 0) out.push(new Wikipedia(fetchImpl));
  return out;
}
