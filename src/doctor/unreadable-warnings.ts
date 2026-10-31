// What to do about a file depcurfew could not read, by the code of the repository warning: the fix of unreadable-config
// in doctor, and of the file-unreadable warning of apply.
import { MAX_LOCKFILE_SIZE, MAX_YAML_LOCKFILE_SIZE } from './lockfiles.ts';

/** Repository warnings that mean a file was not checked. */
export const UNREADABLE_WARNINGS: Readonly<Record<string, string>> = {
  'invalid-file': 'Fix the syntax error, so that depcurfew can check the file',
  'unreadable-file': 'Make the file readable for the user that runs depcurfew, so that depcurfew can check it',
  'file-too-large': 'Make the file smaller than the limit, or check its settings by hand',
  'lockfile-too-large': `Check where the packages in the lockfile come from and which have install scripts by hand; depcurfew reads YAML lockfiles up to ${MAX_YAML_LOCKFILE_SIZE / (1024 * 1024)} MiB and JSON lockfiles up to ${MAX_LOCKFILE_SIZE / (1024 * 1024)} MiB`,
  'outside-repository': 'Replace the symlink with a regular file inside the repository',
  'not-a-regular-file': 'Replace it with a regular file, or remove it; npm and pnpm read .npmrc as a file',
  'workspace-outside-repository': 'Keep workspace packages inside the repository',
  'unreadable-include': 'Keep the included files in the repository and refer to them by a relative path, so that depcurfew can check them',
};
