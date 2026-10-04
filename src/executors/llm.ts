import type { Executor } from "../types.ts";

/** Rough token count, about 4 characters each. Good enough without a tokenizer. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Keeps the newest chunks that fit the budget. If the newest alone is too big, trim it from the front. */
export function fitContext(chunks: string[], budgetTokens: number): { text: string; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const cost = estimateTokens(chunks[i]);
    if (used + cost > budgetTokens) {
      if (kept.length === 0) {
        kept.unshift(chunks[i].slice(-budgetTokens * 4));
        used = budgetTokens;
      }
      break;
    }
    kept.unshift(chunks[i]);
    used += cost;
  }
  return { text: kept.join("\n\n"), dropped: chunks.length - kept.length };
}

/**
 * with: {
 *   prompt: string,
 *   system?: string,
 *   context?: string | string[]   // chunks, oldest first, trimmed to fit maxContextTokens
 *   provider?: "openai" | "mock"  // "openai" is anything that speaks /chat/completions (Ollama, llama.cpp, LM Studio)
 *   baseUrl?: string              // default http://localhost:11434/v1
 *   model?: string, apiKeyEnv?: string, maxContextTokens?: number, temperature?: number
 * }
 */
export const llm: Executor = {
  type: "llm",
  async run({ params, signal, log }) {
    const prompt = params.prompt;
    if (typeof prompt !== "string" || !prompt) throw new Error("llm: `with.prompt` is required");
    const budget = Number(params.maxContextTokens ?? 6000);
    const chunks = params.context == null ? [] : Array.isArray(params.context) ? params.context.map(String) : [String(params.context)];
    const { text: context, dropped } = fitContext(chunks, budget);
    if (dropped) log(`context trimmed to ${budget} tokens (dropped ${dropped} oldest chunk${dropped > 1 ? "s" : ""})`);
    const user = context ? `${context}\n\n${prompt}` : prompt;

    if ((params.provider ?? "openai") === "mock") {
      return `[mock:${params.model ?? "mock"}] ${user.slice(0, 200)}`;
    }

    const baseUrl = String(params.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
    const key = params.apiKeyEnv ? process.env[String(params.apiKeyEnv)] : undefined;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: params.model ?? "llama3.1",
        temperature: params.temperature ?? 0.2,
        messages: [
          ...(params.system ? [{ role: "system", content: String(params.system) }] : []),
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`llm: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("llm: response had no choices[0].message.content");
    return content;
  },
};
