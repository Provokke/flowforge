import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Executor } from "../types.ts";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Kills the shell and its children. Plain `child.kill()` leaves grandchildren running. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative pid hits the whole process group (we spawn detached for this)
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** with: { cmd: string, cwd?: string, env?: Record<string,string>, input?: string, json?: boolean } */
export const shell: Executor = {
  type: "shell",
  run({ params, signal, log }) {
    const cmd = params.cmd;
    if (typeof cmd !== "string" || !cmd) return Promise.reject(new Error("shell: `with.cmd` is required"));
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, {
        shell: true,
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        env: { ...process.env, ...((params.env as Record<string, string>) ?? {}) },
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let out = "";
      let err = "";
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        killTree(child);
        done(() => reject(new Error("aborted")));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => {
        out += d;
        if (out.length > MAX_OUTPUT_BYTES) {
          killTree(child);
          done(() => reject(new Error(`stdout exceeded ${MAX_OUTPUT_BYTES} bytes`)));
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        err = (err + d).slice(-4000);
        for (const line of String(d).split(/\r?\n/).filter(Boolean)) log(line);
      });
      child.stdin.on("error", () => {}); // the process can exit before reading stdin, which throws EPIPE
      child.stdin.end(typeof params.input === "string" ? params.input : undefined);
      child.on("error", (e) => done(() => reject(e)));
      child.on("close", (code) =>
        done(() => {
          if (code !== 0) return reject(new Error(`exit code ${code}${err.trim() ? `: ${err.trim().slice(-500)}` : ""}`));
          const text = out.replace(/\r?\n$/, "");
          if (!params.json) return resolve(text);
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("output is not valid JSON"));
          }
        }),
      );
    });
  },
};
