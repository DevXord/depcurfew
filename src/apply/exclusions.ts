// Cooldown exceptions a repository already sets in the tools' own files (decision D-167): npm's
// min-release-age-exclude, pnpm's minimumReleaseAgeExclude, Yarn's npmPreapprovedPackages, Bun's
// minimumReleaseAgeExcludes, Deno's minimumDependencyAge.exclude, uv's exclude-newer-package and PDM's
// exclude-newer-override (the packages set to false), Poetry's min-release-age-exclude and Dependabot's cooldown.exclude.
// init carries them into cooldown.exclude, and apply warns when it drops one it did not write. Composer keeps the entries
// apply did not write (decision D-134), and Renovate has no list of its own, so they are not read here.
import { yamlOptionsFor, extraOf, isRecord, settingOf, values } from './facts.ts';
import { managedValue, PlannedRepository } from './delays.ts';
import { botOnlyEntries, isActionsEcosystem } from './generators/dependabot.ts';
import { listing } from './requirements.ts';
import { pinnedVersion } from './version.ts';
import { pythonSettingPaths, readPythonSetting } from '../doctor/python.ts';
import { rejectsYamlAliases, yamlAliasLine, yamlSetting } from '../doctor/settings.ts';
import { Repository } from '../detect/repository.ts';
import type { Detection, PackageManagerInfo } from '../detect/types.ts';
import { latestVersion } from '../doctor/effective.ts';
import { readToolSetting, settingOwner } from '../doctor/pnpm-config.ts';
import type { Ecosystem, ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { COMPOSER_PREFIX, PYPI_PREFIX, validatePackagePattern } from '../policy/package-pattern.ts';
import type { ApplyWarning } from './warnings.ts';
import type { FileChange } from './workspace.ts';

/** One exception list of a tool, as the repository sets it. */
export interface ConfiguredExclusion {
  tool: ToolId;
  /** '' for one per tool, the updates entry (updates[2]) for Dependabot. */
  scope: string;
  /** What the list covers, for messages, e.g. "npm updates". */
  label?: string;
  /** The setting as the file names it. */
  setting: string;
  location: { file: string; line: number };
  /** The entries as written, each with the pattern depcurfew.json names it by, when it can. */
  entries: { written: string; policy: string | undefined }[];
  /** Written by depcurfew: inside its managed block or under its YAML marker. */
  managed: boolean;
}

const PREFIXES: Readonly<Partial<Record<Ecosystem, string>>> = { pypi: PYPI_PREFIX, packagist: COMPOSER_PREFIX };

/** The pattern depcurfew.json writes for a package of the registry, or undefined when it cannot hold it. */
function policyPattern(name: string, ecosystem: Ecosystem): string | undefined {
  if (ecosystem === 'rubygems') return undefined;
  const pattern = `${PREFIXES[ecosystem] ?? ''}${name}`;
  return validatePackagePattern(pattern) === undefined ? pattern : undefined;
}

/** The names a list or table of exceptions holds: strings of a list, keys set to the tool's exempt value of a table. */
function namesOf(tool: ToolKnowledge, value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (!isRecord(value)) return undefined;
  const exempt = tool.extra?.['excludeValue'] === undefined ? undefined : values(tool.extra['excludeValue'])[0];
  return exempt === undefined ? undefined : Object.keys(value).filter((key) => value[key] === exempt);
}

function managerExclusion(repository: Repository, tool: ToolKnowledge, manager: PackageManagerInfo): ConfiguredExclusion | undefined {
  const { configFiles } = manager;
  const setting = settingOf(tool.cooldown.exclude.setting);
  const ecosystem = ecosystemOfTool(tool);
  if (setting === null || ecosystem === 'packagist' || ecosystem === 'rubygems') return undefined;
  // A file that does not name the setting holds no list: it is not parsed (a pyproject.toml of half a MiB takes a
  // tenth of a second).
  const key = setting.split('.').at(-1) ?? setting;
  const mentions = (file: string) => repository.readText(file)?.includes(key) === true;
  let found;
  if (ecosystem === 'pypi') found = pythonSettingPaths(repository, tool, setting).some(({ file }) => mentions(file)) ? readPythonSetting(repository, tool, setting) : undefined;
  else {
    // deno.json or deno.jsonc, as the generator picks it; the first configuration file of the others.
    const manifests = tool.id === 'deno' && tool.project !== undefined ? (values(tool.project.manifests)[0] ?? []) : [];
    const file = tool.id === 'deno' ? (manifests.find((name) => repository.isFile(name)) ?? configFiles.find((name) => /^deno\.jsonc?$/u.test(name))) : values(tool.cooldown.configFiles)[0]?.[0];
    // pnpm 12.15+ takes the list from the file include in pnpm-workspace.yaml gives it to, as the generator writes it
    // there (decision D-194); a config dependency or a file outside the directory holds none depcurfew reads.
    const version = pinnedVersion(manager) ?? latestVersion(tool);
    const owner = file === undefined ? undefined : settingOwner(repository, tool, version, file, setting);
    found = owner?.kind !== 'file' || file === undefined || !mentions(owner.file) ? undefined : readToolSetting(repository, tool, version, file, setting);
  }
  if (found === undefined) return undefined;
  const names = namesOf(tool, found.value);
  if (names === undefined || names.length === 0) return undefined;
  // Deno names npm packages npm:<name>; a jsr: entry is none depcurfew.json can name.
  const prefix = tool.extra?.['npmSpecifierPrefix'] === undefined ? undefined : extraOf(tool, 'npmSpecifierPrefix', (value): value is string => typeof value === 'string');
  const entries = names.map((written) => {
    const name = prefix === undefined ? written : written.startsWith(prefix) ? written.slice(prefix.length) : undefined;
    return { written, policy: name === undefined ? undefined : policyPattern(name, ecosystem) };
  });
  return {
    tool: tool.id,
    scope: '',
    setting,
    location: { file: found.file, line: found.line },
    entries,
    managed: managedValue(repository.readText(found.file), found.file, setting.split('.'), found.line),
  };
}

function dependabotExclusions(repository: Repository, bot: ToolKnowledge, file: string, tools: readonly ToolKnowledge[]): ConfiguredExclusion[] {
  const text = repository.readText(file);
  // Dependabot does not read a file with YAML aliases (extra.yamlAliases).
  // A file without the key holds no list and is not parsed.
  if (text === undefined || !text.includes('exclude') || (rejectsYamlAliases(bot) && yamlAliasLine(text) !== undefined)) return [];
  const yaml = yamlOptionsFor(file, [bot]);
  const updates = yamlSetting(text, ['updates'], yaml);
  if (updates === undefined || !Array.isArray(updates.value)) return [];
  const ecosystems = extraOf(bot, 'ecosystems', isRecord);
  const actions = bot.extra?.['githubActions'] === undefined ? undefined : extraOf(bot, 'githubActions', isActionsEcosystem).ecosystem;
  const botOnly = botOnlyEntries(bot);
  return (updates.value as unknown[]).flatMap((entry, index): ConfiguredExclusion[] => {
    if (!isRecord(entry) || !isRecord(entry['cooldown'])) return [];
    const name = String(entry['package-ecosystem']);
    const managers = ecosystems[name];
    // The entries of actions, of the ecosystems updated by bots only and of Ruby gems keep their own list (decision D-152).
    if (name === actions || botOnly.has(name) || !Array.isArray(managers)) return [];
    const tool = tools.find((item) => managers.includes(item.id));
    const ecosystem = tool === undefined ? 'npm' : ecosystemOfTool(tool);
    const list = entry['cooldown']['exclude'];
    if (ecosystem === 'rubygems' || !Array.isArray(list) || list.length === 0) return [];
    const path = ['updates', String(index), 'cooldown', 'exclude'];
    const found = yamlSetting(text, path, yaml);
    return [
      {
        tool: bot.id,
        scope: `updates[${index}]`,
        label: `${name} updates`,
        setting: 'cooldown.exclude',
        location: { file, line: found?.line ?? updates.line },
        entries: list.filter((item): item is string => typeof item === 'string').map((written) => ({ written, policy: policyPattern(written, ecosystem) })),
        managed: managedValue(text, file, path, found?.line ?? updates.line),
      },
    ];
  });
}

/** The exception lists the repository sets for the detected tools (only those in `only`, when given). */
export function configuredExclusions(repository: Repository, detection: Detection, tools: readonly ToolKnowledge[], only?: ReadonlySet<ToolId>): ConfiguredExclusion[] {
  const found: ConfiguredExclusion[] = [];
  const read = <T>(action: () => T, none: T): T => {
    try {
      return action();
    } catch {
      // A file that cannot be read is reported by the edit of that file, or by doctor.
      return none;
    }
  };
  for (const manager of detection.packageManagers) {
    const tool = tools.find((entry) => entry.id === manager.id);
    if (!manager.supported || tool === undefined || (only !== undefined && !only.has(tool.id))) continue;
    const exclusion = read(() => managerExclusion(repository, tool, manager), undefined);
    if (exclusion !== undefined) found.push(exclusion);
  }
  for (const detected of detection.bots) {
    const bot = tools.find((entry) => entry.id === detected.id);
    const file = detected.configFiles[0];
    if (bot?.id !== 'dependabot' || file === undefined || (only !== undefined && !only.has(bot.id))) continue;
    found.push(...read(() => dependabotExclusions(repository, bot, file, tools), []));
  }
  return found;
}

/**
 * exclusion-dropped (decision D-167): an exception set outside depcurfew's markers that the planned change removes,
 * because cooldown.exclude does not name it. The fix names the patterns that keep it.
 */
export function droppedExclusions(root: string, changes: readonly FileChange[], detection: Detection, tools: readonly ToolKnowledge[], targets: ReadonlySet<ToolId>): ApplyWarning[] {
  if (changes.length === 0) return [];
  const before = configuredExclusions(new Repository(root), detection, tools, targets).filter((exclusion) => !exclusion.managed);
  if (before.length === 0) return [];
  const after = configuredExclusions(new PlannedRepository(root, changes), detection, tools, targets);
  return before.flatMap((old): ApplyWarning[] => {
    const now = after.find((exclusion) => exclusion.tool === old.tool && exclusion.scope === old.scope);
    const kept = new Set(now?.entries.map((entry) => entry.written) ?? []);
    const dropped = old.entries.filter((entry) => !kept.has(entry.written));
    if (dropped.length === 0) return [];
    const name = tools.find((tool) => tool.id === old.tool)?.name ?? old.tool;
    const one = dropped.length === 1;
    const json = /\.jsonc?$/u.test(old.location.file);
    const action = json ? `removes ${one ? 'it' : 'them'}` : `comments ${one ? 'it' : 'them'} out`;
    const patterns = dropped.map((entry) => entry.policy).filter((pattern): pattern is string => pattern !== undefined);
    const unnamed = dropped.filter((entry) => entry.policy === undefined).map((entry) => entry.written);
    const keep =
      patterns.length > 0
        ? `To keep the ${patterns.length === 1 ? 'exception' : 'exceptions'}, add ${listing(patterns.map((pattern) => JSON.stringify(pattern)))} to cooldown.exclude in ${POLICY_FILE} and run depcurfew apply again`
        : `${POLICY_FILE} cannot name ${listing(unnamed)}, so depcurfew apply cannot keep ${unnamed.length === 1 ? 'it' : 'them'}; remove "${old.tool}" from targets in ${POLICY_FILE} if ${name} must keep the list as it is`;
    return [
      {
        code: 'exclusion-dropped',
        tool: old.tool,
        location: { ...old.location },
        message: `${name}: ${old.setting} in ${old.location.file} (line ${old.location.line})${old.label === undefined ? '' : ` for ${old.label}`} exempts ${listing(dropped.map((entry) => entry.written))} from the release-age delay, but cooldown.exclude in ${POLICY_FILE} does not; depcurfew apply ${action}, so ${name} delays ${one ? 'it' : 'them'} like every other package`,
        fix: `${keep}${json ? `; if an earlier depcurfew apply wrote ${one ? 'it' : 'them'} to ${old.location.file} and you removed ${one ? 'it' : 'them'} from cooldown.exclude on purpose, nothing to do` : ''}`,
      },
    ];
  });
}
