# flowforge

A small workflow engine that runs tasks as a DAG. It has parallel scheduling, retries with backoff, fallback tasks, `${...}` templating between tasks and a plugin API. There are no runtime dependencies and no build step.

## Install

Needs Node 22.18 or newer, which runs the `.ts` files directly.

```sh
git clone https://github.com/Provokke/flowforge.git
cd flowforge
npm install   # dev tooling only (typescript, @types/node), needed for type checking
```

## Usage

```sh
node src/cli.ts run examples/pipeline.json
node src/cli.ts run examples/pipeline.json --json --var topic="bytecode VMs" -c 2
node src/cli.ts graph examples/pipeline.json --format mermaid
node src/cli.ts validate examples/pipeline.json
```

Flags: `-c/--concurrency <n>`, `--var k=v` (use as `${vars.k}`), `--plugin <file>`, `--dry-run`, `--json`, `-q/--quiet`. With `--json` the result goes to stdout and progress goes to stderr.

Exit codes: `0` ok, `1` a task failed, `2` bad manifest or usage.

## Workflows

A manifest is JSON with a list of tasks. `needs` builds the DAG, and `fallback` names a task to run if this one still fails after its retries. See `examples/pipeline.json` for a full one.

```json
{
  "name": "demo",
  "tasks": [
    { "id": "greet", "type": "shell", "retries": 2, "fallback": "greet_backup", "with": { "cmd": "echo hello" } },
    { "id": "greet_backup", "type": "echo", "with": { "value": "hello (backup)" } },
    { "id": "shout", "type": "echo", "needs": ["greet"], "with": { "value": "${tasks.greet.output}!" } }
  ]
}
```

Templates: `${tasks.<id>.output}`, `${vars.name}` and `${env.NAME}`. If a string is a single expression you get the real type back, not text.

Built-in task types are `shell`, `echo`, `http` and `llm`. The `llm` type talks to any OpenAI-compatible endpoint (Ollama on localhost by default) or a `mock` provider. `shell` fails a task if stdout goes over 10 MB.

## Plugins

A plugin is a module whose default export takes an API object. It can register executors and hook `runStart`, `taskStart`, `taskEnd` and `runEnd`. Load one with `--plugin path/to/plugin.ts`. See `plugins/timing.ts`.

## Development

```sh
npm test
npm run typecheck
```

MIT licence, see LICENSE.
