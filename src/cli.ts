#!/usr/bin/env node
import { colorsFor } from './color.ts';
import { EXIT_FAILURE, run } from './cli/run.ts';

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

run(process.argv.slice(2), {
  stdout: quietWhenClosed(process.stdout),
  stderr: quietWhenClosed(process.stderr),
  colors: { stdout: colorsFor(process.stdout, process.env), stderr: colorsFor(process.stderr, process.env) },
  terminal: { stdout: process.stdout.isTTY === true, stderr: process.stderr.isTTY === true },
}).then(
  (code) => {
    // An output error after the command ended keeps its exit code; one before it set EXIT_FAILURE already.
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`depcurfew: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = EXIT_FAILURE;
  },
);
