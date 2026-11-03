// `depcurfew osv update [--ecosystem npm|pypi|packagist ...] [--accept-fewer] [--json]` (decisions D-150 and D-156):
// downloads the public export of OSV.dev for each ecosystem and writes the local data of known malicious packages to
// depcurfew's user cache directory. Exit code 0 when every ecosystem was updated, 1 when one could not be (its old data
// is kept), 2 for a usage error. A directory of the data that other users can write gives a warning, and the exit code
// stays as it is.
import { osvEcosystem } from '../check/osv.ts';
import { paint } from '../color.ts';
import { safeJson } from '../json-safe.ts';
import { OSV_DATA_ECOSYSTEMS, type OsvDataEcosystem } from '../osv/data.ts';
import { writeProblemFix, writeProblemMessage } from '../osv/notices.ts';
import { updateOsvData, type OsvUpdateCode, type OsvUpdateResult } from '../osv/update.ts';
import { printable } from '../printable.ts';
import { cacheWriteProblem, osvDataDirectories } from '../user/cache-path.ts';
import { currentEnvironment } from '../user/environment.ts';
import type { CheckDependencies } from './check.ts';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.ts';

export interface OsvUpdateFlags {
  /** The ecosystems given with --ecosystem, already checked by parseEcosystems; all when empty. */
  ecosystems: readonly OsvDataEcosystem[];
  json: boolean;
  /** --accept-fewer: replace the data also with an export that has fewer than half of its records (decision D-156). */
  acceptFewer?: boolean;
}

/** The ecosystems of --ecosystem (each once, in the order of OSV_DATA_ECOSYSTEMS), or the usage error for one that is not one. */
export function parseEcosystems(given: readonly string[]): { ok: true; ecosystems: OsvDataEcosystem[] } | { ok: false; message: string } {
  const wanted = new Set<OsvDataEcosystem>();
  for (const name of given) {
    const known = OSV_DATA_ECOSYSTEMS.find((ecosystem) => ecosystem === name.toLowerCase());
    if (known === undefined) return { ok: false, message: `--ecosystem takes ${OSV_DATA_ECOSYSTEMS.join(', ')}, not '${printable(name.slice(0, 100))}'` };
    wanted.add(known);
  }
  return { ok: true, ecosystems: wanted.size === 0 ? [...OSV_DATA_ECOSYSTEMS] : OSV_DATA_ECOSYSTEMS.filter((ecosystem) => wanted.has(ecosystem)) };
}

interface OsvUpdateError {
  code: OsvUpdateCode;
  level: 'error';
  location: { file: string };
  /** The ecosystem whose data was not updated; absent when none was. */
  ecosystem?: OsvDataEcosystem;
  message: string;
  fix: string;
}

/** A directory of the data that other users can write (osv-cache-shared, decision D-156). */
interface OsvUpdateWarning {
  code: 'osv-cache-shared';
  level: 'warning';
  location: { file: string };
  message: string;
  fix: string;
}

/** The document of osv update --json. */
interface OsvUpdateDocument {
  schemaVersion: 1;
  /** The directory of the local data; null when there is none. */
  directory: string | null;
  ecosystems: Extract<OsvUpdateResult, { status: 'updated' }>[];
  errors: OsvUpdateError[];
  warnings: OsvUpdateWarning[];
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** One line per ecosystem updated: what it holds, from when, and where it is. */
function updatedLine(result: Extract<OsvUpdateResult, { status: 'updated' }>): string {
  const name = osvEcosystem(result.ecosystem) ?? result.ecosystem;
  const from = result.exportedAt === null ? 'the OSV.dev export' : `the OSV.dev export of ${result.exportedAt.slice(0, 16).replace('T', ' ')} UTC`;
  const left = [
    result.withdrawn > 0 ? `${count(result.withdrawn)} withdrawn` : '',
    result.skipped > 0 ? `${count(result.skipped)} without a version of a ${name} package` : '',
    result.tooLarge > 0 ? `${count(result.tooLarge)} larger than depcurfew keeps` : '',
  ].filter((part) => part !== '');
  const records = `${count(result.records)} ${result.records === 1 ? 'record' : 'records'} of known malicious packages`;
  return `${name}: ${records} from ${from}${left.length === 0 ? '' : ` (left out: ${left.join(', ')})`}, written to ${result.file}\n`;
}

export async function osvUpdate(flags: OsvUpdateFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  const environment = dependencies.userEnvironment?.() ?? currentEnvironment();
  // In the user cache directory, that directory and depcurfew's folders in it must not be writable by other users; a
  // directory the dependencies name is checked alone.
  const guarded = dependencies.osvData === undefined ? osvDataDirectories(environment) : [dependencies.osvData()].filter((entry) => entry !== undefined);
  const directory = guarded.at(-1);
  const errors: OsvUpdateError[] = [];
  const warnings: OsvUpdateWarning[] = [];
  const updated: Extract<OsvUpdateResult, { status: 'updated' }>[] = [];
  if (directory === undefined) {
    const variable = environment.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CACHE_HOME';
    errors.push({
      code: 'osv-cache-missing',
      level: 'error',
      location: { file: 'environment' },
      message: `depcurfew has no user cache directory for the OSV.dev data: the home directory ${JSON.stringify(environment.home)} is not an absolute path, and ${variable} names none`,
      fix: `Set ${variable} or ${environment.platform === 'win32' ? 'USERPROFILE' : 'HOME'} to an absolute path, then run depcurfew osv update again`,
    });
  } else {
    const results = await updateOsvData({ directory, ecosystems: flags.ecosystems, fetch: dependencies.fetch, now: dependencies.now, ...(flags.acceptFewer === true ? { acceptFewer: true } : {}) });
    for (const result of results) {
      if (result.status === 'updated') updated.push(result);
      else errors.push({ code: result.code, level: 'error', location: { file: result.file }, ecosystem: result.ecosystem, message: result.message, fix: result.fix });
    }
    // After the update, which creates the directories that were missing.
    const problem = cacheWriteProblem(guarded);
    if (problem !== undefined) warnings.push({ code: 'osv-cache-shared', level: 'warning', location: { file: problem.directory }, message: writeProblemMessage(problem), fix: writeProblemFix(problem) });
  }
  const code = errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
  if (flags.json) {
    const document: OsvUpdateDocument = { schemaVersion: 1, directory: directory ?? null, ecosystems: updated, errors, warnings };
    io.stdout(`${safeJson(document, 2)}\n`);
    return code;
  }
  for (const result of updated) io.stdout(updatedLine(result));
  const colors = paint(io.colors?.stderr);
  for (const error of errors) {
    io.stderr(`error: ${printable(error.message)} ${colors.dim(`(${error.code})`)}\n  ${colors.green('fix:')} ${printable(error.fix)}\n`);
  }
  for (const warning of warnings) {
    io.stderr(`${colors.yellow('warning:')} ${printable(warning.message)} ${colors.dim(`(${warning.code})`)}\n  ${colors.green('fix:')} ${printable(warning.fix)}\n`);
  }
  return code;
}
