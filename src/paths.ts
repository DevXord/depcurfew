// Where a path lies relative to a repository, the same on Linux, macOS and Windows.
import nodePath from 'node:path';

type PathModule = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Whether `path` is `root` or inside it. path.relative also works for a root that ends with a separator (/, P:\ from
 * subst or a Dev Drive, \\nas\share\), where root + separator is not a prefix of the paths inside, and on Windows it
 * ignores the case of the drive and the names, as the file system does. `paths` is node:path, or its win32 or posix
 * flavor in tests.
 */
export function isInside(root: string, path: string, paths: PathModule = nodePath): boolean {
  const part = paths.relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${paths.sep}`) && !paths.isAbsolute(part));
}

/**
 * Whether a path written in a file, with / or \, is absolute on some system and so never inside the repository:
 * /x, \x, \\server\share\x, and a Windows drive (C:\x, C:/x, or C:x relative to the drive's current directory).
 */
export function isAbsoluteAnywhere(path: string): boolean {
  return /^[\\/]/u.test(path) || /^[A-Za-z]:/u.test(path);
}
