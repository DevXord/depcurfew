// The user file an installed tool reads (decision D-101): by the tool's version and, where a library the tool calls
// decides its directories (platformdirs for Poetry and PDM on macOS), by that library's version read from its
// .dist-info. When the library's version cannot be read, the file is the one the docs name, and `uncertainUserFile`
// says which other files the tool may read instead.
import type { Version } from '../apply/version.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { ToolKnowledge, UserFile } from '../knowledge/types.ts';
import { libraryVariants, locateUserFile, platformFamily, shownPath, userFileFor, type UserEnvironment } from './locate.ts';
import { libraryVersion, type InstalledVersion } from './versions.ts';

/** The library that decides the tool's user directories on this platform, if any. */
function deciding(tool: ToolKnowledge, environment: UserEnvironment): string | undefined {
  const fact = tool.user?.libraryDirectories;
  const library = fact === undefined ? undefined : evidenceOf(fact)[0]?.value;
  return library !== undefined && library.platforms.includes(platformFamily(environment.platform)) ? library.library : undefined;
}

/** The installed version of the library that decides the tool's user directories here; undefined when none does or it cannot be read. */
export function deciderVersion(tool: ToolKnowledge, environment: UserEnvironment): InstalledVersion | undefined {
  const library = deciding(tool, environment);
  return library === undefined ? undefined : libraryVersion(tool, library, environment);
}

/** The user file of the installed tool at `version` (the latest known when undefined). */
export function installedUserFile(tool: ToolKnowledge, version: Version | undefined, environment: UserEnvironment): UserFile | null {
  return userFileFor(tool, version, deciderVersion(tool, environment)?.version);
}

export interface UncertainUserFile {
  library: string;
  /** The file used, where the docs say, as messages show it. */
  shown: string;
  /** Each file the tool may read here, as messages show it, with the library versions that make it read it. */
  candidates: { shown: string; ranges: string[] }[];
  /** The environment variables, set here, that move the file for some versions of the library. */
  variables: string[];
}

/** A user file as messages show it: ~/..., or relative to the directory each command runs in. */
function shownFile(file: UserFile, environment: UserEnvironment): string | undefined {
  const located = locateUserFile(file, environment);
  if (located === undefined) return undefined;
  return 'relative' in located ? `${located.relative.file} relative to the directory each command runs in` : shownPath(located.path, environment);
}

/**
 * When a library decides the user directories here, its version cannot be read, and its versions would put the file
 * in different places in this environment: the file used and the others. Undefined when it makes no difference.
 */
export function uncertainUserFile(tool: ToolKnowledge, version: Version | undefined, environment: UserEnvironment): UncertainUserFile | undefined {
  const library = deciding(tool, environment);
  if (library === undefined || libraryVersion(tool, library, environment) !== undefined) return undefined;
  const file = userFileFor(tool, version);
  const shown = file === null ? undefined : shownFile(file, environment);
  if (shown === undefined) return undefined;
  // Neighbouring ranges that give the same file are one range.
  const spans: { shown: string; since: string; until?: string }[] = [];
  for (const variant of libraryVariants(tool, version)) {
    const where = shownFile(variant.file, environment);
    const last = spans.at(-1);
    if (where === undefined) continue;
    if (last?.shown === where && last.until === variant.since) {
      if (variant.until === undefined) delete last.until;
      else last.until = variant.until;
    } else spans.push({ shown: where, since: variant.since, ...(variant.until === undefined ? {} : { until: variant.until }) });
  }
  const candidates: { shown: string; ranges: string[] }[] = [];
  for (const span of spans) {
    const range = span.since === '0.0.0' ? (span.until === undefined ? 'every version' : `before ${span.until}`) : span.until === undefined ? `${span.since} and later` : `${span.since} to before ${span.until}`;
    const known = candidates.find((candidate) => candidate.shown === span.shown);
    if (known === undefined) candidates.push({ shown: span.shown, ranges: [range] });
    else known.ranges.push(range);
  }
  if (candidates.length < 2) return undefined;
  const fact = tool.user?.libraryDirectories;
  const directories = fact === undefined ? [] : (evidenceOf(fact)[0]?.value.directories ?? []).flatMap((entry) => entry.value);
  const variables = [...new Set(directories.flatMap((directory) => (directory.from === 'home' ? [] : [directory.from.env])))].filter((name) => (environment.env[name]?.trim() ?? '') !== '');
  return { library, shown, candidates, variables };
}

/** Every user file the tool may read at `version`: the one in use, and with an unknown library version each candidate. */
export function possibleUserFiles(tool: ToolKnowledge, version: Version | undefined, environment: UserEnvironment): UserFile[] {
  const file = installedUserFile(tool, version, environment);
  if (file === null) return [];
  const library = deciding(tool, environment);
  if (library === undefined || deciderVersion(tool, environment) !== undefined) return [file];
  return [file, ...libraryVariants(tool, version).map((variant) => variant.file)];
}
