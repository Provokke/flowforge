import assert from "node:assert/strict";
import { test } from "node:test";
import { Runtime, runWorkflow } from "../src/engine.ts";
import { builtins } from "../src/executors/index.ts";
import { fitContext } from "../src/executors/llm.ts";
import { findCycle, levels, validate } from "../src/graph.ts";
import { resolve } from "../src/template.ts";
import { ManifestError } from "../src/types.ts";
import type { TaskSpec, Workflow } from "../src/types.ts";

function rt() {
  const r = new Runtime();
  for (const e of builtins) r.registerExecutor(e);
  const flaky = new Map<string, number>();
  r.registerExecutor({ type: "fail", run: async () => { throw new Error("boom"); } });
  r.registerExecutor({
    type: "flaky",
    run: async ({ task, params }) => {
      const n = (flaky.get(task.id) ?? 0) + 1;
      flaky.set(task.id, n);
      if (n <= Number(params.failures ?? 1)) throw new Error(`fail #${n}`);
      return `ok after ${n}`;
    },
  });
  r.registerExecutor({
    type: "slow",
    run: ({ params, signal }) => new Promise((res, rej) => {
      const t = setTimeout(() => res("done"), Number(params.ms ?? 50));
      signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
    }),
  });
  return r;
}

const wf = (tasks: TaskSpec[], extra: Partial<Workflow> = {}): Workflow => ({ name: "t", tasks, ...extra });

test("validate rejects cycles, unknown deps and duplicates", () => {
  assert.throws(() => validate(wf([{ id: "a", type: "echo", needs: ["b"] }, { id: "b", type: "echo", needs: ["a"] }])), /cycle/);
  assert.throws(() => validate(wf([{ id: "a", type: "echo", needs: ["x"] }])), /unknown task "x"/);
  assert.throws(() => validate(wf([{ id: "a", type: "echo" }, { id: "a", type: "echo" }])), /duplicate/);
  assert.throws(() => validate(wf([{ id: "a", type: "nope" }]), new Set(["echo"])), ManifestError);
});

test("levels group independent tasks", () => {
  const w = wf([
    { id: "a", type: "echo" }, { id: "b", type: "echo" },
    { id: "c", type: "echo", needs: ["a", "b"] },
  ]);
  assert.deepEqual(levels(w).map((l) => l.map((t) => t.id)), [["a", "b"], ["c"]]);
  assert.equal(findCycle(w), null);
});

test("templates keep types for whole-string expressions and stringify inside text", () => {
  const scope = { tasks: { a: { output: { n: 3, list: [1] }, status: "success" } }, env: { X: "y" }, vars: { v: "z" } };
  assert.deepEqual(resolve("${tasks.a.output.list}", scope), [1]);
  assert.equal(resolve("n=${tasks.a.output.n} ${env.X}${vars.v}", scope), "n=3 yz");
  assert.throws(() => resolve("${tasks.nope.output}", scope), /no result/);
});

test("values flow between tasks and independent tasks run in parallel", async () => {
  const w = wf([
    { id: "a", type: "slow", with: { ms: 80 } },
    { id: "b", type: "slow", with: { ms: 80 } },
    { id: "c", type: "echo", needs: ["a", "b"], with: { value: "${tasks.a.output}+${tasks.b.output}" } },
  ]);
  const r = await runWorkflow(validate(w), rt(), { concurrency: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.tasks.c.output, "done+done");
  assert.ok(r.durationMs < 150, `expected parallel run, took ${r.durationMs}ms`);
});

test("concurrency limit is respected", async () => {
  const w = wf([1, 2, 3, 4].map((i) => ({ id: `t${i}`, type: "slow", with: { ms: 60 } })));
  const r = await runWorkflow(validate(w), rt(), { concurrency: 2 });
  assert.ok(r.durationMs >= 115, `expected two waves, took ${r.durationMs}ms`);
});

test("retries with backoff eventually succeed", async () => {
  const w = wf([{ id: "a", type: "flaky", retries: 2, backoffMs: 1, with: { failures: 2 } }]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.ok, true);
  assert.equal(r.tasks.a.attempts, 3);
  assert.equal(r.tasks.a.output, "ok after 3");
});

test("failure skips dependents transitively, allowFailure does not", async () => {
  const w = wf([
    { id: "bad", type: "fail" },
    { id: "d1", type: "echo", needs: ["bad"] },
    { id: "d2", type: "echo", needs: ["d1"] },
    { id: "soft", type: "fail", allowFailure: true },
    { id: "after", type: "echo", needs: ["soft"], with: { value: "ran" } },
  ]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.ok, false);
  assert.equal(r.tasks.bad.status, "failed");
  assert.equal(r.tasks.d1.status, "skipped");
  assert.equal(r.tasks.d2.status, "skipped");
  assert.equal(r.tasks.after.status, "success");
});

test("fallback replaces output and is not scheduled on its own", async () => {
  const w = wf([
    { id: "main", type: "fail", fallback: "backup" },
    { id: "backup", type: "echo", with: { value: "from backup" } },
    { id: "use", type: "echo", needs: ["main"], with: { value: "got ${tasks.main.output}" } },
  ]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.ok, true);
  assert.equal(r.tasks.main.usedFallback, "backup");
  assert.equal(r.tasks.use.output, "got from backup");
});

test("fallback not used when primary succeeds", async () => {
  const w = wf([
    { id: "main", type: "echo", fallback: "backup", with: { value: "primary" } },
    { id: "backup", type: "fail" },
  ]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.ok, true);
  assert.equal(r.tasks.main.output, "primary");
  assert.equal(r.tasks.backup, undefined);
});

test("timeouts fail the task", async () => {
  const w = wf([{ id: "s", type: "slow", timeoutMs: 20, with: { ms: 500 } }]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.tasks.s.status, "failed");
  assert.match(r.tasks.s.error!, /timed out/);
});

test("abort signal stops the run and skips what is left", async () => {
  const ctl = new AbortController();
  const w = wf([
    { id: "a", type: "slow", with: { ms: 500 } },
    { id: "b", type: "echo", needs: ["a"] },
  ]);
  setTimeout(() => ctl.abort(), 20);
  const r = await runWorkflow(validate(w), rt(), { signal: ctl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.tasks.a.status, "failed");
  assert.equal(r.tasks.b.status, "skipped");
});

test("hooks fire in order and a throwing hook does not break the run", async () => {
  const runtime = rt();
  const seen: string[] = [];
  runtime.on("runStart", () => { seen.push("start"); });
  runtime.on("taskEnd", (t) => { seen.push(`end:${t.id}`); throw new Error("hook bug"); });
  runtime.on("runEnd", () => { seen.push("done"); });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await runWorkflow(validate(wf([{ id: "a", type: "echo" }])), runtime);
    assert.equal(r.ok, true);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(seen, ["start", "end:a", "done"]);
});

test("unresolved template fails the task without retrying", async () => {
  const w = wf([{ id: "a", type: "echo", retries: 3, with: { value: "${tasks.ghost.output}" } }]);
  const r = await runWorkflow(validate(w), rt());
  assert.equal(r.tasks.a.status, "failed");
  assert.equal(r.tasks.a.attempts, 0);
});

test("shell executor captures stdout and reports exit codes", async () => {
  const ok = await runWorkflow(validate(wf([{ id: "s", type: "shell", with: { cmd: "node -e \"console.log('hi')\"" } }])), rt());
  assert.equal(ok.tasks.s.output, "hi");
  const bad = await runWorkflow(validate(wf([{ id: "s", type: "shell", with: { cmd: "node -e \"process.exit(3)\"" } }])), rt());
  assert.match(bad.tasks.s.error!, /exit code 3/);
});

test("llm context fitting drops oldest chunks first", () => {
  const chunks = ["a".repeat(400), "b".repeat(400), "c".repeat(400)];
  const { text, dropped } = fitContext(chunks, 250);
  assert.equal(dropped, 1);
  assert.ok(text.includes("c") && text.includes("b") && !text.includes("a"));
  const cut = fitContext(["x".repeat(4000)], 100);
  assert.equal(cut.text.length, 400);
});
