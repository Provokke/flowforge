import { fallbackIds } from "./graph.ts";
import { resolve } from "./template.ts";
import type { TemplateScope } from "./template.ts";
import type {
  Executor, HookMap, HookName, PluginApi, RunResult, TaskResult, TaskSpec, Workflow,
} from "./types.ts";

type HookLists = { [K in HookName]: HookMap[K][] };

/** Holds the executors and hooks. Plugins get one of these. */
export class Runtime implements PluginApi {
  executors = new Map<string, Executor>();
  hooks: HookLists = { runStart: [], taskStart: [], taskEnd: [], runEnd: [] };

  registerExecutor(executor: Executor): void {
    if (this.executors.has(executor.type)) throw new Error(`executor "${executor.type}" is already registered`);
    this.executors.set(executor.type, executor);
  }

  on<K extends HookName>(hook: K, fn: HookMap[K]): void {
    this.hooks[hook].push(fn);
  }

  async emit<K extends HookName>(hook: K, ...args: Parameters<HookMap[K]>): Promise<void> {
    for (const fn of this.hooks[hook] as ((...a: unknown[]) => unknown)[]) {
      try {
        await fn(...args);
      } catch (e) {
        // a dodgy hook mustn't take the run down
        console.error(`[flowforge] hook "${hook}" threw: ${(e as Error).message}`);
      }
    }
  }
}

export interface RunOptions {
  concurrency?: number;
  env?: Record<string, string | undefined>;
  vars?: Record<string, string>;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

export async function runWorkflow(wf: Workflow, rt: Runtime, opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const runSignal = opts.signal ?? new AbortController().signal;
  const concurrency = Math.max(1, opts.concurrency ?? wf.concurrency ?? 4);
  const byId = new Map(wf.tasks.map((t) => [t.id, t]));
  const results: Record<string, TaskResult> = {};
  const tolerated = new Set<string>();
  const vars = { ...(wf.vars ?? {}), ...(opts.vars ?? {}) };

  const scope = (): TemplateScope => ({
    tasks: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { output: r.output, status: r.status }])),
    env: opts.env ?? process.env,
    vars,
  });

  async function attemptOnce(task: TaskSpec, params: Record<string, unknown>, attempt: number): Promise<unknown> {
    const exec = rt.executors.get(task.type);
    if (!exec) throw new Error(`no executor for type "${task.type}"`);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(runSignal.reason);
    runSignal.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = exec.run({ task, params, signal: ctl.signal, attempt, log: (m) => log(`${task.id}: ${m}`) });
      if (!task.timeoutMs) return await work;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          rej(new Error(`timed out after ${task.timeoutMs}ms`)); // reject before aborting or the "aborted" error wins
          ctl.abort();
        }, task.timeoutMs);
      });
      work.catch(() => {}); // avoids an unhandled rejection once the timeout wins
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", onAbort);
    }
  }

  async function runWithRetries(task: TaskSpec): Promise<TaskResult> {
    const t0 = Date.now();
    let params: Record<string, unknown>;
    try {
      params = resolve(task.with ?? {}, scope());
    } catch (e) {
      return { id: task.id, status: "failed", output: null, attempts: 0, durationMs: Date.now() - t0, error: (e as Error).message };
    }
    const max = (task.retries ?? 0) + 1;
    let lastErr = "";
    for (let attempt = 1; attempt <= max; attempt++) {
      if (runSignal.aborted) { lastErr = "aborted"; break; }
      await rt.emit("taskStart", task, attempt);
      try {
        const output = await attemptOnce(task, params, attempt);
        return { id: task.id, status: "success", output, attempts: attempt, durationMs: Date.now() - t0 };
      } catch (e) {
        lastErr = (e as Error).message ?? String(e);
        if (attempt < max) {
          const wait = (task.backoffMs ?? 200) * 2 ** (attempt - 1);
          log(`${task.id}: attempt ${attempt}/${max} failed (${lastErr}); retrying in ${wait}ms`);
          await sleep(wait, runSignal);
        }
      }
    }
    return { id: task.id, status: "failed", output: null, attempts: max, durationMs: Date.now() - t0, error: lastErr };
  }

  async function runTask(task: TaskSpec): Promise<TaskResult> {
    let res = await runWithRetries(task);
    let cur = task;
    while (res.status === "failed" && cur.fallback && !runSignal.aborted) {
      const fbTask = byId.get(cur.fallback)!;
      log(`${task.id}: failed (${res.error}); running fallback "${fbTask.id}"`);
      const fbRes = await runWithRetries(fbTask);
      results[fbTask.id] = fbRes;
      await rt.emit("taskEnd", fbTask, fbRes);
      if (fbRes.status === "success") {
        res = { ...fbRes, id: task.id, usedFallback: fbTask.id, attempts: res.attempts + fbRes.attempts, durationMs: res.durationMs + fbRes.durationMs };
        break;
      }
      res = { ...res, error: `${res.error}; fallback "${fbTask.id}" failed: ${fbRes.error}` };
      cur = fbTask;
    }
    return res;
  }

  const fb = fallbackIds(wf);
  const pending = new Set(wf.tasks.filter((t) => !fb.has(t.id)).map((t) => t.id));
  const running = new Map<string, Promise<void>>();

  await rt.emit("runStart", wf);

  const finish = async (task: TaskSpec, res: TaskResult) => {
    results[task.id] = res;
    if (res.status === "failed" && task.allowFailure) tolerated.add(task.id);
    await rt.emit("taskEnd", task, res);
  };

  while (pending.size || running.size) {
    // sort out skips first (including knock-on ones), then schedule
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...pending]) {
        const task = byId.get(id)!;
        const bad = (task.needs ?? []).find((n) => {
          const r = results[n];
          return r && (r.status === "skipped" || (r.status === "failed" && !tolerated.has(n)));
        });
        if (bad || runSignal.aborted) {
          pending.delete(id);
          const why = runSignal.aborted ? "run aborted" : `dependency "${bad}" did not succeed`;
          await finish(task, { id, status: "skipped", output: null, attempts: 0, durationMs: 0, skippedBecause: why });
          changed = true;
        }
      }
    }

    for (const id of [...pending]) {
      if (running.size >= concurrency) break;
      const task = byId.get(id)!;
      if (!(task.needs ?? []).every((n) => results[n])) continue;
      pending.delete(id);
      const p = runTask(task)
        .catch((e): TaskResult => ({ id, status: "failed", output: null, attempts: 0, durationMs: 0, error: `internal error: ${(e as Error).message}` }))
        .then((res) => finish(task, res))
        .finally(() => running.delete(id));
      running.set(id, p);
    }

    if (running.size) await Promise.race(running.values());
    else if (pending.size) break; // shouldn't happen after validation, but beats hanging
  }

  const ok = wf.tasks
    .filter((t) => !fb.has(t.id))
    .every((t) => results[t.id]?.status === "success" || tolerated.has(t.id));
  const out: RunResult = { workflow: wf.name, ok, durationMs: Date.now() - started, tasks: results };
  await rt.emit("runEnd", out);
  return out;
}
