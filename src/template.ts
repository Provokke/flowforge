export interface TemplateScope {
  tasks: Record<string, { output: unknown; status: string }>;
  env: Record<string, string | undefined>;
  vars: Record<string, string>;
}

const EXPR = /\$\{\s*([^}]+?)\s*\}/g;
const WHOLE = /^\$\{\s*([^}]+?)\s*\}$/;

function lookup(path: string, scope: TemplateScope): unknown {
  const parts = path.split(".");
  const root = parts.shift();
  let cur: unknown;
  if (root === "tasks") {
    const id = parts.shift();
    if (!id || !(id in scope.tasks)) throw new Error(`\${${path}}: task "${id}" has no result`);
    cur = scope.tasks[id];
  } else if (root === "env") {
    cur = scope.env;
  } else if (root === "vars") {
    cur = scope.vars;
  } else {
    throw new Error(`\${${path}}: unknown root "${root}" (use tasks., env. or vars.)`);
  }
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

/** Fills in `${...}` expressions in a JSON-like value. A string that is one expression keeps its original type. */
export function resolve<T>(value: T, scope: TemplateScope): T {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1], scope) as T;
    return value.replace(EXPR, (_, p: string) => str(lookup(p, scope))) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)])) as T;
  }
  return value;
}
