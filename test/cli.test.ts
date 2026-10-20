import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const dir = mkdtempSync(join(tmpdir(), "ff-cli-"));

function manifest(name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}
function ff(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const good = manifest("good.json", {
  name: "good",
  vars: { who: "world" },
  tasks: [
    { id: "a", type: "echo", with: { value: "hello ${vars.who}" } },
    { id: "b", type: "echo", needs: ["a"], with: { value: "${tasks.a.output}!" } },
  ],
});
const failing = manifest("failing.json", {
  name: "failing",
  tasks: [{ id: "x", type: "shell", with: { cmd: "node -e \"process.exit(4)\"" } }, { id: "y", type: "echo", needs: ["x"] }],
});

test("run: success exits 0 and --json is parseable on stdout", () => {
  const r = ff("run", good, "--json", "-q");
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.tasks.b.output, "hello world!");
  assert.equal(r.err, "");
});

test("run: --var overrides manifest vars", () => {
  const j = JSON.parse(ff("run", good, "--json", "-q", "--var", "who=cli").out);
  assert.equal(j.tasks.b.output, "hello cli!");
});

test("run: failing workflow exits 1 and reports skipped dependents", () => {
  const r = ff("run", failing, "--json", "-q");
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.tasks.x.status, "failed");
  assert.equal(j.tasks.y.status, "skipped");
});

test("run: human output goes to stderr and ends with a summary", () => {
  const r = ff("run", good);
  assert.equal(r.code, 0);
  assert.match(r.err, /PASSED good/);
  assert.equal(r.out, "");
});

test("run: --dry-run executes nothing", () => {
  const r = ff("run", failing, "--dry-run", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { plan: [["x"], ["y"]] });
});

test("validate and graph formats", () => {
  assert.match(ff("validate", good).out, /good: OK \(2 tasks\)/);
  assert.deepEqual(JSON.parse(ff("validate", good, "--json").out), { valid: true, name: "good", tasks: 2 });
  assert.match(ff("graph", good).out, /stage 1/);
  assert.match(ff("graph", good, "--format", "mermaid").out, /a --> b/);
  assert.deepEqual(JSON.parse(ff("graph", good, "--format", "json").out), [["a"], ["b"]]);
  assert.equal(ff("graph", good, "--format", "dot").code, 2);
});

test("exit code 2 for bad input", () => {
  const cyc = manifest("cyc.json", { name: "c", tasks: [{ id: "a", type: "echo", needs: ["b"] }, { id: "b", type: "echo", needs: ["a"] }] });
  const r = ff("validate", cyc);
  assert.equal(r.code, 2);
  assert.match(r.err, /cycle/);
  assert.match(ff("validate", manifest("unk.json", { name: "u", tasks: [{ id: "a", type: "nope" }] })).err, /unknown type "nope"/);
  assert.equal(ff("validate", manifest("junk.json", "{not json")).code, 2);
  assert.equal(ff("validate", join(dir, "missing.json")).code, 2);
  assert.equal(ff("frobnicate", good).code, 2);
  assert.equal(ff("run").code, 2);
  assert.equal(ff("run", good, "--var", "novalue").code, 2);
  assert.equal(ff("run", good, "-c", "0").code, 2);
  assert.equal(ff("run", good, "--nope").code, 2);
});

test("help exits 0, no args exits 2", () => {
  assert.equal(ff("--help").code, 0);
  assert.match(ff("--help").out, /Usage:/);
  assert.equal(ff().code, 2);
});

test("plugins: custom executor + hook load through --plugin", () => {
  const plugin = join(dir, "p.ts");
  writeFileSync(plugin, `export default (api) => {
    api.registerExecutor({ type: "shout", run: async ({ params }) => String(params.text).toUpperCase() });
    api.on("runEnd", () => console.error("PLUGIN-RUNEND"));
  };`);
  const wf = manifest("plug.json", { name: "p", tasks: [{ id: "s", type: "shout", with: { text: "hi" } }] });
  const r = ff("run", wf, "--plugin", plugin, "--json");
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).tasks.s.output, "HI");
  assert.match(r.err, /PLUGIN-RUNEND/);
  assert.equal(ff("run", wf).code, 2, "unknown type without plugin");
});

test("plugins: bad plugins are usage errors", () => {
  const bad = join(dir, "bad-plugin.ts");
  writeFileSync(bad, "export default 42;");
  assert.equal(ff("validate", good, "--plugin", bad).code, 2);
  assert.equal(ff("validate", good, "--plugin", join(dir, "nope.ts")).code, 2);
});

test("builtin executor cannot be shadowed by a plugin", () => {
  const dup = join(dir, "dup.ts");
  writeFileSync(dup, `export default (api) => api.registerExecutor({ type: "echo", run: async () => 1 });`);
  const r = ff("validate", good, "--plugin", dup);
  assert.equal(r.code, 2);
  assert.match(r.err, /already registered/);
});
