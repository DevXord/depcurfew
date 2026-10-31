// Helpers for the --user tests: they run on the real file system of the machine, so paths follow its platform and
// the expected user files are worked out from the knowledge base the way apply --user finds them.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Version } from '../../src/apply/version.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import { shownPath, userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { canSymlink } from './platform.ts';

/** The platform these tests run on, for environments that point at real temporary directories. */
export const platform = process.platform;

/** The absolute path of a tool's user file in an environment (for the version, or the latest known one). */
export function userFileOf(id: ToolId, environment: UserEnvironment, version?: Version): string {
  const tool = knowledgeBase.find((candidate) => candidate.id === id);
  const file = tool === undefined ? null : userFileFor(tool, version);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (path === undefined) throw new Error(`no user file for ${id}`);
  return path;
}

/** A tool's user file as apply --user shows it (~/.config/uv/uv.toml on Linux, ~/AppData/Roaming/uv/uv.toml on Windows). */
export function shownUserFile(id: ToolId, environment: UserEnvironment, version?: Version): string {
  return shownPath(userFileOf(id, environment, version), environment);
}

/** The user policy as messages show it. */
export function shownPolicy(environment: UserEnvironment): string {
  return shownPath(userPolicyPath(environment), environment);
}

/**
 * A temporary machine for --user tests: a home directory and a PATH with tools installed from npm (a package.json
 * with `bin` next to the executable, linked from PATH where symlinks can be made) and from PyPI (a .dist-info in a
 * virtual environment), name → version. The root directory is added to `cleanup`, which the test file removes.
 */
export function fakeMachine(installed: { npm?: Record<string, string>; python?: Record<string, string> }, cleanup: string[]): UserEnvironment & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-machine-'));
  cleanup.push(root);
  const home = join(root, 'home');
  const prefix = join(root, 'prefix');
  const venv = join(root, 'venv');
  for (const directory of [home, join(prefix, 'bin'), join(venv, 'bin')]) mkdirSync(directory, { recursive: true });
  for (const [name, version] of Object.entries(installed.npm ?? {})) {
    const pkg = join(prefix, 'lib', 'node_modules', name);
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version, bin: { [name]: `bin/${name}.js` } }));
    writeFileSync(join(pkg, 'bin', `${name}.js`), '');
    if (canSymlink()) symlinkSync(join(pkg, 'bin', `${name}.js`), join(prefix, 'bin', name));
    else writeFileSync(join(prefix, 'bin', name), '');
  }
  for (const [name, version] of Object.entries(installed.python ?? {})) {
    const info = join(venv, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`);
    writeFileSync(join(info, 'entry_points.txt'), `[console_scripts]\n${name} = ${name}.__main__:main\n`);
    writeFileSync(join(venv, 'bin', name), '#!/usr/bin/python3\n');
  }
  return { root, platform, home, env: { PATH: [join(prefix, 'bin'), join(venv, 'bin')].join(delimiter) } };
}
