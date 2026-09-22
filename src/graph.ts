import { ManifestError } from "./types.ts";
import type { TaskSpec, Workflow } from "./types.ts";

/** Ids of tasks only used as a fallback. They sit outside the main DAG. */
export function fallbackIds(wf: Workflow): Set<string> {
  return new Set(wf.tasks.map((t) => t.fallback).filter((f): f is string => !!f));
}

export function validate(raw: unknown, knownTypes?: Set<string>): Workflow {
  const issues: string[] = [];
  const wf = raw as Workflow;
  if (!wf || typeof wf !== "object") throw new ManifestError(["manifest must be an object"]);
  if (typeof wf.name !== "string" || !wf.name) issues.push("`name` is required");
  if (!Array.isArray(wf.tasks) || wf.tasks.length === 0) {
    issues.push("`tasks` must be a non-empty array");
    throw new ManifestError(issues);
  }
  if (wf.concurrency !== undefined && !(Number.isInteger(wf.concurrency) && wf.concurrency > 0)) {
    issues.push("`concurrency` must be a positive integer");
  }

  const ids = new Set<string>();
  for (const t of wf.tasks) {
    if (!t || typeof t.id !== "string" || !/^[A-Za-z_][\w-]*$/.test(t.id)) {
      issues.push(`task id ${JSON.stringify(t?.id)} is invalid (letters, digits, _ and - only)`);
      continue;
    }
    if (ids.has(t.id)) issues.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
    if (typeof t.type !== "string" || !t.type) issues.push(`task "${t.id}": \`type\` is required`);
    else if (knownTypes && !knownTypes.has(t.type)) {
      issues.push(`task "${t.id}": unknown type "${t.type}" (known: ${[...knownTypes].sort().join(", ")})`);
    }
    for (const k of ["retries", "backoffMs", "timeoutMs"] as const) {
      const v = t[k];
      if (v !== undefined && !(typeof v === "number" && v >= 0)) issues.push(`task "${t.id}": \`${k}\` must be a number >= 0`);
    }
  }

  const fb = fallbackIds(wf);
  for (const t of wf.tasks) {
    for (const n of t.needs ?? []) {
      if (!ids.has(n)) issues.push(`task "${t.id}" needs unknown task "${n}"`);
      else if (n === t.id) issues.push(`task "${t.id}" needs itself`);
      else if (fb.has(n)) issues.push(`task "${t.id}" needs "${n}", which is a fallback-only task`);
    }
    if (t.fallback) {
      if (!ids.has(t.fallback)) issues.push(`task "${t.id}" has unknown fallback "${t.fallback}"`);
      else if (t.fallback === t.id) issues.push(`task "${t.id}" is its own fallback`);
    }
  }
  // a chain of fallbacks mustn't loop
  for (const t of wf.tasks) {
    const seen = new Set<string>([t.id]);
    let cur = t.fallback;
    while (cur && ids.has(cur)) {
      if (seen.has(cur)) {
        issues.push(`fallback chain starting at "${t.id}" loops`);
        break;
      }
      seen.add(cur);
      cur = wf.tasks.find((x) => x.id === cur)?.fallback;
    }
  }

  if (issues.length === 0) {
    const cycle = findCycle(wf);
    if (cycle) issues.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  if (issues.length) throw new ManifestError(issues);
  return wf;
}

/** Returns a dependency cycle's ids (first id repeated at the end), or null. */
export function findCycle(wf: Workflow): string[] | null {
  const byId = new Map(wf.tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const n of byId.get(id)?.needs ?? []) {
      if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (!state.has(n)) {
        const c = visit(n);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of wf.tasks) if (!state.has(t.id)) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Groups main tasks into stages that can each run side by side. */
export function levels(wf: Workflow): TaskSpec[][] {
  const fb = fallbackIds(wf);
  const main = wf.tasks.filter((t) => !fb.has(t.id));
  const depth = new Map<string, number>();
  const byId = new Map(main.map((t) => [t.id, t]));
  const d = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const t = byId.get(id)!;
    const v = (t.needs ?? []).reduce((m, n) => Math.max(m, d(n) + 1), 0);
    depth.set(id, v);
    return v;
  };
  const out: TaskSpec[][] = [];
  for (const t of main) (out[d(t.id)] ??= []).push(t);
  return out;
}

export function toText(wf: Workflow): string {
  const lines = [`${wf.name}`];
  levels(wf).forEach((lvl, i) => {
    lines.push(`  stage ${i + 1}`);
    for (const t of lvl) {
      const needs = t.needs?.length ? ` <- ${t.needs.join(", ")}` : "";
      const fb = t.fallback ? ` (fallback: ${t.fallback})` : "";
      lines.push(`    ${t.id} [${t.type}]${needs}${fb}`);
    }
  });
  return lines.join("\n");
}

export function toMermaid(wf: Workflow): string {
  const lines = ["graph TD"];
  for (const t of wf.tasks) lines.push(`  ${t.id}["${t.id} (${t.type})"]`);
  for (const t of wf.tasks) {
    for (const n of t.needs ?? []) lines.push(`  ${n} --> ${t.id}`);
    if (t.fallback) lines.push(`  ${t.id} -. on failure .-> ${t.fallback}`);
  }
  return lines.join("\n");
}
