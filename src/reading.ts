/** 表記 → 読みの解決。Web 検索でかな候補を集め、Jev に「どの読みがその VTuber 名か」を選ばせる。 */

import { isStopword, parenPairs, tokenize } from "./evidence.js";
import { type Answer, type JevClient, type Question, noulOf } from "./jev.js";
import { isValidReading, normalizeName, normalizeReading, readingCompatible, segment } from "./kana.js";
import { CHECK_TOP, MAX_CANDIDATES, MIN_SCORE, NONE } from "./resolve.js";
import { SearchChain, type SearchHit, type SearchProvider } from "./search.js";

const KANA_TEXT_RE = /^[\u3041-\u3096\u30a1-\u30fa\u30fb\u30fc\s\u3000]+$/u;

export interface ReadingExtracted {
  evidence: string[];
  confirmed: number;
  surface: string;
}

export interface ReadingCandidate {
  reading: string;
  surface: string;
  probability: number;
  readingCorrect: number;
  isVtuber: number;
  score: number;
  evidence: string[];
}

export interface ReadingResult {
  name: string;
  candidates: ReadingCandidate[];
  best: ReadingCandidate | null;
  provider: string;
  /** 実際に答えたプロバイダ名。チェーンなら SearchChain.lastProvider */
  providerUsed?: string | undefined;
  /** 一次プロバイダ以外が答えたか。この resolve 中のどの検索でもフォールバックなら true */
  fallback: boolean;
  hits: number;
  model?: string | undefined;
}

export interface ReadingResolverOptions {
  jev: JevClient;
  search: SearchProvider;
  queries?: ((name: string) => string)[];
}

/** 表記の照合: NFKC・英字の大小無視・空白畳み。 */
const foldName = (s: string): string => s.normalize("NFKC").replace(/[\s\u3000]+/gu, " ").trim().toLowerCase();

const isKanaText = (s: string): boolean => KANA_TEXT_RE.test(s) && /[\u3041-\u3096\u30a1-\u30fa\u30fc]/u.test(s);

export function extractReadings(name: string, hits: SearchHit[]): Map<string, ReadingExtracted> {
  const out = new Map<string, ReadingExtracted>();
  const want = foldName(name);
  const add = (raw: string, url: string, confirmed: boolean): void => {
    if (!isKanaText(raw)) return;
    const reading = normalizeReading(raw);
    if (!isValidReading(reading) || [...reading].length < 2) return;
    if (isStopword(raw) || isStopword(reading)) return;
    if (!readingCompatible(name, reading)) return;
    const e = out.get(reading) ?? { evidence: [], confirmed: 0, surface: raw };
    if (url && !e.evidence.includes(url)) e.evidence.push(url);
    if (confirmed) {
      if (e.confirmed === 0) e.surface = raw;
      e.confirmed++;
    }
    out.set(reading, e);
  };

  for (const h of hits) {
    const text = `${h.title} ${h.snippet}`;
    const tokens = tokenize(text);
    for (const { outer, inner } of parenPairs(text, tokens)) {
      if (foldName(outer) === want && isKanaText(inner)) add(inner, h.url, true);
      if (foldName(inner) === want && isKanaText(outer)) add(outer, h.url, true);
    }
    for (const t of tokens) add(t.text, h.url, false);
  }
  return out;
}

/** 括弧書きで確認できたもの → 根拠の多いもの の順。 */
export function rankReadings(found: Map<string, ReadingExtracted>): string[] {
  return [...found.entries()]
    .sort(([, a], [, b]) => b.confirmed - a.confirmed || b.evidence.length - a.evidence.length)
    .map(([reading]) => reading);
}

function searchMeta(search: SearchProvider): Pick<ReadingResult, "providerUsed" | "fallback"> {
  if (search instanceof SearchChain) {
    return { providerUsed: search.lastProvider ?? undefined, fallback: search.lastWasFallback };
  }
  return { providerUsed: search.name, fallback: false };
}

export class ReadingResolver {
  private readonly jev: JevClient;
  private readonly search: SearchProvider;
  private readonly queries: ((name: string) => string)[];

  constructor(opts: ReadingResolverOptions) {
    this.jev = opts.jev;
    this.search = opts.search;
    this.queries = opts.queries ?? [(n) => `${n} VTuber 読み`];
  }

  async resolve(rawName: string): Promise<ReadingResult> {
    const name = normalizeName(rawName);
    const segs = segment(name);
    // 全かな表記は読みそのもの。detectDirection はこちらに振らないが、直接呼ばれても落とさない。
    if (segs.length > 0 && segs.every((s) => s.kind === "kana")) {
      const reading = normalizeReading(name);
      const cand: ReadingCandidate = {
        reading,
        surface: name,
        probability: 1,
        readingCorrect: 1,
        isVtuber: 1,
        score: 1,
        evidence: [],
      };
      return { name, candidates: [cand], best: cand, provider: this.search.name, providerUsed: this.search.name, fallback: false, hits: 0 };
    }

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    let fallback = false;
    let providerUsed: string | undefined;
    for (const q of this.queries) {
      for (const h of await this.search.search(q(name), 10)) {
        if (!seen.has(h.url)) {
          seen.add(h.url);
          hits.push(h);
        }
      }
      const meta = searchMeta(this.search);
      if (meta.providerUsed !== undefined) providerUsed = meta.providerUsed;
      fallback = fallback || meta.fallback;
    }
    const found = extractReadings(name, hits);
    if (found.size === 0) {
      return { name, candidates: [], best: null, provider: this.search.name, providerUsed, fallback, hits: hits.length };
    }

    const ranked = rankReadings(found).slice(0, MAX_CANDIDATES);
    const criteria: Record<string, string | null> = Object.fromEntries(ranked.map((r) => [r, null]));
    criteria[NONE] = "None of the candidates is the complete hiragana reading of this name";

    const questions: Record<string, Question> = {
      reading: {
        type: "choice",
        instructions:
          "`name` is the written name of a VTuber. `search_results` are web search hits for that name. Choose the " +
          "candidate that is the complete hiragana reading of the FULL name `name` (not a fragment, not the reading of " +
          "a different name or alias listed next to it), based on the evidence. Choose NONE if none fits.",
        criteria,
      },
    };
    const checked = ranked.slice(0, CHECK_TOP);
    checked.forEach((r, i) => {
      questions[`c${i}`] = {
        type: "noul",
        instructions:
          `Is 「${r}」 the complete and exact reading of 「${name}」 according to \`search_results\`? Answer no if it ` +
          "is only the reading of part of the name, or the reading of another name/alias written next to it.",
      };
    });
    questions["v"] = {
      type: "noul",
      instructions:
        `According to the evidence in \`search_results\`, is 「${name}」 a VTuber (virtual YouTuber / virtual liver: ` +
        "a streamer or video creator who appears as a 2D/3D avatar)? Answer no for real-life celebrities, voice " +
        "actors, ordinary people, places, and common nouns.",
    };

    const resp = await this.jev.systemOne(
      { name, search_results: hits.slice(0, 16).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })) },
      questions,
    );
    const choice = resp.answers["reading"];
    const probabilities = choice ? choiceProbabilities(choice) : {};
    const isVtuber = noulOf(resp.answers["v"]);

    const candidates: ReadingCandidate[] = [];
    for (const [reading, p] of Object.entries(probabilities)) {
      if (reading === NONE) continue;
      const i = checked.indexOf(reading);
      const readingCorrect = i >= 0 ? noulOf(resp.answers[`c${i}`]) : 0;
      const extracted = found.get(reading);
      candidates.push({
        reading,
        surface: extracted?.surface ?? reading,
        probability: p,
        readingCorrect,
        isVtuber,
        score: p * readingCorrect * isVtuber,
        evidence: extracted?.evidence ?? [],
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] && candidates[0].score >= MIN_SCORE ? candidates[0] : null;
    return { name, candidates, best, provider: this.search.name, providerUsed, fallback, hits: hits.length, model: resp.model };
  }
}

function choiceProbabilities(answer: Answer): Record<string, number> {
  switch (answer.type) {
    case "choice":
      return answer.probabilities;
    case "noul":
      return {};
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}
