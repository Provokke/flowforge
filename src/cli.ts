#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Runtime, runWorkflow } from "./engine.ts";
import { builtins } from "./executors/index.ts";
import { levels, toMermaid, toText, validate } from "./graph.ts";
import { ManifestError } from "./types.ts";
import type { Plugin, RunResult, Workflow } from "./types.ts";

const HELP = `flowforge - run task DAGs with retries, fallbacks and plugins

Usage:
  flowforge run <workflow.json> [options]
  flowforge validate <workflow.json> [--json]
  flowforge graph <workflow.json> [--format text|mermaid|json]

Options:
  -c, --concurrency <n>   max parallel tasks (default: manifest value or 4)
      --var <k=v>         set a workflow variable, repeatable (\${vars.k})
      --plugin <file>     load a plugin module, repeatable
      --dry-run           validate and print the execution plan only
      --json              machine-readable result on stdout, logs on stderr
  -q, --quiet             no progress output
  -h, --help              show this help

Exit codes: 0 success, 1 workflow failed, 2 invalid input or usage.
`;

const useColour = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);

class UsageError extends Error {}

async function loadWorkflow(file: string, rt: Runtime): Promise<Workflow> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  return validate(raw, new Set(rt.executors.keys()));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      concurrency: { type: "string", short: "c" },
      var: { type: "string", multiple: true },
      plugin: { type: "string", multiple: true },
      format: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, file] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(HELP);
    return cmd || values.help ? 0 : 2;
  }
  if (!["run", "validate", "graph"].includes(cmd)) throw new UsageError(`unknown command "${cmd}"`);
  if (!file) throw new UsageError(`\`${cmd}\` needs a workflow file`);

  const rt = new Runtime();
  for (const e of builtins) rt.registerExecutor(e);
  for (const p of values.plugin ?? []) {
    const mod = (await import(pathToFileURL(resolvePath(p)).href)) as { default?: Plugin };
    if (typeof mod.default !== "function") throw new UsageError(`plugin ${p} must default-export a function`);
    await mod.default(rt);
  }

  const wf = await loadWorkflow(file, rt);

  if (cmd === "validate") {
    if (values.json) console.log(JSON.stringify({ valid: true, name: wf.name, tasks: wf.tasks.length }));
    else console.log(`${wf.name}: OK (${wf.tasks.length} tasks)`);
    return 0;
  }

  if (cmd === "graph") {
    const fmt = values.format ?? "text";
    if (fmt === "mermaid") console.log(toMermaid(wf));
    else if (fmt === "json") console.log(JSON.stringify(levels(wf).map((l) => l.map((t) => t.id))));
    else if (fmt === "text") console.log(toText(wf));
    else throw new UsageError(`unknown format "${fmt}"`);
    return 0;
  }

  if (values["dry-run"]) {
    if (values.json) console.log(JSON.stringify({ plan: levels(wf).map((l) => l.map((t) => t.id)) }));
    else console.log(toText(wf));
    return 0;
  }

  const vars: Record<string, string> = {};
  for (const kv of values.var ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new UsageError(`--var expects k=v, got "${kv}"`);
    vars[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new UsageError("--concurrency must be a positive integer");
  }

  const say = (m: string) => { if (!values.quiet) process.stderr.write(`${m}\n`); };
  rt.on("taskStart", (t, attempt) => say(`${c(36, "▶")} ${t.id}${attempt > 1 ? ` (attempt ${attempt})` : ""}`));
  rt.on("taskEnd", (t, r) => {
    const mark = r.status === "success" ? c(32, "✔") : r.status === "skipped" ? c(33, "↷") : c(31, "✘");
    const extra = r.status === "skipped" ? ` (${r.skippedBecause})` : r.status === "failed" ? ` ${c(31, r.error ?? "")}` : r.usedFallback ? ` (via fallback ${r.usedFallback})` : "";
    say(`${mark} ${t.id} ${r.durationMs}ms${extra}`);
  });

  const ctl = new AbortController();
  process.once("SIGINT", () => { say("interrupted, stopping..."); ctl.abort(); });

  const result = await runWorkflow(wf, rt, { concurrency, vars, signal: ctl.signal, log: say });
  report(result, !!values.json, say);
  return result.ok ? 0 : 1;
}

function report(r: RunResult, json: boolean, say: (m: string) => void) {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const counts = { success: 0, failed: 0, skipped: 0 } as Record<string, number>;
  for (const t of Object.values(r.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  say(`${r.ok ? c(32, "PASSED") : c(31, "FAILED")} ${r.workflow} in ${r.durationMs}ms — ${counts.success} ok, ${counts.failed} failed, ${counts.skipped} skipped`);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    if (e instanceof ManifestError) console.error(e.message);
    else if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error(`error: ${(e as Error).message}\n\nRun with --help for usage.`);
    else console.error(`error: ${(e as Error).stack ?? e}`);
    process.exitCode = 2;
  },
);
