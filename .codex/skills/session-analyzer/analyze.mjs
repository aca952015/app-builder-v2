#!/usr/bin/env node

import { runCli } from "../../../scripts/analyze-metrics.mjs";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stderr: process.stderr,
  stdout: process.stdout,
});
