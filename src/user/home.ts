// The home directory for init, apply and doctor --user: it has to exist (decision D-091), and when root works in the
// home directory of another user (sudo with HOME kept), what it creates there belongs to that user (decision D-093).
import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import type { Owner } from '../apply/workspace.ts';
import { isInside } from '../paths.ts';
import type { UserEnvironment } from './locate.ts';

/** A problem that concerns no single user file, with its code. */
export interface HomeProblem {
  code: ApplyErrorCode;
  location: { file: string };
  message: string;
  fix: string;
}

/** What each command does not do without a home directory. */
const CONSEQUENCES = {
  init: 'so depcurfew init --user writes no user policy',
  apply: 'so depcurfew apply --user has nowhere to write the user configuration',
  doctor: 'so depcurfew doctor --user cannot check the user configuration in it',
} as const;

/**
 * Why the home directory cannot be used, or undefined when it can. Every user file but those under an absolute
 * XDG_CONFIG_HOME or APPDATA is in it, and creating it (with mkdir -p) would make one for a system user such as
 * nobody, whose HOME is /nonexistent; init --user refuses too, as the user policy is of no use without it.
 */
export function homeProblem(environment: UserEnvironment, command: keyof typeof CONSEQUENCES): HomeProblem | undefined {
  const { home } = environment;
  const module = environment.platform === 'win32' ? win32 : posix;
  const variable = environment.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const fixFor = (what: string) => `Set ${variable} to ${what}, or run depcurfew ${command} --user as a user who has a home directory`;
  const problem = (message: string, fix = fixFor('an existing directory')): HomeProblem => ({ code: 'home-missing', location: { file: home }, message, fix });
  if (!module.isAbsolute(home)) {
    return problem(`the home directory ${JSON.stringify(home)} is not an absolute path, so depcurfew ${command} --user cannot tell where the user configuration is`, fixFor('the absolute path of an existing directory'));
  }
  let stats;
  try {
    stats = statSync(home, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (stats === undefined) return problem(`the home directory ${home} does not exist, ${CONSEQUENCES[command]}`);
  if (!stats.isDirectory()) return problem(`the home directory ${home} is not a directory, ${CONSEQUENCES[command]}`);
  return undefined;
}

/**
 * Who gets what init and apply --user create below the home directory: its owner, when depcurfew runs as root and the
 * home directory belongs to another user; undefined otherwise (new files are the running user's, as for any program).
 * Files outside the home directory (an absolute XDG_CONFIG_HOME elsewhere) stay root's. POSIX only.
 */
export function ownerOfNewUnderHome(environment: UserEnvironment): ((path: string) => Owner | undefined) | undefined {
  if (environment.platform === 'win32' || process.platform === 'win32' || process.getuid?.() !== 0) return undefined;
  let stats;
  let real: string;
  try {
    stats = statSync(environment.home);
    real = realpathSync(environment.home);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory() || stats.uid === process.getuid()) return undefined;
  const owner: Owner = { uid: stats.uid, gid: stats.gid };
  const below = (root: string, path: string) => path !== root && isInside(root, path, posix);
  return (path) => (below(environment.home, path) || below(real, path) ? owner : undefined);
}
