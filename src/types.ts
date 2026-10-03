export type TaskStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface TaskSpec {
  id: string;
  type: string;
  needs?: string[];
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  /** Task to run instead if this one still fails after its retries */
  fallback?: string;
  /** If it fails, dependants still run (its output is null) */
  allowFailure?: boolean;
  with?: Record<string, unknown>;
}

export interface Workflow {
  name: string;
  concurrency?: number;
  vars?: Record<string, string>;
  tasks: TaskSpec[];
}

export interface TaskResult {
  id: string;
  status: TaskStatus;
  output: unknown;
  attempts: number;
  durationMs: number;
  error?: string;
  /** Fallback task id, if the output came from one */
  usedFallback?: string;
  skippedBecause?: string;
}

export interface RunResult {
  workflow: string;
  ok: boolean;
  durationMs: number;
  tasks: Record<string, TaskResult>;
}

export interface ExecContext {
  task: TaskSpec;
  /** The `with` block after templates are filled in */
  params: Record<string, unknown>;
  signal: AbortSignal;
  attempt: number;
  log: (message: string) => void;
}

export interface Executor {
  type: string;
  run(ctx: ExecContext): Promise<unknown>;
}

export interface HookMap {
  runStart: (wf: Workflow) => void | Promise<void>;
  taskStart: (task: TaskSpec, attempt: number) => void | Promise<void>;
  taskEnd: (task: TaskSpec, result: TaskResult) => void | Promise<void>;
  runEnd: (result: RunResult) => void | Promise<void>;
}

export type HookName = keyof HookMap;

export interface PluginApi {
  registerExecutor(executor: Executor): void;
  on<K extends HookName>(hook: K, fn: HookMap[K]): void;
}

export type Plugin = (api: PluginApi) => void | Promise<void>;

export class ManifestError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Invalid workflow:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}
