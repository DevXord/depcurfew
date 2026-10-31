// SARIF for doctor --user. User files are not in a repository, so their locations are not relative to %SRCROOT%:
// a file below the home directory is relative to the base HOME, whose absolute path the log leaves out (it would show
// the account name); a file elsewhere has its absolute file: URI; an environment variable is a logical location.
import { posix, win32 } from 'node:path';
import { pathUri, toSarif } from '../doctor/sarif.ts';
import type { DoctorReport, Location } from '../doctor/types.ts';
import { readLimitedText } from '../read-limited.ts';
import { USER_RULES } from './doctor.ts';
import type { UserEnvironment } from './locate.ts';

const MAX_FILE = 1024 * 1024;

/** The absolute path of a file as doctor --user shows it (~/.npmrc or an absolute path). */
function absolute(file: string, environment: UserEnvironment): string | undefined {
  const module = environment.platform === 'win32' ? win32 : posix;
  if (file.startsWith('~/')) return module.join(environment.home, ...file.slice(2).split('/'));
  return module.isAbsolute(file) ? file : undefined;
}

/** An absolute path as a file: URI (file:///C:/Users/... on Windows). */
function fileUri(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return `file://${pathUri(path)}`;
  const [drive = '', ...rest] = path.replaceAll('\\', '/').split('/');
  return `file:///${/^[A-Za-z]:$/u.test(drive) ? drive : encodeURIComponent(drive)}/${pathUri(rest.join('/'))}`;
}

export function toUserSarif(report: DoctorReport, version: string, environment: UserEnvironment): object {
  const lines = new Map<string, string[] | undefined>();
  const lineOf = (file: string, line: number): string | undefined => {
    if (!lines.has(file)) {
      const path = absolute(file, environment);
      lines.set(file, path === undefined ? undefined : readLimitedText(path, MAX_FILE)?.split(/\r?\n/u));
    }
    return lines.get(file)?.[line - 1];
  };
  const location = ({ file, line, variable }: Location): object => {
    if (variable !== undefined || file === 'environment') return { logicalLocations: [{ name: variable ?? file, kind: 'variable' }] };
    const artifactLocation = file.startsWith('~/') ? { uri: pathUri(file.slice(2)), uriBaseId: 'HOME' } : { uri: absolute(file, environment) === undefined ? pathUri(file) : fileUri(file, environment.platform) };
    // A finding about the whole file has no region; GitHub code scanning, which needs one, takes no user files.
    const region = line === undefined ? undefined : { startLine: line, startColumn: 1, endLine: line, endColumn: Math.max(lineOf(file, line)?.length ?? 0, 1) + 1 };
    return { physicalLocation: { artifactLocation, ...(region === undefined ? {} : { region }) } };
  };
  const sarif = toSarif(report, USER_RULES, version) as { runs: { results: { locations: object[] }[] }[] };
  const [run] = sarif.runs;
  if (run === undefined) return sarif;
  run.results.forEach((result, index) => {
    const finding = report.findings[index];
    if (finding !== undefined) result.locations = [location(finding.location)];
  });
  return {
    ...sarif,
    runs: [{ ...run, originalUriBaseIds: { HOME: { description: { text: 'The home directory of the user who ran depcurfew doctor --user; the log leaves its path out.' } } } }],
  };
}
