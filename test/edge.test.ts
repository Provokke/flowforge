import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime, runWorkflow } from "../src/engine.ts";
import { builtins } from "../src/executors/index.ts";
import { validate } from "../src/graph.ts";
import type { TaskResult, TaskSpec } from "../src/types.ts";

function rt() {
  const r = new Runtime();
  for (const e of builtins) r.registerExecutor(e);
  r.registerExecutor({ type: "fail", run: async () => { throw new Error("boom"); } });
  return r;
}
const wf = (tasks: TaskSpec[]) => validate({ name: "t", tasks });

test("abort during retry backoff returns promptly instead of waiting out the delay", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  const r = await runWorkflow(wf([{ id: "a", type: "fail", retries: 5, backoffMs: 60_000 }]), rt(), { signal: ctl.signal });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.tasks.a.status, "failed");
});

test("fallback chain: second fallback rescues when the first also fails", async () => {
  const r = await runWorkflow(wf([
    { id: "p", type: "fail", fallback: "f1" },
    { id: "f1", type: "fail", fallback: "f2" },
    { id: "f2", type: "echo", with: { value: "rescued" } },
  ]), rt());
  assert.equal(r.ok, true);
  assert.equal(r.tasks.p.output, "rescued");
  assert.equal(r.tasks.p.usedFallback, "f2");
});

test("when every fallback fails the error names the whole chain and dependents skip", async () => {
  const r = await runWorkflow(wf([
    { id: "p", type: "fail", fallback: "f1" },
    { id: "f1", type: "fail" },
    { id: "after", type: "echo", needs: ["p"] },
  ]), rt());
  assert.equal(r.ok, false);
  assert.match(r.tasks.p.error!, /boom; fallback "f1" failed: boom/);
  assert.equal(r.tasks.after.status, "skipped");
});

test("fallback tasks get their own taskEnd hook and retries apply to them", async () => {
  const runtime = rt();
  const ended: string[] = [];
  runtime.on("taskEnd", (t: TaskSpec, res: TaskResult) => { ended.push(`${t.id}:${res.status}`); });
  let n = 0;
  runtime.registerExecutor({ type: "second-time", run: async () => { if (++n < 2) throw new Error("first"); return "ok"; } });
  const r = await runWorkflow(wf([
    { id: "p", type: "fail", fallback: "f" },
    { id: "f", type: "second-time", retries: 1, backoffMs: 1 },
  ]), runtime);
  assert.equal(r.ok, true);
  assert.deepEqual(ended, ["f:success", "p:success"]);
});

test("timeout applies per attempt and combines with retries", async () => {
  const runtime = rt();
  let calls = 0;
  runtime.registerExecutor({
    type: "hang",
    run: ({ signal }) => new Promise((_, rej) => { calls++; signal.addEventListener("abort", () => rej(new Error("aborted"))); }),
  });
  const r = await runWorkflow(wf([{ id: "h", type: "hang", timeoutMs: 20, retries: 2, backoffMs: 1 }]), runtime);
  assert.equal(calls, 3);
  assert.equal(r.tasks.h.attempts, 3);
  assert.match(r.tasks.h.error!, /timed out/);
});

test("registering the same executor type twice throws", () => {
  const r = rt();
  assert.throws(() => r.registerExecutor({ type: "echo", run: async () => 1 }), /already registered/);
});

test("task without a `with` block works and a skipped task never starts", async () => {
  const runtime = rt();
  const started: string[] = [];
  runtime.on("taskStart", (t: TaskSpec) => { started.push(t.id); });
  const r = await runWorkflow(wf([
    { id: "a", type: "fail" },
    { id: "b", type: "echo", needs: ["a"] },
    { id: "c", type: "echo" },
  ]), runtime);
  assert.deepEqual(started.sort(), ["a", "c"]);
  assert.equal(r.tasks.c.output, undefined);
  assert.equal(r.tasks.b.skippedBecause, 'dependency "a" did not succeed');
});

test("diamond graph: shared dependency runs exactly once", async () => {
  const runtime = rt();
  let root = 0;
  runtime.registerExecutor({ type: "root", run: async () => ++root });
  const r = await runWorkflow(wf([
    { id: "r", type: "root" },
    { id: "l", type: "echo", needs: ["r"], with: { value: "L${tasks.r.output}" } },
    { id: "m", type: "echo", needs: ["r"], with: { value: "M${tasks.r.output}" } },
    { id: "j", type: "echo", needs: ["l", "m"], with: { value: "${tasks.l.output}${tasks.m.output}" } },
  ]), runtime);
  assert.equal(root, 1);
  assert.equal(r.tasks.j.output, "L1M1");
});

test("wide graph of 200 tasks completes under a low concurrency cap", async () => {
  const tasks: TaskSpec[] = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, type: "echo", needs: i ? [`t${i % 7 === 0 ? 0 : i - 1}`] : [], with: { value: i } }));
  const r = await runWorkflow(wf(tasks), rt(), { concurrency: 3 });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(r.tasks).length, 200);
});

test("shell fails a task whose stdout exceeds the 10 MB cap", async () => {
  const r = await runWorkflow(wf([{ id: "s", type: "shell", with: { cmd: 'node -e "process.stdout.write(\'x\'.repeat(11*1024*1024))"' } }]), rt());
  assert.equal(r.tasks.s.status, "failed");
  assert.match(r.tasks.s.error!, /exceeded/);
});

test("shell abort kills grandchild processes (no orphans)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-orphan-"));
  const marker = join(dir, "alive.txt").replaceAll("\\", "/");
  // the shell starts a node grandchild that writes the marker after 1.5s if still alive
  const inner = `setTimeout(()=>require('fs').writeFileSync('${marker}','x'),1500)`;
  try {
    const r = await runWorkflow(wf([{ id: "s", type: "shell", timeoutMs: 300, with: { cmd: `node -e "${inner}"` } }]), rt());
    assert.equal(r.tasks.s.status, "failed");
    await new Promise((res) => setTimeout(res, 2200));
    assert.equal(existsSync(marker), false, "grandchild survived the abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
