// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one, up to the root of the repository), else the default policy of
// `depcurfew init`. Packages are looked up in the registry given with --registry, else the one the user's .npmrc or
// the project's .npmrc sets (the .npmrc npm reads there, when it belongs to the policy: decision D-113), else the
// public npm registry; pypi: packages in the index given with --index, else PyPI. Exit code 1 when any package breaks
// the policy or cannot be checked, 2 for a usage error such as a --dir that does not exist; in hook mode the decision
// goes to stdout as JSON and the exit code is 0.
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { UserEnvironment } from '../user/locate.ts';
import type { McpProcess } from './mcp.ts';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { checkSpecs, type CheckFinding, type CheckRequest, type PackageReport } from '../check/index.ts';
import { parseRange, parseSemver } from '../check/semver.ts';
import { parseSpec } from '../check/spec.ts';
import { isPythonSpec } from '../check/python.ts';
import { blockingExitCode, decide, formatDecision, hookEventExample, readHookEvent, reasonText, requestedSpecs, UNREAD_REGISTRY_FIX_START, type PlacedRequest } from '../check/hook.ts';
import { missingDirectory, notVirtualEnvironment, overrideDoubt, TOO_MANY, unknownDirectory, type CommandDirectory, type Override } from '../check/command.ts';
import { defaultRegistry, type FetchLike, isLinkLocal, type LookupCache } from '../check/registry.ts';
import { defaultIndex } from '../check/pypi.ts';
import { hasRegistrySettings, MAX_CONFIG_SIZE, npmrcSettings, sameRegistry, toolRegistrySettings, type NpmrcSettings, type SkippedFile, type UnreadSetting, type WrittenSetting } from '../check/registry-settings.ts';
import { quoted } from '../check/findings.ts';
import { PopularNames } from '../check/similar.ts';
import { values } from '../apply/facts.ts';
import type { ToolId } from '../knowledge/types.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { popularPythonPackages } from '../knowledge/popular-python.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { PYPI_PREFIX } from '../policy/package-pattern.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { findPolicyDirectory } from '../policy/file.ts';
import { environment } from '../knowledge/environment.ts';
import { isInside } from '../paths.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePolicy } from '../policy/validate.ts';
import { paint, type Paint } from '../color.ts';
import { printable, withoutCredentials } from '../printable.ts';
import { safeJson } from '../json-safe.ts';
import { checkDirectory, policyInputError, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export const HOOKS = ['claude-code'] as const;

export interface CheckDependencies {
  fetch: FetchLike;
  now: () => Date;
  /** The whole of stdin, for hook mode. */
  stdin: () => Promise<string>;
  /** The user's home directory, with the user's .npmrc. */
  home?: () => string;
  /** The project root Claude Code gives hooks (CLAUDE_PROJECT_DIR); tests replace it. */
  projectDir?: () => string | undefined;
  /** --user: platform, home directory and environment variables (tests replace them). */
  userEnvironment?: () => UserEnvironment;
  /** depcurfew mcp: the streams the server talks over, its environment and signals (tests replace them). */
  mcpProcess?: () => McpProcess;
}

export interface CheckFlags {
  json: boolean;
  registry: string | undefined;
  /** The Python package index for pypi: packages. */
  index?: string | undefined;
  dir: string | undefined;
  hook: string | undefined;
}

function defaultPolicy(): ResolvedPolicy {
  const result = parsePolicy(renderPolicy(DEFAULT_POLICY));
  if (!result.ok) throw new Error('the default policy is invalid');
  return result.policy;
}

/** The npm registry packages are looked up in, where it comes from (undefined for the public registry), and the file and line that set it. */
interface UsedRegistry {
  url: string;
  where: string | undefined;
  file?: string;
  line?: number;
}

/** The npm registry to ask and where it comes from; `where` is undefined for the public registry. */
function registryOf(given: string | undefined, registries: Pick<NpmrcSettings, 'registry'>): UsedRegistry {
  const url = given === undefined ? (registries.registry?.value ?? defaultRegistry()) : withoutCredentials(given);
  const normalized = (text: string) => text.replace(/\/+$/u, '').toLowerCase();
  if (normalized(url) === normalized(defaultRegistry())) return { url, where: undefined };
  if (given !== undefined) return { url, where: '--registry' };
  const setting = registries.registry;
  const location = setting?.file === undefined ? {} : { file: setting.file, ...(setting.line === undefined ? {} : { line: setting.line }) };
  return { url, where: setting?.where ?? 'the configuration', ...location };
}

/** Whether a registry is at a link-local address, which depcurfew never asks (fetchSameOrigin). */
function linkLocalRegistry(registry: UsedRegistry): boolean {
  try {
    return isLinkLocal(new URL(registry.url).hostname);
  } catch {
    // An invalid URL is reported by the lookup itself.
    return false;
  }
}

/**
 * What to say about a registry other than the public one: a malicious .npmrc could name any. After a check it says
 * where packages were looked up; for explain_policy of depcurfew mcp, where check_packages looks them up.
 */
function registryNote(registry: UsedRegistry, when: 'checked' | 'explained' = 'checked'): string | undefined {
  if (registry.where === undefined) return undefined;
  // A link-local registry is not asked at all (fetchSameOrigin), so the packages were not looked up there.
  const linkLocal = linkLocalRegistry(registry);
  if (when === 'explained') {
    return linkLocal
      ? `check_packages would look npm packages up in ${registry.url} (${registry.where}), which depcurfew does not ask`
      : `check_packages looks npm packages up in ${registry.url} (${registry.where}), not in the public npm registry`;
  }
  return linkLocal
    ? `npm packages would be looked up in ${registry.url} (${registry.where}), which depcurfew does not ask`
    : `npm packages were looked up in ${registry.url} (${registry.where}), not in the public npm registry`;
}

/** A path as the JSON of every command gives it: relative to the directory the command works on, with / separators. */
function shownPath(start: string, file: string): string {
  return relative(start, file).split(sep).join('/');
}

function render(reports: readonly PackageReport[], colors: Paint): string {
  const lines: string[] = [];
  for (const report of reports) {
    // Python versions are written name==version, as pip takes them.
    // Names, versions, deprecation messages and scripts come from the registry: control characters are shown as text.
    const label = printable(report.version === undefined || report.name === undefined ? report.spec : `${report.name}${isPythonSpec(report.spec) ? '==' : '@'}${report.version}`);
    if (report.findings.length === 0) {
      lines.push(`${colors.bold(label)}: ${colors.green('ok')}${report.publishedAt === undefined ? '' : ` (published ${printable(report.publishedAt.slice(0, 10))})`}`);
      continue;
    }
    lines.push(`${colors.bold(label)}:`);
    for (const finding of report.findings) {
      const level = finding.level === 'error' ? colors.bold(colors.red('error:')) : colors.yellow('warning:');
      lines.push(`  ${level} ${printable(finding.message)}`, `    ${colors.green('fix:')} ${printable(finding.fix)}`);
    }
  }
  const errors = reports.filter((report) => report.findings.some((finding) => finding.level === 'error')).length;
  const warnings = reports.filter((report) => report.findings.some((finding) => finding.level === 'warning')).length;
  lines.push('', `${reports.length} ${reports.length === 1 ? 'package' : 'packages'}: ${errors} with errors, ${warnings} with warnings`);
  return `${lines.join('\n')}\n`;
}

/** Popular Python projects by normalized name, so that names differing only in case or separators are the same. */
function popularPython(): PopularNames {
  return new PopularNames((values(popularPythonPackages)[0] ?? []).map(normalizePythonName));
}

function messageOf(error: unknown): string {
  if (error instanceof PolicyError) return [error.text, ...error.issues].join('; ');
  return error instanceof Error ? error.message : String(error);
}

/** The code of the error for a hook event that cannot be read (decision D-119). */
const HOOK_EVENT_UNREADABLE = 'hook-event-unreadable';

/**
 * What to do about a hook event that cannot be read: what Claude Code sends, and how to run the hook. The field names
 * and the example come from the knowledge base (environment.claudeCode.hooks); 1 MiB is depcurfew's own limit.
 */
function unreadableEventFix(): string {
  const { fields, event, example } = hookEventExample();
  return `Claude Code sends the ${event} event as one JSON object on stdin, at most 1 MiB, with ${fields.event}, ${fields.tool}, ${fields.command} and ${fields.cwd}: run depcurfew check --hook claude-code as a ${event} command hook (see the README), or pipe such an event into it to try it, e.g. ${example}`;
}

/** The variable Claude Code sets for hooks to the project root, from the knowledge base. */
function projectDirVariable(): string {
  return values(environment.claudeCode.sessionStart)[0]?.projectDirVariable ?? 'CLAUDE_PROJECT_DIR';
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Where the policies for packages installed in `cwd` come from, when the project directory is known (the hook's
 * CLAUDE_PROJECT_DIR, the project directory of depcurfew mcp): decisions D-108, D-110 and D-113. When `cwd` lies in
 * the project (by real paths) and the lookup from the project directory finds a depcurfew.json, that policy applies,
 * and a different policy nearer `cwd` (`also`) is applied too: the stricter answer counts, so a planted policy cannot
 * relax the check and a nested one still tightens it, whether or not the project is in a git repository. When the
 * project directory has no policy, the nearest one from `cwd` applies alone, as in 1.2.0 and in check --dir. `project`
 * is the real project directory when `cwd` lies in it.
 */
export function hookPolicyStart(cwd: string, projectDir: string | undefined): { start: string; also?: string; project?: string } {
  if (projectDir === undefined || projectDir === '' || !isAbsolute(projectDir)) return { start: cwd };
  const project = realPathOf(projectDir);
  const here = realPathOf(cwd);
  if (!isInside(project, here)) return { start: cwd };
  const own = findPolicyDirectory(project);
  if (own === undefined) return { start: cwd, project };
  const nearest = findPolicyDirectory(here);
  return nearest === undefined || nearest === own ? { start: project, project } : { start: project, also: nearest, project };
}

/** The policy that applies to a directory: its depcurfew.json (null when there is none, which means the default policy). */
export interface AppliedPolicy {
  policy: ResolvedPolicy;
  /** The depcurfew.json used, relative to the directory paths are shown from; null for the default policy of depcurfew init. */
  file: string | null;
  /** A different depcurfew.json nearer the directory, applied too: the stricter answer counts. */
  nearer?: { policy: ResolvedPolicy; file: string };
  /** The npm registry packages are looked up in, and where it comes from (undefined for the public registry). */
  registry: UsedRegistry;
  /** The Python package index pypi: packages are looked up in. */
  index: string;
  /** Registries .npmrc assigns to scopes, whose packages are not looked up. */
  scopes: ReadonlyMap<string, string>;
  /** The dist-tag .npmrc makes npm prefer. */
  tag: WrittenSetting | undefined;
  /** Registry settings npm reads there that depcurfew does not take: the packages they apply to are not vouched for. */
  unread: readonly UnreadSetting[];
  /** Configuration files that were not read. */
  skipped: readonly SkippedFile[];
  /** Where packages are installed, and the highest directory whose configuration files count for them. */
  start: string;
  top: string;
}

/** Where packages are looked up, which does not depend on the policy: the registry, the index, scopes and the dist-tag. */
export type Lookups = Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag' | 'unread' | 'skipped'>;

/** The policy that applies, or why it cannot be used; `lookups` either way, as .npmrc and the options set them. */
export type AppliedPolicyResult = { ok: true; applied: AppliedPolicy } | { ok: false; file: string; error: InputError; cause: PolicyError; nearer: boolean; lookups: Lookups };

export interface PolicySettings {
  registry: string | undefined;
  index?: string | undefined;
  home: string;
  /** The project directory (CLAUDE_PROJECT_DIR of the hook, the project directory of depcurfew mcp), absolute. */
  project?: string | undefined;
  /** The directory the paths of the result are relative to; `start` when left out. */
  base?: string;
  /**
   * The hook, for an install in another directory than its working directory (decision D-118): where the policies come
   * from, in place of hookPolicyStart, while .npmrc and the other configuration files are those of `start`.
   */
  root?: { start: string; also?: string; project?: string } | undefined;
  /** npm --prefix: npm's local prefix as given, whose .npmrc npm reads (decision D-118). */
  npmPrefix?: string | undefined;
}

/**
 * The policies, registry and index check uses for packages installed in `start`, an existing directory: the nearest
 * depcurfew.json from `start`, or with `project` the policies of hookPolicyStart. The .npmrc of npm's local prefix
 * counts only when it is the directory of the policy or one of its projects (without a policy: the project directory,
 * else `start`); see src/check/registry-settings.ts.
 */
export function appliedPolicy(start: string, settings: PolicySettings): AppliedPolicyResult {
  const root = settings.root ?? (settings.project === undefined ? { start } : hookPolicyStart(start, settings.project));
  const base = settings.base ?? start;
  const directory = findPolicyDirectory(root.start);
  const file = directory === undefined ? undefined : shownPath(base, join(directory, POLICY_FILE));
  let policy: ResolvedPolicy | undefined;
  let failure: { cause: PolicyError; file: string; nearer: boolean } | undefined;
  try {
    policy = directory === undefined ? undefined : loadPolicyIfPresent(directory);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    failure = { cause: error, file: file ?? POLICY_FILE, nearer: false };
  }
  const anchor = root.project ?? resolve(start);
  const trusted = directory === undefined ? [anchor] : [directory, ...(policy?.projects ?? []).map((project) => join(directory, project))];
  const top = root.project ?? directory ?? resolve(start);
  const npmrc = npmrcSettings(start, { trusted, home: settings.home, base, prefix: settings.npmPrefix });
  const lookups: Lookups = {
    registry: registryOf(settings.registry, npmrc),
    index: settings.index === undefined ? defaultIndex() : withoutCredentials(settings.index),
    scopes: npmrc.scopes,
    tag: npmrc.tag,
    unread: npmrc.unread,
    skipped: npmrc.skipped,
  };
  let nearer: AppliedPolicy['nearer'];
  if (failure === undefined && root.also !== undefined) {
    const nearerFile = shownPath(base, join(root.also, POLICY_FILE));
    try {
      const own = loadPolicyIfPresent(root.also);
      if (own !== undefined) nearer = { policy: own, file: nearerFile };
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      failure = { cause: error, file: nearerFile, nearer: true };
    }
  }
  if (failure !== undefined) return { ok: false, file: failure.file, error: policyInputError(failure.cause, failure.file), cause: failure.cause, nearer: failure.nearer, lookups };
  return { ok: true, applied: { policy: policy ?? defaultPolicy(), file: file ?? null, ...(nearer === undefined ? {} : { nearer }), ...lookups, start: resolve(start), top } };
}

/** How serious a finding is, for comparing the findings of two policies. */
function severity(finding: CheckFinding): number {
  return finding.level === 'error' ? 2 : 1;
}

/** The longest release-age delay of some policies, in minutes (0 without one). */
function delayOf(policies: readonly ResolvedPolicy[]): number {
  return Math.max(0, ...policies.map((policy) => policy.cooldown?.minimum.minutes ?? 0));
}

/** The policies an applied lookup checks with: its own and the nearer one. */
function policiesOf(applied: AppliedPolicy): ResolvedPolicy[] {
  return applied.nearer === undefined ? [applied.policy] : [applied.policy, applied.nearer.policy];
}

/**
 * The reports of the project's policy with the findings of the nearer policy that add something (decision D-113): a
 * nearer finding is left out only when the project's report of the same package has the same code at the same or a
 * more severe level, and a project finding gives way to a more severe nearer one of the same code. Of two release-age
 * findings (too-young), the one of the longer delay stays, so that its fix says how long to wait. Nearer findings name
 * the file whose policy they break.
 */
function mergedReports(own: readonly PackageReport[], other: readonly PackageReport[] | undefined, nearerFile: string, delays: { own: number; other: number } = { own: 0, other: 0 }): PackageReport[] {
  if (other === undefined) return [...own];
  // Of two release-age findings, the one of the longer delay says how long to wait (both policies apply).
  const theirsWins = (finding: CheckFinding) => finding.code === 'too-young' && delays.other > delays.own;
  return own.map((report, index) => {
    const theirs = other[index]?.findings ?? [];
    const mine = report.findings.filter(
      (finding) => !theirs.some((candidate) => candidate.code === finding.code && (severity(candidate) > severity(finding) || (severity(candidate) === severity(finding) && theirsWins(finding)))),
    );
    const added = theirs
      .filter(
        (finding) =>
          !report.findings.some((candidate) => candidate.code === finding.code && (severity(candidate) > severity(finding) || (severity(candidate) === severity(finding) && !theirsWins(finding)))),
      )
      .map((finding) => ({ ...finding, message: finding.message.split(POLICY_FILE).join(nearerFile) }));
    return { ...report, findings: [...mine, ...added] };
  });
}

/** The scope of an npm package name, with @; '' for an unscoped name. */
function scopeOf(name: string): string {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '';
}

/**
 * Whether the install of a request reads a setting: the .npmrc of a workspace package that npm skips counts for npm
 * (and for check and depcurfew mcp, which name no tool) only when the command line may turn workspaces off (decision
 * D-124); pnpm and Bun read .npmrc by rules of their own.
 */
function readsSetting(setting: UnreadSetting, request: Omit<CheckRequest, 'spec'>): boolean {
  return setting.skippedByNpm !== true || (request.tool ?? 'npm') !== 'npm' || request.workspacesOption === true;
}

/** Whether a registry setting the install would use, but depcurfew did not take, applies to this package. */
function appliesTo(setting: UnreadSetting, report: PackageReport, request: CheckRequest): boolean {
  if (report.kind !== 'registry' || report.name === undefined || !readsSetting(setting, request)) return false;
  const python = isPythonSpec(report.spec);
  // .npmrc counts for every tool of the npm ecosystem (pnpm and Bun read it too); a tool's own file for that tool only.
  if (setting.tool === 'npm' ? python : setting.tool !== request.tool) return false;
  if (setting.applies === 'scope') return scopeOf(report.name) === setting.scope;
  // An index pinned to one Python package (decision D-120).
  if (setting.applies === 'package') return python && setting.package === normalizePythonName(report.name.slice(PYPI_PREFIX.length));
  if (setting.applies === 'tag') {
    // tag= chooses the version only of npm, and only for a name without a version or with a range.
    const selector = parseSpec(report.spec)?.selector?.trim() ?? '';
    return request.ignoresConfigTag !== true && request.tag === undefined && (selector === '' || (parseSemver(selector) === undefined && parseRange(selector) !== undefined));
  }
  return true;
}

/** The dist-tag the registry's API names as the default, which npm prefers when nothing else chooses one. */
function registryDefaultTag(): string {
  return values(environment.npmRegistry.api)[0]?.defaultTag ?? 'latest';
}

/** The registry, index or dist-tag depcurfew used for the packages a setting applies to. */
function usedFor(setting: UnreadSetting, report: PackageReport, applied: Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag'>): string {
  if (setting.applies === 'tag') return report.tag ?? applied.tag?.value ?? registryDefaultTag();
  if (isPythonSpec(report.spec)) return applied.index;
  return (setting.scope === undefined ? undefined : applied.scopes.get(setting.scope)) ?? applied.registry.url;
}

/**
 * Whether a setting the install would use changes what depcurfew checked (decision D-113): one that replaces the
 * registry, index or dist-tag with the one depcurfew used changes nothing; one that adds places to install from, or
 * whose value depcurfew cannot read (a variable, another type), always counts.
 */
function changesTheCheck(setting: UnreadSetting, used: string): boolean {
  if (setting.effect === 'adds' || setting.value === undefined) return true;
  return setting.applies === 'tag' ? setting.value !== used : !sameRegistry(setting.value, used);
}

/** Where the hook command lives, for a fix that changes its options. */
function hookSettingsFile(): string {
  return values(environment.claudeCode.hooks)[0]?.settingsFile ?? '.claude/settings.json';
}

/**
 * The finding for a registry setting the install would use but depcurfew did not take (decision D-113). The fix says
 * how to make depcurfew check what the install uses, when the user trusts it: --registry or --index of the command
 * (in the hook command, for depcurfew mcp or on the command line), a scope registry or dist-tag in the .npmrc next to
 * depcurfew.json. agentFix turns it into telling the user.
 */
function unreadFinding(setting: UnreadSetting, report: PackageReport, applied: Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag'>): CheckFinding {
  const where = `${setting.file} (line ${setting.line})`;
  const used = usedFor(setting, report, applied);
  const value = setting.value;
  const finding = (message: string, fix: string): CheckFinding => ({ level: 'error', code: 'unverified', message, fix: `${UNREAD_REGISTRY_FIX_START} ${fix}` });
  const options = `to depcurfew check in the hook command (${hookSettingsFile()}), to depcurfew mcp, or on the command line`;
  if (setting.applies === 'tag') {
    return finding(
      `the install would pick the version by the dist-tag ${value === undefined ? '' : `${quoted(value)} `}set in ${where}; depcurfew checked the version that ${used} names`,
      `the version that dist-tag picks; if the dist-tag is meant for the whole project, set ${value === undefined ? 'tag' : `tag=${value}`} in the .npmrc next to ${POLICY_FILE}`,
    );
  }
  const python = isPythonSpec(report.spec);
  const what = python ? 'index' : 'registry';
  if (setting.applies === 'package' && setting.pin !== undefined) {
    // depcurfew checks one index for all Python packages, so --index would move the others (decision D-120).
    const named = value === undefined ? `the index set in ${where}, whose value depcurfew cannot read` : `the index ${value} from ${where}`;
    return finding(
      `the install would use ${named}, to which ${setting.pin.file} (line ${setting.pin.line}) pins it; depcurfew checked ${used}`,
      `the package in the index that ${setting.pin.file} pins it to: depcurfew checks one index for every Python package of a command, so it cannot vouch for one that comes from another; depcurfew check --index ${value ?? '<its URL>'} ${report.spec} checks it there`,
    );
  }
  if (setting.effect === 'adds') {
    return finding(
      `the install may also take it from ${value ?? 'the places'} that ${where} adds; depcurfew checked only ${used}`,
      `the package in every ${what} that ${setting.file} adds: depcurfew checks one ${what}, so it cannot vouch for a package from the others`,
    );
  }
  const scope = setting.applies === 'scope' ? ` for ${setting.scope ?? ''}` : '';
  const named = value === undefined ? `the ${what}${scope} set in ${where}, whose value depcurfew cannot read` : `the ${what}${scope} ${value} from ${where}`;
  const url = value ?? '<its URL>';
  const remedy =
    setting.applies === 'scope'
      ? `set ${setting.scope ?? '@scope'}:registry=${url} in the .npmrc next to ${POLICY_FILE}`
      : `pass ${python ? '--index' : '--registry'} ${url} ${options}`;
  return finding(`the install would use ${named}; depcurfew checked ${used}`, `the package in the ${what} that ${setting.file} names; if you trust that ${what}, ${remedy}`);
}

/** Findings that the checked registry or index does not have the package or the version. */
const MISSING: ReadonlySet<CheckFinding['code']> = new Set(['not-found', 'no-version']);

/**
 * What to say when the checked registry or index has no such package or version, while a setting depcurfew did not
 * take may make the install take it from elsewhere (decision D-120): not that the name is made up, but where it may
 * come from instead.
 */
function missingMessage(missing: CheckFinding, setting: UnreadSetting, report: PackageReport, applied: Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag'>): string {
  const used = usedFor(setting, report, applied);
  const absent = missing.code === 'not-found' ? `${report.name ?? report.spec} does not exist in ${used}` : `${missing.message} in ${used}`;
  const where = `${setting.file} (line ${setting.line})`;
  const value = setting.value === undefined ? '' : ` ${setting.value}`;
  const what = isPythonSpec(report.spec) ? 'index' : 'registry';
  if (setting.applies === 'package' && setting.pin !== undefined) {
    return `${absent}, but ${setting.pin.file} (line ${setting.pin.line}) pins it to the index${value} set in ${where}, which depcurfew did not check`;
  }
  const scope = setting.applies === 'scope' ? ` for ${setting.scope ?? ''}` : '';
  const source = setting.effect === 'adds' ? (setting.value === undefined ? `the places that ${where} adds` : `the ${what}${value} that ${where} adds`) : `the ${what}${scope}${value} set in ${where}`;
  return `${absent}, but it may come from ${source}, which depcurfew did not check`;
}

/** The settings of a tool's own configuration files for the requests of a command, read once per tool. */
function toolSettings(requests: readonly CheckRequest[], applied: Pick<AppliedPolicy, 'start' | 'top'>): { unread: UnreadSetting[]; skipped: SkippedFile[] } {
  const tools = [...new Set(requests.map((request) => request.tool).filter((tool): tool is ToolId => tool !== undefined && hasRegistrySettings(tool)))];
  const found = tools.map((tool) => toolRegistrySettings(tool, applied.start, applied.top));
  return { unread: found.flatMap((entry) => entry.unread), skipped: found.flatMap((entry) => entry.skipped) };
}

export interface RunSettings {
  fetch: FetchLike;
  now: Date;
  signal?: AbortSignal;
  scriptBodies?: boolean;
  /** Whether the index was given (--index); without it PyPI. */
  index?: string | undefined;
  /** Lookups shared with other checks of the same command (the hook's installs in several directories). */
  lookups?: LookupCache;
}

/**
 * Checks the requests against the policy and, when there is one, the nearer policy too, sharing each lookup between
 * them (decision D-113); then marks the packages a registry setting depcurfew did not take applies to. `skipped`
 * lists the configuration files that were not read.
 */
export async function checkApplied(requests: readonly CheckRequest[], applied: AppliedPolicy, settings: RunSettings): Promise<{ reports: PackageReport[]; skipped: SkippedFile[] }> {
  const lookups: LookupCache = settings.lookups ?? new Map();
  const tools = toolSettings(requests, applied);
  const unread = [...applied.unread, ...tools.unread];
  const options = (policy: ResolvedPolicy) => ({
    policy,
    fetch: settings.fetch,
    now: settings.now,
    registry: applied.registry.url,
    popular: new PopularNames(values(popularPackages)[0] ?? []),
    popularPython: popularPython(),
    scopeRegistries: applied.scopes,
    lookups,
    // A scope whose registry is set elsewhere, to another registry than depcurfew would ask, is not looked up.
    skipLookup: (name: string, tool: ToolId | undefined, request?: Omit<CheckRequest, 'spec'>) =>
      unread.some(
        (setting) =>
          setting.applies === 'scope' &&
          setting.scope === scopeOf(name) &&
          (setting.tool === 'npm' || setting.tool === tool) &&
          readsSetting(setting, request ?? { ...(tool === undefined ? {} : { tool }) }) &&
          changesTheCheck(setting, applied.scopes.get(setting.scope) ?? applied.registry.url),
      ),
    ...(settings.index === undefined ? {} : { index: applied.index }),
    ...(applied.tag === undefined ? {} : { defaultTag: applied.tag.value }),
    ...(settings.scriptBodies === undefined ? {} : { scriptBodies: settings.scriptBodies }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  const policies = applied.nearer === undefined ? [applied.policy] : [applied.policy, applied.nearer.policy];
  const [own = [], other] = await Promise.all(policies.map((policy) => checkSpecs(requests, options(policy))));
  const reports = mergedReports(own, other, applied.nearer?.file ?? POLICY_FILE, { own: delayOf([applied.policy]), other: delayOf(applied.nearer === undefined ? [] : [applied.nearer.policy]) });
  for (const [index, report] of reports.entries()) {
    const request = requests[index] ?? { spec: report.spec };
    // One finding per package: the first setting that applies to it.
    const setting = unread.find((candidate) => appliesTo(candidate, report, request) && changesTheCheck(candidate, usedFor(candidate, report, applied)));
    if (setting === undefined) continue;
    const finding = unreadFinding(setting, report, applied);
    // A package or version missing where depcurfew looked may be where the install looks (decision D-120): the
    // finding asks instead of denying, and says where.
    const missing = setting.applies === 'tag' ? undefined : report.findings.find((candidate) => MISSING.has(candidate.code));
    if (missing === undefined) {
      report.findings.push(finding);
      continue;
    }
    const at = report.findings.indexOf(missing);
    report.findings = report.findings.filter((candidate) => !MISSING.has(candidate.code));
    report.findings.splice(at, 0, { ...finding, message: missingMessage(missing, setting, report, applied) });
  }
  return { reports, skipped: [...applied.skipped, ...tools.skipped] };
}

/** What to say about a configuration file that was not read. */
function skippedNotice(skipped: SkippedFile): string {
  if (skipped.notice !== undefined) return skipped.notice;
  const what = skipped.file.split('/').at(-1) === '.npmrc' ? 'its registry settings, if any, were not used' : 'the registry it may set was not looked at';
  return `${skipped.file} was not read: ${skipped.reason}; ${what}`;
}

/** The notice that a nearer depcurfew.json applies besides the main one; `where`: the directory of the installs, when not the working directory. */
function nearerNotice(applied: AppliedPolicy, mainName: string, where?: string): string | undefined {
  if (applied.nearer === undefined) return undefined;
  return `Besides ${mainName}, ${applied.nearer.file} also applies ${where === undefined ? 'here' : `to what the command installs in ${where}`}; the stricter answer counts`;
}

/**
 * The policies of the working directory for an install in another directory, when they add to that directory's own
 * (decision D-119): with the configuration files of the install's directory, so that only the policy changes; `files`
 * names the policies that are added (null for the default policy).
 */
function workingPolicies(applied: AppliedPolicy, here: AppliedPolicy): { applied: AppliedPolicy; files: (string | null)[] } | undefined {
  const own = new Set([applied.file, applied.nearer?.file]);
  const files = [here.file, ...(here.nearer === undefined ? [] : [here.nearer.file])].filter((file) => !own.has(file));
  if (files.length === 0) return undefined;
  const { nearer: _nearer, ...lookups } = applied;
  return { applied: { ...lookups, policy: here.policy, file: here.file, ...(here.nearer === undefined ? {} : { nearer: here.nearer }) }, files };
}

/** The note that the policies of the working directory apply to an install elsewhere; `where` undefined: a directory depcurfew cannot tell. */
function workingNotice(files: readonly (string | null)[], where: string | undefined): string {
  const names = files.map((file) => file ?? 'the default policy').join(' and ');
  return `The policy of the working directory (${names}) also applies to what the command installs in ${where ?? 'a directory depcurfew cannot tell'}, so that changing directory never relaxes the check; the stricter answer counts.`;
}

/** The file that marks the directory of a Python virtual environment. */
const VENV_MARKER = values(environment.python.virtualEnvironment)[0]?.marker ?? 'pyvenv.cfg';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the shell can change to a path: it is a directory (also through a symlink) that may be searched. */
function enterable(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The separators of paths on this system. */
const SEPARATORS = sep === '\\' ? /[\\/]/u : /\//u;

/**
 * Whether a change of directory from `from` to `step` succeeds, as bash's cd checks it (decision D-119): logically,
 * each directory before a .. and the last one must exist (cd nope/../app fails); physically (cd -P), as the system
 * resolves the path through symlinks.
 */
function enters(from: string, step: string, physical: boolean): boolean {
  if (physical) return enterable(isAbsolute(step) ? step : `${from}${sep}${step}`);
  const root = parse(step).root;
  let path = root === '' ? from : resolve(root);
  for (const part of step.slice(root.length).split(SEPARATORS)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!enterable(path)) return false;
      path = dirname(path);
    } else {
      path = join(path, part);
    }
  }
  return enterable(path);
}

/** A change of directory with cd -P or after set -P: the real path of the part that exists, then the rest (decision D-119). */
function physicalPath(from: string, step: string): string {
  const raw = isAbsolute(step) ? step : `${from}${sep}${step}`;
  const parts = raw.split(SEPARATORS);
  for (let length = parts.length; length > 0; length--) {
    try {
      return resolve(realpathSync.native(parts.slice(0, length).join(sep) || sep), ...parts.slice(length));
    } catch {
      // A shorter part of the path may exist.
    }
  }
  return resolve(raw);
}

/**
 * Where an install runs, real and absolute (decision D-118), or why depcurfew cannot tell: a change of directory the
 * shell makes to a directory that does not exist, or is a file, fails and leaves the shell where it was (decision D-119).
 */
function installDirectory(cwd: string, directory: Exclude<CommandDirectory, { unknown: string }>): { path: string } | { unknown: string } {
  // The directories the shell left on the way must have been entered, or OLDPWD and the stack differ (decision D-123).
  for (const assumed of directory.assumes ?? []) {
    const found = installDirectory(cwd, assumed);
    if ('unknown' in found) return found;
    // A sourced activation script is trusted only in a directory that holds pyvenv.cfg (decision D-123).
    if (assumed.venv === true && !isFile(join(found.path, VENV_MARKER))) return { unknown: notVirtualEnvironment(assumed.steps.join('/')) };
  }
  let current = resolve(cwd);
  for (const [index, step] of directory.steps.entries()) {
    const physical = directory.physical?.includes(index) === true;
    if (directory.entered?.includes(index) === true && !enters(current, step, physical)) return { unknown: missingDirectory(step) };
    current = physical ? physicalPath(current, step) : resolve(current, step);
  }
  return { path: realPathOfAny(current) };
}

/** The real path of a directory that may not exist yet (mkdir app && cd app && npm i x): of its nearest existing parent. */
function realPathOfAny(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let directory = absolute; ; directory = dirname(directory)) {
    try {
      return join(realpathSync(directory), ...rest);
    } catch {
      if (dirname(directory) === directory) return absolute;
      rest.unshift(basename(directory));
    }
  }
}

/** The root of the git repository a directory is in (the first with .git), or undefined. */
function repositoryRoot(start: string): string | undefined {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return directory;
    if (dirname(directory) === directory) return undefined;
  }
}

/** How many directories of one command the hook reads policies and configuration files for; more asks. */
const MAX_DIRECTORIES = 20;

/** The installs and overrides of a command that run in one directory, and the policies, registries and files for them. */
interface HookGroup {
  /** here: the working directory; inside or outside the project; unknown: a directory depcurfew cannot tell. */
  kind: 'here' | 'inside' | 'outside' | 'unknown';
  /** The directory, real and absolute; undefined for unknown. */
  directory: string | undefined;
  /** npm --prefix gave it: npm's local prefix as it is. */
  localPrefix: boolean;
  requests: PlacedRequest[];
  overrides: Override[];
}

/**
 * The installs and overrides of a command by the directory they run in (decision D-118), so that each set of policies
 * and configuration files is read once. An override in a directory depcurfew cannot tell keeps the working directory,
 * as before; an install there is checked with the project's policy and asks.
 */
function hookGroups(cwd: string, specs: readonly PlacedRequest[], overrides: readonly Override[], project: string): { groups: HookGroup[]; tooMany?: string } {
  const groups = new Map<string, HookGroup>();
  const here = realPathOfAny(cwd);
  let directories = 0;
  let dropped = 0;
  // Installs and overrides placed in one directory share its object, which is looked at on disk once (decision D-123).
  const looked = new Map<CommandDirectory, ReturnType<typeof installDirectory>>();
  const lookAt = (directory: Exclude<CommandDirectory, { unknown: string }>) => {
    let found = looked.get(directory);
    if (found === undefined) {
      found = installDirectory(cwd, directory);
      looked.set(directory, found);
    }
    return found;
  };
  /** The group of a directory, and why depcurfew cannot tell the directory when the scan could but the hook cannot. */
  const groupOf = (directory: CommandDirectory | undefined, overridden: boolean): { group: HookGroup; unknown?: string } | undefined => {
    let key = 'here';
    let entry: Omit<HookGroup, 'requests' | 'overrides'> = { kind: 'here', directory: undefined, localPrefix: false };
    const found = directory === undefined || 'unknown' in directory ? directory : lookAt(directory);
    /** Why the hook cannot tell a directory that the scan gave (decision D-119). */
    const unknown = found !== undefined && 'unknown' in found && directory !== undefined && !('unknown' in directory) ? found.unknown : undefined;
    if (found !== undefined && 'unknown' in found) {
      if (!overridden) {
        key = 'unknown';
        entry = { kind: 'unknown', directory: undefined, localPrefix: false };
      }
    } else if (found !== undefined) {
      const real = found.path;
      const localPrefix = directory !== undefined && !('unknown' in directory) && directory.localPrefix === true;
      if (real !== here || localPrefix) {
        key = `${localPrefix ? 'prefix' : 'directory'}:${real}`;
        entry = { kind: isInside(project, real) ? 'inside' : 'outside', directory: real, localPrefix };
      }
    }
    let group = groups.get(key);
    if (group === undefined) {
      // Each directory costs reading its policies and configuration files.
      if (entry.directory !== undefined && ++directories > MAX_DIRECTORIES) {
        dropped += 1;
        return undefined;
      }
      group = { ...entry, requests: [], overrides: [] };
      groups.set(key, group);
    }
    return { group, ...(unknown === undefined ? {} : { unknown }) };
  };
  for (const spec of specs) {
    const placed = groupOf(spec.directory, false);
    placed?.group.requests.push(placed.unknown === undefined ? spec : { ...spec, directory: { unknown: placed.unknown } });
  }
  for (const override of overrides) groupOf(override.directory, true)?.group.overrides.push(override);
  // A command that only could not be read is still answered with the policies of the working directory.
  if (groups.size === 0) groupOf(undefined, false);
  const tooMany = dropped === 0 ? {} : { tooMany: `the command installs in more than ${MAX_DIRECTORIES} directories, and ${TOO_MANY} ${MAX_DIRECTORIES} directories in one command` };
  return { groups: [...groups.values()], ...tooMany };
}

async function hook(flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  let event: ReturnType<typeof readHookEvent>;
  try {
    event = readHookEvent(await dependencies.stdin());
  } catch (error) {
    // Without the event depcurfew cannot tell what would run; this exit code blocks the call even without onFailure.
    // Claude sees stderr as the reason, so the parser's message (which may quote the input) is shown as visible text.
    const colors = paint(io.colors?.stderr);
    io.stderr(`${colors.bold(colors.red('error:'))} cannot read the hook event: ${reasonText(messageOf(error))} ${colors.dim(`(${HOOK_EVENT_UNREADABLE})`)}\n  ${colors.green('fix:')} ${unreadableEventFix()}\n`);
    return blockingExitCode();
  }
  if (event === undefined) return EXIT_OK;
  try {
    const { specs, unreadable, overrides } = requestedSpecs(event.command, event.shell);
    if (specs.length === 0 && unreadable === undefined && overrides.length === 0) return EXIT_OK;
    const cwd = resolve(flags.dir ?? event.cwd ?? process.cwd());
    const projectDir = flags.dir === undefined ? (dependencies.projectDir ?? (() => process.env[projectDirVariable()]))() : undefined;
    const root = hookPolicyStart(cwd, projectDir);
    const base = root.project ?? root.start;
    // The project an install directory is judged against (decision D-118): CLAUDE_PROJECT_DIR when the working
    // directory lies in it, else the directory of the policy that applies there, its repository or itself.
    const project = root.project ?? realPathOfAny(findPolicyDirectory(cwd) ?? repositoryRoot(cwd) ?? cwd);
    const common = { registry: flags.registry, index: flags.index, home: dependencies.home?.() ?? homedir(), base };
    // Outside the project, and where depcurfew cannot tell, only the project's policy applies (or the nearest one from
    // the working directory when the project has none): never one found from a directory the command names.
    const projectOnly = { start: root.start, project };
    const lookups: LookupCache = new Map();
    const reports: PackageReport[] = [];
    const notes: string[] = [];
    const skipped: SkippedFile[] = [];
    const placed = hookGroups(cwd, specs, overrides, project);
    let doubt: string | undefined = placed.tooMany;
    const cannotCheck = (result: Extract<AppliedPolicyResult, { ok: false }>) => {
      // A nearer policy is named, so that the user is not pointed at the project's policy, which is fine (decision D-110).
      const { cause } = result;
      const text = result.nearer ? (cause.issues.length > 0 ? `${result.file} is invalid: ${cause.issues.join('; ')}` : `${result.file}: ${messageOf(cause)}`) : messageOf(cause);
      io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(text)}` }) ?? '');
      return EXIT_OK;
    };
    // The policies of the working directory apply to every install of the command, wherever it runs, so a change of
    // directory (that may not happen, or that depcurfew reads differently from the shell) only tightens the check.
    const hereResult = appliedPolicy(cwd, { ...common, ...(projectDir === undefined ? {} : { project: projectDir }) });
    if (!hereResult.ok) return cannotCheck(hereResult);
    const hereApplied = hereResult.applied;
    for (const group of placed.groups) {
      const directory = group.directory ?? cwd;
      const result =
        group.kind === 'here'
          ? hereResult
          : appliedPolicy(directory, { ...common, ...(group.kind === 'inside' ? { project } : { root: projectOnly }), ...(group.localPrefix ? { npmPrefix: directory } : {}) });
      if (!result.ok) return cannotCheck(result);
      const { applied } = result;
      const working = group.kind === 'here' ? undefined : workingPolicies(applied, hereApplied);
      const sources = [applied, ...(working === undefined ? [] : [working.applied])].flatMap((entry) =>
        entry.nearer === undefined ? [{ policy: entry.policy, file: entry.file }] : [{ policy: entry.policy, file: entry.file }, { policy: entry.nearer.policy, file: entry.nearer.file }],
      );
      const policies = sources.map((source) => source.policy);
      if (group.kind === 'here' || group.requests.length > 0) {
        const requests = group.requests.map((entry) => entry.request);
        const settings: RunSettings = { fetch: dependencies.fetch, now: dependencies.now(), scriptBodies: false, index: flags.index, lookups };
        const checked = await checkApplied(requests, applied, settings);
        // The lookups are shared, so the packages are looked up once; the stricter answer counts.
        const also = working === undefined ? undefined : await checkApplied(requests, working.applied, settings);
        const delays = working === undefined ? undefined : { own: delayOf(policiesOf(applied)), other: delayOf(policiesOf(working.applied)) };
        reports.push(...(also === undefined ? checked.reports : mergedReports(checked.reports, also.reports, POLICY_FILE, delays)));
        for (const file of [...checked.skipped, ...(also?.skipped ?? [])]) if (!skipped.some((known) => known.file === file.file && known.reason === file.reason)) skipped.push(file);
        // Say which registry answered when it is not the public one, if an npm package was looked up there.
        const lookedUp = checked.reports.some((report) => report.kind === 'registry' && !isPythonSpec(report.spec) && report.name !== undefined && !applied.scopes.has(scopeOf(report.name)));
        const note = lookedUp ? registryNote(applied.registry) : undefined;
        if (note !== undefined) notes.push(`${note}.`);
      }
      const where = group.kind === 'here' ? undefined : shownPath(base, directory) || '.';
      const main = group.kind === 'here' || root.project !== undefined ? `the policy of the project (${projectDirVariable()})` : (applied.file ?? 'the default policy');
      const besides = nearerNotice(applied, main, where);
      if (besides !== undefined) notes.push(`${besides}.`);
      if (working !== undefined) notes.push(workingNotice(working.files, group.kind === 'unknown' ? undefined : where));
      const unplaced = group.kind === 'unknown' ? group.requests.find((entry) => entry.directory !== undefined && 'unknown' in entry.directory) : undefined;
      if (unplaced?.directory !== undefined && 'unknown' in unplaced.directory) doubt ??= unknownDirectory(unplaced.command, unplaced.directory.unknown);
      // The message names the file that sets the delay or the rule, relative to the project (decision D-123).
      doubt ??= overrideDoubt(group.overrides, policies, sources.map((source) => source.file));
    }
    io.stdout(formatDecision(decide(reports, unreadable ?? doubt, [...new Set(notes)], skipped.map(skippedNotice))) ?? '');
  } catch (error) {
    io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(messageOf(error))}` }) ?? '');
  }
  return EXIT_OK;
}

export async function check(specs: readonly string[], flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  // run.ts reports these usage errors, also as JSON; this guards other callers.
  if (flags.hook !== undefined && (!(HOOKS as readonly string[]).includes(flags.hook) || specs.length > 0)) return EXIT_USAGE;
  if (flags.hook !== undefined) return hook(flags, io, dependencies);
  if (specs.length === 0) return EXIT_USAGE;
  const outcome = await checkDocument(specs, {
    dir: flags.dir,
    registry: flags.registry,
    index: flags.index,
    home: dependencies.home?.() ?? homedir(),
    fetch: dependencies.fetch,
    now: dependencies.now(),
  });
  const { document } = outcome;
  const code = outcome.status === 'directory-error' ? EXIT_USAGE : outcome.status === 'policy-error' || failedCheck(document) ? EXIT_FAILURE : EXIT_OK;
  if (flags.json) {
    io.stdout(`${safeJson(document, 2)}\n`);
    return code;
  }
  // Nothing is checked without a directory or with a policy that cannot be used.
  for (const error of document.errors) reportInputError(error, io);
  if (outcome.status !== 'checked') return code;
  // Each notice starts with its level and ends with its code, as in doctor; what to do follows on its own line.
  const colors = paint(io.colors?.stderr);
  for (const notice of document.notices) {
    io.stderr(`${colors.cyan('note:')} ${printable(notice.message)} ${colors.dim(`(${notice.code})`)}\n`);
    if (notice.fix !== undefined) io.stderr(`  ${colors.green('fix:')} ${printable(notice.fix)}\n`);
  }
  io.stdout(render(document.packages, paint(io.colors?.stdout)));
  return code;
}

/** The document of check --json (and of the check_packages tool of depcurfew mcp). */
export interface CheckDocument {
  schemaVersion: 1;
  /** The depcurfew.json used, relative to the directory checked; null for the default policy. */
  policy: string | null;
  packages: PackageReport[];
  notices: CheckNotice[];
  /** Why nothing was checked, in the shape of the errors of apply --json. */
  errors: InputError[];
}

export interface CheckSettings {
  /** The directory as given (--dir); undefined for `cwd`. */
  dir: string | undefined;
  /** What a relative `dir` resolves against; the current directory when left out. */
  cwd?: string;
  /** The npm registry given on the command line (--registry); else .npmrc, else the public registry. */
  registry: string | undefined;
  /** The Python package index (--index); else PyPI. */
  index?: string | undefined;
  /** The user's home directory, with the user's .npmrc. */
  home: string;
  fetch: FetchLike;
  now: Date;
  /** Stops the lookups (a cancelled call of depcurfew mcp); the promise then rejects. */
  signal?: AbortSignal;
  /** Whether findings quote install scripts (check) or only name them (agents, as in the hook). */
  scriptBodies?: boolean;
  /** 'agent' for depcurfew mcp: notices say what an agent can do, which is not to write depcurfew.json. */
  audience?: 'person' | 'agent';
  /**
   * depcurfew mcp: the project directory, whose policy applies with the nearer one of `dir` (hookPolicyStart); paths in
   * the document are then relative to it.
   */
  project?: string;
}

/**
 * `checked`, or why nothing was checked: the directory does not exist (a usage error on the command line) or its
 * depcurfew.json cannot be used. The document is the same in each case.
 */
export interface CheckOutcome {
  status: 'checked' | 'directory-error' | 'policy-error';
  document: CheckDocument;
}

/** Whether a package of the document breaks the policy or could not be checked. */
export function failedCheck(document: CheckDocument): boolean {
  return document.packages.some((report) => report.findings.some((finding) => finding.level === 'error'));
}

/**
 * A notice of check --json and of check_packages and explain_policy of depcurfew mcp, with the fields of a notice of
 * doctor (decision D-116): the level, always note; a code; the file (and line) it concerns, when one does; the message;
 * and what to do, when there is something to do (decision D-118).
 */
export interface CheckNotice {
  level: 'note';
  code: string;
  location?: { file: string; line?: number };
  message: string;
  fix?: string;
}

/** A notice with its fields in the order of a finding; `location` and `fix` only when they are known. */
function notice(code: string, message: string, location?: { file: string; line?: number | undefined }, fix?: string): CheckNotice {
  const where = location === undefined ? {} : { location: { file: location.file, ...(location.line === undefined ? {} : { line: location.line }) } };
  return { level: 'note', code, ...where, message, ...(fix === undefined ? {} : { fix }) };
}

/**
 * What to say about the policy and the registry: the default policy is used (policy-missing), a nearer policy applies
 * too (nearer-policy), npm packages are looked up in a registry other than the public one (registry-not-public, or
 * registry-link-local for one depcurfew does not ask), npm prefers another dist-tag (npm-dist-tag), a configuration
 * file was not read (config-not-read). The registry and the dist-tag only when `npm` packages are checked. For an
 * agent, the default policy is not an invitation to write depcurfew.json, and a file it should not change is the
 * user's; `explained` says where check_packages looks packages up, in the present tense (explain_policy), instead of
 * where they were looked up.
 */
export function policyNotices(applied: AppliedPolicy, npm: boolean, options: { audience?: 'person' | 'agent'; explained?: boolean; skipped?: readonly SkippedFile[] } = {}): CheckNotice[] {
  const agent = options.audience === 'agent';
  const note = registryNote(applied.registry, options.explained === true ? 'explained' : 'checked');
  const tag = applied.tag;
  const defaultPolicy = agent
    ? notice(
        'policy-missing',
        `no ${POLICY_FILE} found, so the default policy of depcurfew init applies; tell the user if the project should have a policy of its own`,
        undefined,
        "Tell the user that the project has no policy of its own; only the user writes one",
      )
    : notice(
        'policy-missing',
        `no ${POLICY_FILE} found; checking against the default policy of depcurfew init (depcurfew init writes it)`,
        undefined,
        `Run depcurfew init to write ${POLICY_FILE} with this policy, then change it as the project needs`,
      );
  const besides = nearerNotice(applied, applied.file === null ? 'the default policy' : applied.file);
  const registry = applied.registry;
  const registryFile = registry.file === undefined ? undefined : { file: registry.file, line: registry.line };
  const linkLocal = linkLocalRegistry(registry);
  const linkLocalFix = agent
    ? "Tell the user: the registry is the user's setting"
    : 'Set a registry that is not at a link-local address, or pass --registry with the registry depcurfew should ask';
  return [
    ...(applied.file === null ? [defaultPolicy] : []),
    ...(besides === undefined || applied.nearer === undefined ? [] : [notice('nearer-policy', besides, { file: applied.nearer.file })]),
    ...(npm && note !== undefined ? [linkLocal ? notice('registry-link-local', note, registryFile, linkLocalFix) : notice('registry-not-public', note, registryFile)] : []),
    ...(tag === undefined || !npm
      ? []
      : [
          notice(
            'npm-dist-tag',
            `npm prefers the dist-tag "${tag.value}" (${tag.where}) for packages named without a version or with a range`,
            tag.file === undefined ? undefined : { file: tag.file, line: tag.line },
          ),
        ]),
    ...(options.skipped ?? applied.skipped).map((skipped) =>
      notice(
        'config-not-read',
        skippedNotice(skipped),
        { file: skipped.file },
        agent
          ? (skipped.agentFix ?? `Tell the user that ${skipped.file} was not read; do not change it yourself`)
          : (skipped.fix ?? `Make ${skipped.file} a regular file of at most ${MAX_CONFIG_SIZE / (1024 * 1024)} MiB that depcurfew can read, or remove it`),
      ),
    ),
  ];
}

/** Checks the packages as depcurfew check does and returns the document of check --json. */
export async function checkDocument(specs: readonly string[], settings: CheckSettings): Promise<CheckOutcome> {
  // The same error shape as apply --json; nothing is checked without a directory or with a policy that cannot be used.
  const failed = (status: 'directory-error' | 'policy-error', policy: string | null, error: InputError): CheckOutcome => ({
    status,
    document: { schemaVersion: 1, policy, packages: [], notices: [], errors: [error] },
  });
  const target = checkDirectory(settings.dir, settings.cwd);
  if (!target.ok) return failed('directory-error', null, target.error);
  const result = appliedPolicy(target.directory, {
    registry: settings.registry,
    index: settings.index,
    home: settings.home,
    ...(settings.project === undefined ? {} : { project: settings.project, base: settings.project }),
  });
  if (!result.ok) return failed('policy-error', result.file, result.error);
  const { applied } = result;
  const { reports, skipped } = await checkApplied(specs.map((spec) => ({ spec })), applied, {
    fetch: settings.fetch,
    now: settings.now,
    index: settings.index,
    ...(settings.scriptBodies === undefined ? {} : { scriptBodies: settings.scriptBodies }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  const notices = policyNotices(applied, specs.some((spec) => !isPythonSpec(spec)), { ...(settings.audience === undefined ? {} : { audience: settings.audience }), skipped });
  return { status: 'checked', document: { schemaVersion: 1, policy: applied.file, packages: reports, notices, errors: [] } };
}
