// The directory a command works on, and what a command says when it cannot start: a directory that does not exist,
// or a depcurfew.json that cannot be used. Each such error has a code, a message and what to do, from one source for
// the text on stderr and the `errors` of --json.
import { statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { PolicyError, policyErrorFix } from '../apply/index.ts';
import { listedAsProject } from '../apply/projects.ts';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import { paint, PLAIN, type Paint } from '../color.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { findPolicyDirectory } from '../policy/file.ts';
import { printable } from '../printable.ts';
import type { CliIo } from './io.ts';

/** An error that keeps a command from starting, in the shape of the errors of apply --json and check --json. */
export interface InputError {
  code: ApplyErrorCode;
  level: 'error';
  /** `variable` with file "environment": the environment variable that is wrong (HOME, decision D-124). */
  location: { file: string; line?: number; variable?: string };
  message: string;
  fix: string;
  issues?: string[];
}

export type DirectoryResult = { ok: true; directory: string; notice?: string } | { ok: false; error: InputError };

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0] ?? message;
}

/** The absolute path of an existing directory given on the command line (default: `cwd`). */
export function checkDirectory(directory: string | undefined, cwd = process.cwd()): DirectoryResult {
  const shown = directory ?? '.';
  const absolute = resolve(cwd, shown);
  const failure = (code: ApplyErrorCode, message: string, fix: string): DirectoryResult => ({ ok: false, error: { code, level: 'error', location: { file: shown }, message, fix } });
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
    const message = reason === 'ENOENT' || reason === 'ENOTDIR' ? `directory not found: ${shown}` : `cannot open the directory ${shown}: ${firstLine(error)}`;
    return failure('directory-not-found', message, 'Pass the path of an existing directory');
  }
  if (!isDirectory) return failure('not-a-directory', `not a directory: ${shown}`, 'Pass the directory of the project, not a file in it');
  return { ok: true, directory: absolute };
}

/**
 * The directory apply, doctor and explain work on. Without a directory on the command line, it is the nearest directory
 * with depcurfew.json from `cwd` up to the root of the repository, so a command run in a subdirectory does not pass for
 * a project without a policy. A directory given on the command line is taken as it is, unless the nearest depcurfew.json
 * above it lists it (or a directory it lies in) under projects: then the command works on that root, which checks it as
 * one of its projects, as when run in that directory (decision D-115). `notice` says which directory it is.
 */
export function projectDirectory(directory: string | undefined, command: string, cwd = process.cwd()): DirectoryResult {
  if (directory !== undefined) {
    const checked = checkDirectory(directory, cwd);
    if (!checked.ok) return checked;
    const found = findPolicyDirectory(checked.directory);
    if (found === undefined || found === checked.directory || !listedAsProject(found, checked.directory)) return checked;
    const shown = relative(resolve(cwd), found).split(sep).join('/') || '.';
    const file = shown === '.' ? POLICY_FILE : `${shown}/${POLICY_FILE}`;
    return {
      ok: true,
      directory: found,
      notice: `${directory} is listed in projects in ${file}, so depcurfew ${command} works on ${shown}, which covers it with that policy; paths are relative to it`,
    };
  }
  const start = resolve(cwd);
  const found = findPolicyDirectory(start);
  if (found === undefined || found === start) return checkDirectory(undefined, start);
  const shown = relative(start, found).split(sep).join('/');
  return { ok: true, directory: found, notice: `using ${shown}/${POLICY_FILE} from a parent directory, so depcurfew ${command} works on ${shown}; paths are relative to it` };
}

/** A depcurfew.json that cannot be used, as an input error; `file` is where it is, as the command shows it. */
export function policyInputError(error: PolicyError, file: string): InputError {
  return {
    code: error.code,
    level: 'error',
    location: { file, ...(error.line === undefined ? {} : { line: error.line }) },
    message: error.message,
    fix: policyErrorFix(error, file),
    ...(error.issues.length === 0 ? {} : { issues: error.issues }),
  };
}

/**
 * The message of an input error with the line of its location, as the JSON document has it (decision D-122): after the
 * file when the message starts with it ("depcurfew.json (line 6) is invalid"), else before the message, as apply names
 * the line of an entry of projects ("app/depcurfew.json (line 6): depcurfew.json is invalid"). A message that names
 * the line itself, and a location without one, leave the message as it is. The Action says an invalid policy the same
 * way (decision D-124).
 */
export function messageAtLine(message: string, file: string, line: number | undefined): string {
  if (line === undefined || new RegExp(`\\bline ${line}\\b`, 'u').test(message)) return message;
  return message.startsWith(`${file} `) ? `${file} (line ${line})${message.slice(file.length)}` : `${file} (line ${line}): ${message}`;
}

function withLine(error: InputError): string {
  return messageAtLine(error.message, error.location.file, error.location.line);
}

/**
 * An input error as lines, like an error of apply: the level and the message with its code, the issues, then what to
 * do. One source for stderr and for explain, which shows an unusable depcurfew.json in its report (decision D-111).
 */
export function inputErrorLines(error: InputError, colors: Paint = PLAIN): string[] {
  return [
    `error: ${printable(withLine(error))} ${colors.dim(`(${error.code})`)}`,
    ...(error.issues ?? []).map((issue) => `  ${printable(issue)}`),
    `  ${colors.green('fix:')} ${printable(error.fix)}`,
  ];
}

/** An input error on stderr (inputErrorLines). */
export function reportInputError(error: InputError, io: CliIo): void {
  io.stderr(`${inputErrorLines(error, paint(io.colors?.stderr)).join('\n')}\n`);
}

/** The absolute path of an existing directory given on the command line, or undefined after reporting the error. */
export function resolveDirectory(directory: string | undefined, io: CliIo): string | undefined {
  const result = checkDirectory(directory);
  if (result.ok) return result.directory;
  reportInputError(result.error, io);
  return undefined;
}
