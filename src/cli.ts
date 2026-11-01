#!/usr/bin/env node
import { colorsFor } from './color.ts';
import { EXIT_FAILURE } from './cli/io.ts';

/**
 * Output to a stream whose reader has gone (depcurfew doctor --sarif | head -1) fails with EPIPE, which Node reports
 * as an 'error' event that nobody handles: a stack trace and exit code 1. The rest of the output is dropped instead,
 * quietly, and the command still ends with its own exit code.
 */
function quietWhenClosed(stream: NodeJS.WriteStream): (text: string) => void {
  let closed = false;
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
      closed = true;
      return;
    }
    closed = true;
    if (stream !== process.stderr) process.stderr.write(`depcurfew: cannot write the output: ${error.message}\n`);
    process.exitCode = EXIT_FAILURE;
  });
  return (text) => {
    if (!closed) stream.write(text);
  };
}

/**
 * Node 22.15 and later warn on stderr while loading node:util (which parseArgs needs) when FORCE_COLOR and NO_COLOR
 * are both set: "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set". depcurfew decides about colors
 * itself, the same way (colorsFor: FORCE_COLOR wins), and stderr must stay empty with --json. Node emits warnings on
 * the next tick, which on Node.js 24 and later comes before this module runs when node:util is a static import, so the
 * filter is installed first and the commands are loaded afterwards; every other warning is printed as before.
 */
function dropColorWarning(): void {
  const printers = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'Warning' && warning.message.includes("'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env")) return;
    for (const print of printers) print(warning);
  });
}

dropColorWarning();
import('./cli/run.ts')
  .then(({ run }) =>
    run(process.argv.slice(2), {
      stdout: quietWhenClosed(process.stdout),
      stderr: quietWhenClosed(process.stderr),
      colors: { stdout: colorsFor(process.stdout, process.env), stderr: colorsFor(process.stderr, process.env) },
      terminal: { stdout: process.stdout.isTTY === true, stderr: process.stderr.isTTY === true },
    }),
  )
  .then(
    (code) => {
      // An output error after the command ended keeps its exit code; one before it set EXIT_FAILURE already.
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`depcurfew: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = EXIT_FAILURE;
    },
  );
