// Reading a file that someone else can put in place (a user configuration file, a package.json next to an
// executable, the user policy): only a regular file, and never more than the limit, whatever size the file system
// reports. Opening a FIFO waits for a writer for ever, a device file has no end, and files under /proc report size 0
// but can hold far more than the limit, so the size from stat is only a first check.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export type LimitedRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; problem: 'missing' | 'not-a-file' | 'too-large' | 'symlink' }
  | { ok: false; problem: 'unreadable'; error: NodeJS.ErrnoException };

const CHUNK = 64 * 1024;

/**
 * The bytes of the regular file at `path`, at most `limit` of them. `noFollow` refuses a symlink in the last part of
 * the path where the platform can tell (O_NOFOLLOW), so that a file cannot be swapped for a link between a check and
 * the read.
 */
export function readLimited(path: string, limit: number, options: { noFollow?: boolean } = {}): LimitedRead {
  // O_NONBLOCK makes opening a FIFO return at once instead of waiting for a writer; Windows has neither flag.
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (options.noFollow === true ? (constants.O_NOFOLLOW ?? 0) : 0);
  let descriptor: number;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, problem: 'missing' };
    if (code === 'ELOOP' && options.noFollow === true) return { ok: false, problem: 'symlink' };
    if (code === 'EISDIR') return { ok: false, problem: 'not-a-file' };
    return { ok: false, problem: 'unreadable', error: error as NodeJS.ErrnoException };
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { ok: false, problem: 'not-a-file' };
    if (stats.size > limit) return { ok: false, problem: 'too-large' };
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(CHUNK, limit + 1));
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      total += read;
      if (total > limit) return { ok: false, problem: 'too-large' };
    }
    return { ok: true, bytes: Buffer.concat(chunks, total) };
  } catch (error) {
    return { ok: false, problem: 'unreadable', error: error as NodeJS.ErrnoException };
  } finally {
    closeSync(descriptor);
  }
}

/** The text of a regular file of at most `limit` bytes (UTF-8, invalid bytes replaced); undefined otherwise. */
export function readLimitedText(path: string, limit: number): string | undefined {
  const result = readLimited(path, limit);
  return result.ok ? result.bytes.toString('utf8') : undefined;
}
