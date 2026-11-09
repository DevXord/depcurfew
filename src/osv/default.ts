// The local OSV.dev data of depcurfew's user cache directory (decision D-150), as depcurfew check, the hook,
// depcurfew mcp and doctor read it, for programs that look versions up themselves (decision D-183): that directory and
// depcurfew's folders in it are guarded against other users (decision D-156), and a program learns nothing was
// downloaded without reading the data.
import { statSync } from 'node:fs';
import { osvDataDirectories, type CacheEnvironment } from '../user/cache-path.ts';
import { currentEnvironment } from '../user/environment.ts';
import { LocalOsvData, OSV_DATA_ECOSYSTEMS, osvDataFile } from './data.ts';

/** The local data of the user cache directory of `environment`, which depcurfew osv update writes. */
export function userOsvData(environment: CacheEnvironment): LocalOsvData {
  const directories = osvDataDirectories(environment);
  return new LocalOsvData(directories.at(-1), { guarded: directories });
}

/** Whether the file of any ecosystem is there, readable or not (what LocalOsvData.any() reads, without loading the files). */
function anyDataFile(directory: string): boolean {
  return OSV_DATA_ECOSYSTEMS.some((ecosystem) => {
    try {
      return statSync(osvDataFile(directory, ecosystem), { throwIfNoEntry: false }) !== undefined;
    } catch {
      // It exists, but cannot be looked at: the lookups say why.
      return true;
    }
  });
}

/**
 * The LocalOsvData of depcurfew's commands: the data depcurfew osv update wrote to the user cache directory of this
 * process's environment, or undefined when there is no user cache directory or nothing was downloaded. Check its
 * writeProblem(): other users who can write a directory of the data can change what the lookups find.
 */
export function defaultOsvData(): LocalOsvData | undefined {
  const data = userOsvData(currentEnvironment());
  return data.directory !== undefined && anyDataFile(data.directory) ? data : undefined;
}
