// The user environment of this process: platform, home directory and environment variables.
import { homedir } from 'node:os';
import type { UserEnvironment } from './locate.ts';

export function currentEnvironment(): UserEnvironment {
  return { platform: process.platform, home: homedir(), env: process.env };
}
