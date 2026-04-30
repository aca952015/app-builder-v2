#!/usr/bin/env node

import { spawn } from "node:child_process";

function isBunRuntime(): boolean {
  return Boolean((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun);
}

async function runWithNodeRuntime(): Promise<void> {
  const { loadProjectEnv } = await import("./lib/env.js");
  const { runCli } = await import("./lib/cli.js");

  await loadProjectEnv();
  await runCli(process.argv.slice(2));
}

function reexecWithNode(): void {
  const child = spawn("node", process.argv.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      APP_BUILDER_REEXEC_FROM_BUN: "1",
    },
  });

  child.once("error", (error) => {
    console.error(`app-builder: Node.js is required for runtime proxy support, but starting node failed: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (isBunRuntime() && process.env.APP_BUILDER_REEXEC_FROM_BUN !== "1") {
  reexecWithNode();
} else {
  runWithNodeRuntime().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`app-builder: ${message}`);
    process.exitCode = 1;
  });
}
