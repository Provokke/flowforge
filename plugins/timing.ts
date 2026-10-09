import type { Plugin } from "../src/types.ts";

/** Example plugin. Adds a `sleep` executor and prints the slowest task at the end. */
const plugin: Plugin = (api) => {
  api.registerExecutor({
    type: "sleep",
    run: ({ params, signal }) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => res(null), Number(params.ms ?? 100));
        signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
      }),
  });
  api.on("runEnd", (r) => {
    const slowest = Object.values(r.tasks).sort((a, b) => b.durationMs - a.durationMs)[0];
    if (slowest) console.error(`[timing] slowest task: ${slowest.id} (${slowest.durationMs}ms)`);
  });
};
export default plugin;
