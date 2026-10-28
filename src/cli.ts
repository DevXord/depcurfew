#!/usr/bin/env node
import { EXIT_FAILURE, run } from './cli/run.ts';

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`depgate: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = EXIT_FAILURE;
  },
);
