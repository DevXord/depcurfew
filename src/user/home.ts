// The home directory for init, apply and doctor --user: it has to exist (decision D-091), and when root works in the
// home directory of another user (sudo with HOME kept), what it creates there belongs to that user (decision D-093).
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import type { Owner } from '../apply/workspace.ts';
import { isInside } from '../paths.ts';
import type { UserEnvironment } from './locate.ts';

/** A problem that concerns no single user file, with its code. */
export interface HomeProblem {
  code: ApplyErrorCode;
  /**
   * The home directory; for one that is not an absolute path (also an empty HOME), the variable that names it, as
   * doctor --user names an environment variable: { file: "environment", variable: "HOME" } (decision D-124).
   */
  location: { file: string; variable?: string };
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
  const problem = (message: string, fix = fixFor('an existing directory'), location: HomeProblem['location'] = { file: home }): HomeProblem => ({ code: 'home-missing', location, message, fix });
  if (!module.isAbsolute(home)) {
    // A relative or empty value names no file: the variable is what is wrong.
    return problem(`the home directory ${JSON.stringify(home)} is not an absolute path, so depcurfew ${command} --user cannot tell where the user configuration is`, fixFor('the absolute path of an existing directory'), { file: 'environment', variable });
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

/** How deep linkOutOfHome follows links to missing files, as the kernel stops at 40 (ELOOP). */
const MAX_LINKS = 40;

/**
 * Where a symbolic link on the way to `path` leads out of the home directory, when depcurfew runs as root in the home
 * directory of another user (sudo with HOME kept; decision D-196): that user can put such a link there
 * (~/.config/pip -> /etc/pip, ~/.config/depcurfew -> /root/.config/depcurfew), and root would write through it into a
 * file of root or of the system. The nearest part of `path` that exists is resolved, with every link on the way; a link
 * to a missing file counts by where it points. undefined when the real path stays in the real home directory, for a
 * path that is not under the home directory (an absolute XDG_CONFIG_HOME elsewhere), and for any other user. POSIX only.
 */
export function linkOutOfHome(environment: UserEnvironment, path: string): { link: string; target: string } | undefined {
  if (ownerOfNewUnderHome(environment) === undefined) return undefined;
  const home = posix.resolve(environment.home);
  let real: string;
  try {
    real = realpathSync(home);
  } catch {
    return undefined;
  }
  const inside = (candidate: string) => isInside(real, candidate, posix) || isInside(home, candidate, posix);
  let current = posix.resolve(path);
  if (current === home || !isInside(home, current, posix)) return undefined;
  for (let links = 0; links <= MAX_LINKS; ) {
    let stats;
    try {
      stats = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      stats = undefined;
    }
    if (stats === undefined) {
      const parent = posix.dirname(current);
      if (parent === current) return undefined;
      current = parent;
      continue;
    }
    let resolved: string | undefined;
    try {
      resolved = realpathSync(current);
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined) return isInside(real, resolved, posix) ? undefined : { link: current, target: resolved };
    // A link to a missing file: where it points decides.
    if (!stats.isSymbolicLink()) return undefined;
    let next: string;
    try {
      next = posix.resolve(posix.dirname(current), readlinkSync(current));
    } catch {
      return undefined;
    }
    if (!inside(next)) return { link: current, target: next };
    current = next;
    links += 1;
  }
  return { link: path, target: current };
}
