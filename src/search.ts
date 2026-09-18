/**
 * Web 検索プロバイダ。読み→表記の解決で「根拠」を集める。
 * 役割分担: 検索エンジンが再現率 (かな→表記の解決と網羅)、Jev が精度 (根拠を見て確定)。
 * どのプロバイダも VTuber のデータは持たず、毎回問い合わせる。
 */

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
    private readonly fetchImpl: typeof fetch = fetch,
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
    private readonly fetchImpl: typeof fetch = fetch,
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
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

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

/** プロバイダを順に試し、失敗したら次へ。全滅で SearchExhausted。 */
export class SearchChain implements SearchProvider {
  readonly name: string;
  constructor(private readonly providers: SearchProvider[]) {
    this.name = providers.map((p) => p.name).join(">");
  }

  async search(query: string, n = 10): Promise<SearchHit[]> {
    const causes: SearchUnavailable[] = [];
    for (const p of this.providers) {
      try {
        return await p.search(query, n);
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
}

/** 環境変数にある鍵からチェーンを組む。優先: Google → Brave → Wikipedia。 */
export function providersFromEnv(env: SearchEnv, fetchImpl: typeof fetch = fetch): SearchProvider[] {
  const out: SearchProvider[] = [];
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) out.push(new GoogleCse(env.GOOGLE_CSE_KEY, env.GOOGLE_CSE_CX, fetchImpl));
  if (env.BRAVE_API_KEY) out.push(new Brave(env.BRAVE_API_KEY, fetchImpl));
  if (out.length === 0) out.push(new Wikipedia(fetchImpl));
  return out;
}
