/**
 * Jev (TypeSafe AI) の最小クライアント。SDK に依存せず fetch だけで呼ぶ (Worker でも動く)。
 * Cloudflare Workers AI の `typesafe/jev` バインディングを使う場合は JevClient を別実装して渡す。
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type Answer = ChoiceAnswer | NoulAnswer;

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, Answer>;
}

export interface JevClient {
  systemOne(state: JsonValue, questions: Record<string, Question>): Promise<SystemOneResponse>;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface TypeSafeJevOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** TypeSafe の HTTP API (POST /v1/systemone) を直接叩く実装。 */
export class TypeSafeJev implements JevClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TypeSafeJevOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "jev-latest";
    this.baseUrl = opts.baseUrl ?? "https://api.typesafe.ai";
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async systemOne(state: JsonValue, questions: Record<string, Question>): Promise<SystemOneResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions }),
    });
    if (!res.ok) {
      throw new JevError(`Jev API ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    return (await res.json()) as SystemOneResponse;
  }
}

export function noulOf(answer: Answer | undefined): number {
  if (!answer) return 0;
  switch (answer.type) {
    case "noul":
      return answer.noul;
    case "choice":
      return 0;
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}
