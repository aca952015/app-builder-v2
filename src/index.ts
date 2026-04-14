#!/usr/bin/env node

import { loadProjectEnv } from "./lib/env.js";
import { runCli } from "./lib/cli.js";

loadProjectEnv()
  .then(() => runCli(process.argv.slice(2)))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`app-builder: ${message}`);
    process.exitCode = 1;
  });
