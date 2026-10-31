// The user environment of this process: platform, home directory, environment variables and current directory.
import { homedir } from 'node:os';
import type { UserEnvironment } from './locate.ts';

export function currentEnvironment(): UserEnvironment {
  return { platform: process.platform, home: homedir(), env: process.env, cwd: process.cwd() };
}
