#!/usr/bin/env node
/**
 * pi-durable — thin launcher shim.
 *
 * All logic lives in the compiled `dist/cli.js`. This file only forwards argv
 * and the process exit code. Keeping it tiny avoids drift between the source
 * CLI and the installed entry point.
 */

import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
