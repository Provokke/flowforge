import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Runtime, runWorkflow } from "../src/engine.ts";
import { builtins } from "../src/executors/index.ts";
import { validate } from "../src/graph.ts";
import type { TaskSpec } from "../src/types.ts";

const rt = () => {
  const r = new Runtime();
  for (const e of builtins) r.registerExecutor(e);
  return r;
};
async function one(task: Omit<TaskSpec, "id">) {
  const r = await runWorkflow(validate({ name: "t", tasks: [{ id: "x", ...task }] }), rt());
  return r.tasks.x;
}

async function withServer(handler: (req: IncomingMessage, body: string) => { status?: number; body: unknown; raw?: boolean }, fn: (base: string) => Promise<void>) {
  const seen: { req: IncomingMessage; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ req, body });
      const out = handler(req, body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(out.raw ? String(out.body) : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("http: GET text, json, POST body, error status", async () => {
  await withServer((req, body) => ({ body: { method: req.method, body, ct: req.headers["content-type"] ?? null } }), async (base) => {
    const get = await one({ type: "http", with: { url: `${base}/a`, json: true } });
    assert.equal(get.output && (get.output as { method: string }).method, "GET");
    const post = await one({ type: "http", with: { url: base, json: true, body: { n: 1 } } });
    const out = post.output as { method: string; body: string; ct: string };
    assert.equal(out.method, "POST");
    assert.equal(out.body, '{"n":1}');
    assert.equal(out.ct, "application/json");
    const text = await one({ type: "http", with: { url: base } });
    assert.equal(typeof text.output, "string");
  });
  await withServer(() => ({ status: 500, body: "nope", raw: true }), async (base) => {
    const bad = await one({ type: "http", with: { url: base } });
    assert.equal(bad.status, "failed");
    assert.match(bad.error!, /HTTP 500: nope/);
  });
  assert.match((await one({ type: "http", with: {} })).error!, /url/);
});

test("llm: openai-compatible request shape, auth header, context trimming", async () => {
  process.env.FF_TEST_KEY = "secret";
  await withServer((req, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer secret");
    const j = JSON.parse(body);
    assert.equal(j.model, "m1");
    assert.deepEqual(j.messages.map((m: { role: string }) => m.role), ["system", "user"]);
    assert.ok(j.messages[1].content.endsWith("question?"));
    assert.ok(!j.messages[1].content.includes("OLDEST"), "oldest chunk should have been trimmed");
    assert.ok(j.messages[1].content.includes("NEWEST"));
    return { body: { choices: [{ message: { content: "the answer" } }] } };
  }, async (base) => {
    const r = await one({
      type: "llm",
      with: {
        baseUrl: `${base}/v1`, model: "m1", system: "be brief", apiKeyEnv: "FF_TEST_KEY", maxContextTokens: 60,
        context: ["OLDEST " + "x".repeat(300), "NEWEST " + "y".repeat(100)], prompt: "question?",
      },
    });
    assert.equal(r.output, "the answer", r.error);
  });
});

test("llm: HTTP errors, malformed responses, missing prompt, mock provider", async () => {
  await withServer(() => ({ status: 429, body: "slow down", raw: true }), async (base) => {
    assert.match((await one({ type: "llm", with: { baseUrl: base, prompt: "p" } })).error!, /HTTP 429/);
  });
  await withServer(() => ({ body: { choices: [] } }), async (base) => {
    assert.match((await one({ type: "llm", with: { baseUrl: base, prompt: "p" } })).error!, /no choices/);
  });
  assert.match((await one({ type: "llm", with: {} })).error!, /prompt/);
  const mock = await one({ type: "llm", with: { provider: "mock", model: "z", prompt: "hi" } });
  assert.equal(mock.output, "[mock:z] hi");
});

test("shell: cwd, env, stdin, json parsing, stderr is not output", async () => {
  const js = (code: string) => `node -e "${code}"`;
  assert.equal((await one({ type: "shell", with: { cmd: js("console.log(process.cwd())"), cwd: process.cwd() } })).output, process.cwd());
  assert.equal((await one({ type: "shell", with: { cmd: js("console.log(process.env.FF_X)"), env: { FF_X: "v" } } })).output, "v");
  assert.equal((await one({ type: "shell", with: { cmd: js("process.stdin.pipe(process.stdout)"), input: "piped" } })).output, "piped");
  assert.deepEqual((await one({ type: "shell", with: { cmd: js("console.log(JSON.stringify({a:1}))"), json: true } })).output, { a: 1 });
  assert.match((await one({ type: "shell", with: { cmd: js("console.log('nope')"), json: true } })).error!, /not valid JSON/);
  const noisy = await one({ type: "shell", with: { cmd: js("console.error('warn');console.log('out')") } });
  assert.equal(noisy.output, "out");
  const failed = await one({ type: "shell", with: { cmd: js("console.error('why');process.exit(2)") } });
  assert.match(failed.error!, /exit code 2: why/);
  assert.match((await one({ type: "shell", with: {} })).error!, /cmd/);
});

test("shell: timeout kills the process promptly", async () => {
  const t0 = Date.now();
  const r = await one({ type: "shell", timeoutMs: 200, with: { cmd: 'node -e "setTimeout(()=>{},30000)"' } });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
});
