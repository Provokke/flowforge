import type { Executor } from "../types.ts";
import { llm } from "./llm.ts";
import { shell } from "./shell.ts";

/** with: { value: any }. Hands the value straight back, handy for constants and testing templates. */
const echo: Executor = { type: "echo", run: async ({ params }) => params.value };

/** with: { url, method?, headers?, body?, json?: boolean } */
const http: Executor = {
  type: "http",
  async run({ params, signal }) {
    const url = params.url;
    if (typeof url !== "string") throw new Error("http: `with.url` is required");
    const body = params.body === undefined ? undefined : typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    const res = await fetch(url, {
      method: String(params.method ?? (body ? "POST" : "GET")),
      headers: { ...(typeof params.body === "object" ? { "content-type": "application/json" } : {}), ...((params.headers as Record<string, string>) ?? {}) },
      body,
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (params.json) return JSON.parse(text);
    return text;
  },
};

export const builtins: Executor[] = [shell, echo, http, llm];
