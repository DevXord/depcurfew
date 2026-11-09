// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one, up to the root of the repository), else the default policy of
// `depcurfew init`. Packages are looked up in the registry given with --registry, else the one the user's .npmrc or
// the project's .npmrc sets (the .npmrc npm reads there, when it belongs to the policy: decision D-113), else the
// public npm registry; pypi: packages in the index given with --index, else PyPI; composer: packages in Packagist,
// unless the root composer.json declares other repositories (decision D-133). Exit code 1 when any package breaks
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
import { COMPOSER_PREFIX } from '../policy/package-pattern.ts';
import { isComposerSpec } from '../check/composer.ts';
import { findComposerCommand, type FoundCommand, type ScriptCommands } from '../check/composer-commands.ts';
import { packagistUrl } from '../check/packagist.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { blockingExitCode, decide, formatDecision, hookEventExample, readHookEvent, reasonText, requestedSpecs, UNREAD_REGISTRY_FIX_START, type HookDecision, type PlacedRequest } from '../check/hook.ts';
import { missingDirectory, notVirtualEnvironment, overrideDoubt, TOO_MANY, unknownDirectory, unreadableFix, type CommandDirectory, type Override } from '../check/command.ts';
import { defaultRegistry, type FetchLike, isLinkLocal, type LookupCache } from '../check/registry.ts';
import { defaultIndex } from '../check/pypi.ts';
import { addLocalOsvFindings, addOsvFindings, checkedEcosystems, type OsvLocalLookup } from '../check/osv.ts';
import { addListedVersions, listedReports, MAX_LISTED_SPECS } from '../check/listed.ts';
import { LocalOsvData } from '../osv/data.ts';
import { localDataNotices } from '../osv/notices.ts';
import { userOsvData } from '../osv/default.ts';
import { currentEnvironment } from '../user/environment.ts';
import { currentMachine, type MachineEnvironment } from '../check/machine-settings.ts';
import {
  composerProject,
  hasRegistrySettings,
  machineToolSettings,
  MAX_CONFIG_SIZE,
  npmrcSettings,
  sameRegistry,
  toolRegistrySettings,
  type ComposerProject,
  type NpmrcSettings,
  type SkippedFile,
  type UnreadSetting,
  type WrittenSetting,
} from '../check/registry-settings.ts';
import { lookupOptionPlaces, quoted } from '../check/findings.ts';
import { defaultPopularNames } from '../check/popular.ts';
import { values } from '../apply/facts.ts';
import type { CommandNamesKnowledge, ToolId } from '../knowledge/types.ts';
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
  /**
   * The platform the hook runs on: on Windows a POSIX shell (Git Bash) hands its variables to programs that do not tell
   * their names apart by case (decision D-143); tests replace it.
   */
  platform?: () => NodeJS.Platform;
  /** depcurfew mcp: the streams the server talks over, its environment and signals (tests replace them). */
  mcpProcess?: () => McpProcess;
  /**
   * The directory of the local OSV.dev data that depcurfew osv update writes (decision D-150); undefined for none. By
   * default the one in depcurfew's user cache directory; tests replace it.
   */
  osvData?: () => string | undefined;
}

/**
 * The local OSV.dev data of the user cache directory (or of the directory the dependencies name). In the user cache
 * directory, that directory and depcurfew's folders in it must not be writable by other users (decision D-156); a
 * directory the dependencies name is checked alone.
 */
export function localOsvData(dependencies: Pick<CheckDependencies, 'osvData' | 'userEnvironment'>): LocalOsvData {
  if (dependencies.osvData !== undefined) return new LocalOsvData(dependencies.osvData());
  // The same data a program gets from defaultOsvData (decision D-183).
  return userOsvData(dependencies.userEnvironment?.() ?? currentEnvironment());
}

export interface CheckFlags {
  json: boolean;
  registry: string | undefined;
  /** The Python package index for pypi: packages. */
  index?: string | undefined;
  dir: string | undefined;
  hook: string | undefined;
  /** --osv: look the version each install picks up in OSV.dev for known malicious versions (decision D-129). */
  osv?: boolean;
}

function defaultPolicy(): ResolvedPolicy {
  const result = parsePolicy(renderPolicy(DEFAULT_POLICY));
  if (!result.ok) throw new Error('the default policy is invalid');
  return result.policy;
}

/**
 * The machine the check runs on, whose registry and index settings count (decision D-168): the environment of the user
 * environment the dependencies give (tests), else this process's.
 */
export function machineOf(dependencies: Pick<CheckDependencies, 'userEnvironment' | 'platform'>): MachineEnvironment {
  const user = dependencies.userEnvironment?.();
  return { env: user?.env ?? process.env, platform: user?.platform ?? dependencies.platform?.() ?? process.platform, execPath: process.execPath };
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
    // Python versions are written name==version, as pip takes them, and Composer versions name:version, as composer
    // require takes them. Names, versions, deprecation messages and scripts come from the registry: control characters
    // are shown as text.
    const separator = isPythonSpec(report.spec) ? '==' : isComposerSpec(report.spec) ? ':' : '@';
    const label = printable(report.version === undefined || report.name === undefined ? report.spec : `${report.name}${separator}${report.version}`);
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
  /** Where each of them is set: @acme:registry= in .npmrc, line 2 (decision D-168). */
  scopeWhere: ReadonlyMap<string, string>;
  /** The dist-tag .npmrc makes npm prefer. */
  tag: WrittenSetting | undefined;
  /** Registry settings npm reads there that depcurfew does not take: the packages they apply to are not vouched for. */
  unread: readonly UnreadSetting[];
  /** Configuration files that were not read. */
  skipped: readonly SkippedFile[];
  /** Where packages are installed, and the highest directory whose configuration files count for them. */
  start: string;
  top: string;
  /** The machine the install runs on and the home directory, whose registry and index settings count (decision D-168). */
  machine: { environment: MachineEnvironment; home: string };
}

/** Where packages are looked up, which does not depend on the policy: the registry, the index, scopes and the dist-tag. */
export type Lookups = Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'scopeWhere' | 'tag' | 'unread' | 'skipped'>;

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
  /** The environment, platform and Node.js executable of the install (decision D-168); this process's when left out. */
  machine?: MachineEnvironment | undefined;
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
  const machine = settings.machine ?? currentMachine();
  const npmrc = npmrcSettings(start, { trusted, home: settings.home, base, prefix: settings.npmPrefix, machine });
  const lookups: Lookups = {
    registry: registryOf(settings.registry, npmrc),
    index: settings.index === undefined ? defaultIndex() : withoutCredentials(settings.index),
    scopes: npmrc.scopes,
    scopeWhere: new Map([...npmrc.scopeSettings].map(([scope, setting]) => [scope, setting.where])),
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
  return {
    ok: true,
    applied: { policy: policy ?? defaultPolicy(), file: file ?? null, ...(nearer === undefined ? {} : { nearer }), ...lookups, start: resolve(start), top, machine: { environment: machine, home: settings.home } },
  };
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
  const composer = isComposerSpec(report.spec);
  // The root composer.json counts for every Composer package, with or without a command that names Composer, unless
  // the command does not read it (create-project, global; decision D-133).
  if (setting.tool === 'composer') return composer && request.readsManifest !== false;
  // .npmrc counts for every tool of the npm ecosystem (pnpm and Bun read it too); a tool's own file for that tool only,
  // and pip's settings for a Python package that no command names a tool for (decision D-168).
  if (setting.tool === 'npm' ? python || composer : setting.tool !== (request.tool ?? (python ? 'pip' : undefined))) return false;
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
  if (isComposerSpec(report.spec)) return packagistUrl();
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

/**
 * The finding for a registry setting the install would use but depcurfew did not take (decision D-113). The fix says
 * how to make depcurfew check what the install uses, when the user trusts it: --registry or --index of the command
 * (in the hook command, for depcurfew mcp or on the command line; for a scope too, decision D-168), a dist-tag in the
 * .npmrc next to depcurfew.json. agentFix turns it into telling the user. A setting of the environment is named by its
 * variable. When the package was not looked up (a scope, a setting of the machine, decision D-168), the message says so.
 */
function unreadFinding(setting: UnreadSetting, report: PackageReport, applied: Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag'>): CheckFinding {
  const where = whereOf(setting);
  const source = setting.variable ?? setting.file;
  const used = usedFor(setting, report, applied);
  const value = setting.value;
  const finding = (message: string, fix: string): CheckFinding => ({ level: 'error', code: 'unverified', message, fix: `${UNREAD_REGISTRY_FIX_START} ${fix}` });
  const options = lookupOptionPlaces();
  if (setting.composer !== undefined) {
    // depcurfew asks Packagist only, and has no option to ask another repository (decision D-133).
    const fix = `the package in the repositories that ${setting.file} declares: depcurfew checks only Packagist (${used}), so it cannot vouch for a package from another repository`;
    // The package is not looked up on Packagist, so that a private name does not leave the machine (decision D-136).
    const skipped = `depcurfew checks only Packagist (${used}), so it did not look the package up`;
    if (setting.composer.kind === 'packagist-off') {
      return finding(`the install would not use Packagist: ${where} turns packagist.org off, so the package comes from the other repositories it declares; ${skipped}`, fix);
    }
    if (setting.composer.kind === 'unread') {
      // Composer reads the file depcurfew skipped, with whatever repositories it declares (decision D-142).
      return finding(
        `the install may take it from a repository that ${setting.file} declares, which Composer asks before Packagist, but depcurfew did not read ${setting.file} (${setting.composer.reason}); ${skipped}`,
        `the package in the repositories that ${setting.file} may declare: depcurfew checks only Packagist (${used}) and did not read ${setting.file}, so it cannot vouch for a package from another repository`,
      );
    }
    const repository = `the ${setting.composer.type} repository${value === undefined ? '' : ` ${value}`}`;
    return finding(`the install may take it from ${repository} that ${where} declares, which Composer asks before Packagist; ${skipped}`, fix);
  }
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
      `the package in every ${what} that ${source} adds: depcurfew checks one ${what}, so it cannot vouch for a package from the others`,
    );
  }
  const scope = setting.applies === 'scope' ? ` for ${setting.scope ?? ''}` : '';
  const named = value === undefined ? `the ${what}${scope} set in ${where}, whose value depcurfew cannot read` : `the ${what}${scope} ${value} from ${where}`;
  // A scope of another registry is looked up only where --registry names it, also when the .npmrc next to
  // depcurfew.json assigns it (decision D-168), so --registry is how to have depcurfew check it.
  const remedy = `pass ${python ? '--index' : '--registry'} ${value ?? '<its URL>'} ${options}`;
  const checked = notLookedUp(setting) ? `depcurfew asks ${used}, so it did not look the package up there` : `depcurfew checked ${used}`;
  return finding(`the install would use ${named}; ${checked}`, `the package in the ${what} that ${source} names; if you trust that ${what}, ${remedy}`);
}

/** Where a setting is written, for messages: the file and the line, or the variable of the environment (decision D-168). */
function whereOf(setting: UnreadSetting): string {
  return setting.variable === undefined ? `${setting.file} (line ${setting.line})` : `${setting.variable} in the environment`;
}

/**
 * Whether a setting that points the install elsewhere keeps a package from being looked up at all (decision D-168): a
 * scope registry, and a registry or index of the machine (the environment, a user or global file), so that a private
 * name does not reach a registry the install does not use. Settings that add a place to install from leave the lookup,
 * as the install asks the default index too.
 */
function notLookedUp(setting: UnreadSetting): boolean {
  return setting.effect === 'replaces' && (setting.applies === 'scope' || (setting.machine === true && setting.applies === 'all'));
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
  const where = whereOf(setting);
  const value = setting.value === undefined ? '' : ` ${setting.value}`;
  if (setting.composer !== undefined) {
    if (setting.composer.kind === 'packagist-off') return `${absent}, and ${where} turns packagist.org off, so it may come from the other repositories it declares, which depcurfew did not check`;
    if (setting.composer.kind === 'unread') return `${absent}, but it may come from a repository that ${setting.file} declares, which depcurfew did not read`;
    return `${absent}, but it may come from the ${setting.composer.type} repository${value} that ${where} declares, which depcurfew did not check`;
  }
  const what = isPythonSpec(report.spec) ? 'index' : 'registry';
  if (setting.applies === 'package' && setting.pin !== undefined) {
    return `${absent}, but ${setting.pin.file} (line ${setting.pin.line}) pins it to the index${value} set in ${where}, which depcurfew did not check`;
  }
  const scope = setting.applies === 'scope' ? ` for ${setting.scope ?? ''}` : '';
  const source = setting.effect === 'adds' ? (setting.value === undefined ? `the places that ${where} adds` : `the ${what}${value} that ${where} adds`) : `the ${what}${scope}${value} set in ${where}`;
  return `${absent}, but it may come from ${source}, which depcurfew did not check`;
}

/** The tools of the npm ecosystem other than npm and of Python whose registry or index the machine may set (decision D-168). */
const MACHINE_TOOLS: ReadonlySet<ToolId> = new Set(['pnpm', 'yarn', 'bun', 'pip', 'uv', 'pdm', 'pipenv', 'poetry']);

/**
 * The settings of a tool's own configuration files for the requests of a command, read once per tool, and those of the
 * root composer.json for Composer packages, also without a command (decision D-133); and those of the machine for each
 * tool, pip's for Python packages no command names a tool for (decision D-168), in the order the tools take them, as
 * the first setting that applies names a package's finding: the variables of the environment, the files of the
 * project, the user files.
 */
function toolSettings(requests: readonly CheckRequest[], applied: Pick<AppliedPolicy, 'start' | 'top' | 'machine'>, composer: ComposerProject | undefined): { unread: UnreadSetting[]; skipped: SkippedFile[] } {
  const tools = [...new Set(requests.map((request) => request.tool).filter((tool): tool is ToolId => tool !== undefined && hasRegistrySettings(tool)))];
  const machineTools = [
    ...new Set(requests.flatMap((request) => (request.tool !== undefined ? [request.tool] : isPythonSpec(request.spec) ? ['pip' as const] : [])).filter((tool) => MACHINE_TOOLS.has(tool))),
  ];
  const machine = machineTools.map((tool) => machineToolSettings(tool, applied.start, applied.machine.home, applied.machine.environment));
  const found = [...tools.map((tool) => toolRegistrySettings(tool, applied.start, applied.top)), ...(composer === undefined ? [] : [composer])];
  const variables = machine.flatMap((entry) => entry.unread.filter((setting) => setting.variable !== undefined));
  const files = machine.flatMap((entry) => entry.unread.filter((setting) => setting.variable === undefined));
  return { unread: [...variables, ...found.flatMap((entry) => entry.unread), ...files], skipped: [...found, ...machine].flatMap((entry) => entry.skipped) };
}

/** Composer's command names (extra.commandNames), for the words the scripts of composer.json may change (decision D-136). */
function composerCommandNames(): CommandNamesKnowledge | undefined {
  const composer = knowledgeBase.find((tool) => tool.id === 'composer');
  const fact = composer?.extra?.['commandNames'];
  return fact === undefined ? undefined : (values(fact)[0] as CommandNamesKnowledge | undefined);
}

/** Whether a word Composer resolved stands for the command it was read as. */
function isCommand(found: FoundCommand | undefined, command: string): boolean {
  return found?.kind === 'command' && found.name === command;
}

/**
 * The scripts of composer.json as the Composer versions the hook cannot tell apart register them: with their aliases
 * (scripts-aliases, read since the version extra.scriptAliases gives), and without them as before that version.
 */
function scriptReadings(scripts: ScriptCommands): ScriptCommands[] {
  const composer = knowledgeBase.find((tool) => tool.id === 'composer');
  const since = composer?.extra?.['scriptAliases'] === undefined ? undefined : values(composer.extra['scriptAliases'])[0];
  if (since === undefined || scripts.scripts.every((script) => script.aliases.length === 0)) return [scripts];
  return [scripts, { scripts: scripts.scripts.map((script) => ({ ...script, aliases: [] })) }];
}

/**
 * The requests of a Composer command as the root composer.json makes them: a command word that, with the scripts of
 * composer.json registered as commands, no longer stands for the command it was read as (a script, which runs as
 * composer run-script does, or an ambiguous word) installs nothing of its own (decision D-136); composer update without
 * a constraint (fromManifest) gets the constraint the root composer.json requires, and a package it does not require
 * is left out, as composer update picks its version within what the packages that require it allow, which depcurfew
 * does not know (decision D-133).
 */
function withManifestConstraints(requests: readonly CheckRequest[], composer: ComposerProject | undefined): CheckRequest[] {
  const names = composer?.scripts === undefined ? undefined : composerCommandNames();
  // A parent's composer.json may not apply, and then Composer registers no scripts (decision D-142).
  const readings = composer?.scripts === undefined ? [] : [...scriptReadings(composer.scripts), ...(composer.inParent === true ? [{ scripts: [] }] : [])];
  return requests.flatMap((request): CheckRequest[] => {
    const word = request.composerCommand;
    // The word installs nothing of its own only when it is not the command in any reading (decision D-138).
    if (word !== undefined && names !== undefined && !readings.some((scripts) => isCommand(findComposerCommand(names, word.word, scripts), word.command))) return [];
    if (request.fromManifest !== true) return [request];
    const name = request.spec.trim().slice(COMPOSER_PREFIX.length).toLowerCase();
    // A composer.json depcurfew did not read may require it: the package is reported as not checked (decision D-142).
    if (request.readsManifest !== false && composer?.unreadable === true) {
      const { fromManifest: _fromManifest, ...rest } = request;
      return [{ ...rest, spec: `${COMPOSER_PREFIX}${name}` }];
    }
    const constraint = request.readsManifest === false ? undefined : composer?.requires.get(name);
    if (constraint === undefined) return [];
    const { fromManifest: _fromManifest, ...rest } = request;
    return [{ ...rest, spec: `${COMPOSER_PREFIX}${name}:${constraint}` }];
  });
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
  /** --osv: the versions picked are looked up in OSV.dev too (decision D-129); nothing is sent to it without. */
  osv?: boolean;
  /**
   * The local OSV.dev data (decision D-150): without --osv the versions picked are looked up in it; with --osv it
   * answers only for the versions api.osv.dev did not answer for.
   */
  local?: OsvLocalLookup;
}

/**
 * Checks the requests against the policy and, when there is one, the nearer policy too, sharing each lookup between
 * them (decision D-113); then marks the packages a registry setting depcurfew did not take applies to. `skipped`
 * lists the configuration files that were not read.
 */
export async function checkApplied(given: readonly CheckRequest[], applied: AppliedPolicy, settings: RunSettings): Promise<{ reports: PackageReport[]; skipped: SkippedFile[] }> {
  const lookups: LookupCache = settings.lookups ?? new Map();
  const composer = given.some((request) => isComposerSpec(request.spec)) ? composerProject(applied.start, applied.top) : undefined;
  const asked = withManifestConstraints(given, composer);
  // The stability of a parent's composer.json may not apply: each Composer package that reads it is checked once more
  // at the stability stable, and the stricter answer counts (decision D-142).
  const again = composer?.inParent === true && composer.stability !== undefined ? asked.flatMap((request, index) => (isComposerSpec(request.spec) && request.readsManifest !== false ? [index] : [])) : [];
  const requests = [...asked, ...again.map((index): CheckRequest => ({ ...(asked[index] as CheckRequest), rootStability: false }))];
  const tools = toolSettings(requests, applied, composer);
  const unread = [...applied.unread, ...tools.unread];
  // npm takes the registry of a package's scope wherever it is set, so a registry of every package does not reach the
  // packages of a scope that has one (pickRegistry in npm-registry-fetch; decision D-168).
  const scoped = new Set([...applied.scopes.keys(), ...unread.flatMap((setting) => (setting.applies === 'scope' && setting.scope !== undefined ? [setting.scope] : []))]);
  const ownRegistry = (name: string) => scopeOf(name) !== '' && scoped.has(scopeOf(name));
  const options = (policy: ResolvedPolicy) => ({
    policy,
    fetch: settings.fetch,
    now: settings.now,
    registry: applied.registry.url,
    // The popular names of the knowledge base, the same a program gets from defaultPopularNames (decision D-182).
    ...defaultPopularNames(),
    scopeRegistries: applied.scopes,
    scopeWhere: applied.scopeWhere,
    lookups,
    // A scope whose registry is set elsewhere, to another registry than depcurfew would ask, is not looked up; nor is a
    // Composer package when the root composer.json declares another repository (decision D-136).
    // A registry or index of the machine that replaces the one depcurfew asks keeps the package from being looked up as
    // well (decision D-168), for npm packages and for Python packages of the tool that reads it (pip without a tool).
    skipLookup: (name: string, tool: ToolId | undefined, request?: Omit<CheckRequest, 'spec'>) =>
      isComposerSpec(name)
        ? request?.readsManifest !== false && unread.some((setting) => setting.tool === 'composer')
        : isPythonSpec(name)
          ? unread.some((setting) => notLookedUp(setting) && setting.tool === (tool ?? 'pip') && changesTheCheck(setting, applied.index))
          : unread.some(
              (setting) =>
                notLookedUp(setting) &&
                (setting.applies === 'all' ? !ownRegistry(name) : setting.scope === scopeOf(name)) &&
                (setting.tool === 'npm' || setting.tool === tool) &&
                readsSetting(setting, request ?? { ...(tool === undefined ? {} : { tool }) }) &&
                changesTheCheck(setting, (setting.scope === undefined ? undefined : applied.scopes.get(setting.scope)) ?? applied.registry.url),
            ),
    ...(composer?.stability === undefined || composer.file === undefined ? {} : { composerStability: { ...composer.stability, file: composer.file } }),
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
    // One finding per package: the first setting that applies to it, a registry of its scope before one of every
    // package, as npm takes the scope's for it wherever each is set (decision D-168).
    const applies = (candidate: UnreadSetting) =>
      appliesTo(candidate, report, request) &&
      changesTheCheck(candidate, usedFor(candidate, report, applied)) &&
      !(candidate.applies === 'all' && candidate.composer === undefined && !isPythonSpec(report.spec) && ownRegistry(report.name ?? ''));
    const setting = unread.find((candidate) => candidate.applies === 'scope' && applies(candidate)) ?? unread.find(applies);
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
  // Known malicious versions do not depend on the policy: looked up once, after the policies are merged.
  if (settings.osv === true) await addOsvFindings(reports, { fetch: settings.fetch, signal: settings.signal, lookups, local: settings.local });
  else if (settings.local !== undefined) addLocalOsvFindings(reports, settings.local);
  return { reports: withStableReadings(reports, asked.length, again, composer?.file), skipped: [...applied.skipped, ...tools.skipped] };
}

/**
 * The reports of the requests, with the findings of their second reading at the stability stable (`again`, in the
 * order of the reports after the first `count`) that their own reading does not have, said to be about that reading:
 * the stricter answer counts, as for two policies (decision D-142).
 */
function withStableReadings(reports: readonly PackageReport[], count: number, again: readonly number[], file: string | undefined): PackageReport[] {
  const own = reports.slice(0, count);
  if (again.length === 0) return own;
  const stable = own.map((report) => ({ ...report, findings: [] as CheckFinding[] }));
  again.forEach((index, position) => {
    const second = reports[count + position];
    if (second !== undefined && stable[index] !== undefined) stable[index].findings = second.findings;
  });
  const merged = mergedReports(own, stable, POLICY_FILE);
  return merged.map((report, index) => {
    const added = new Set(report.findings.filter((finding) => !(own[index]?.findings ?? []).includes(finding)));
    if (added.size === 0) return report;
    const note = ` (at the stability stable, which Composer uses when it does not take ${file ?? 'composer.json'} from a parent directory)`;
    return { ...report, findings: report.findings.map((finding) => (added.has(finding) ? { ...finding, message: `${finding.message}${note}` } : finding)) };
  });
}

/** What to say about a configuration file that was not read. */
function skippedNotice(skipped: SkippedFile): string {
  if (skipped.notice !== undefined) return skipped.notice;
  const name = skipped.file.split('/').at(-1);
  const what = name === '.npmrc' ? 'its registry settings, if any, were not used' : name === 'composer.json' ? 'the repositories it may declare were not looked at' : 'the registry it may set was not looked at';
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
  // Known malicious versions come first (decision D-155): every spec of the command that names an exact version is
  // looked up in the local OSV.dev data before anything can answer early, without the network, also with --osv.
  let listed: PackageReport[] = [];
  let local: LocalOsvData | undefined;
  /** Why specs past the most that are looked up in the local data were not, which every answer says (decision D-160). */
  let unlisted: string | undefined;
  const dataNotes = (checked: readonly PackageReport[]) =>
    flags.osv === true || local === undefined ? [] : localDataNotices(local, checkedEcosystems(checked), dependencies.now(), 'agent').map((notice) => `${notice.message}. ${notice.fix}`);
  /** When depcurfew cannot check the command: deny for a listed version, with why the rest was not checked, else ask. */
  const cannotCheckAll = (text: string): HookDecision =>
    listed.length === 0
      ? { decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(text)}${unlisted === undefined ? '' : `\n- ${reasonText(unlisted)}. Fix: ${unreadableFix(unlisted)}`}` }
      : decide(listed, unlisted, [`depcurfew cannot check the rest of this command: ${text}`], dataNotes(listed));
  try {
    const requested = requestedSpecs(event.command, event.shell, (dependencies.platform?.() ?? process.platform) === 'win32');
    const { specs, unreadable, overrides, listable } = requested;
    unlisted = requested.unlisted;
    if (specs.length === 0 && unreadable === undefined && overrides.length === 0) return EXIT_OK;
    local = localOsvData(dependencies);
    listed = listedReports(listable, local);
    const cwd = resolve(flags.dir ?? event.cwd ?? process.cwd());
    const projectDir = flags.dir === undefined ? (dependencies.projectDir ?? (() => process.env[projectDirVariable()]))() : undefined;
    const root = hookPolicyStart(cwd, projectDir);
    const base = root.project ?? root.start;
    // The project an install directory is judged against (decision D-118): CLAUDE_PROJECT_DIR when the working
    // directory lies in it, else the directory of the policy that applies there, its repository or itself.
    const project = root.project ?? realPathOfAny(findPolicyDirectory(cwd) ?? repositoryRoot(cwd) ?? cwd);
    const common = { registry: flags.registry, index: flags.index, home: dependencies.home?.() ?? homedir(), base, machine: machineOf(dependencies) };
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
      io.stdout(formatDecision(cannotCheckAll(text)) ?? '');
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
        // OSV.dev is asked once for the whole command, after every directory is checked (decision D-129).
        const settings: RunSettings = { fetch: dependencies.fetch, now: dependencies.now(), scriptBodies: false, index: flags.index, lookups };
        const checked = await checkApplied(requests, applied, settings);
        // The lookups are shared, so the packages are looked up once; the stricter answer counts.
        const also = working === undefined ? undefined : await checkApplied(requests, working.applied, settings);
        const delays = working === undefined ? undefined : { own: delayOf(policiesOf(applied)), other: delayOf(policiesOf(working.applied)) };
        reports.push(...(also === undefined ? checked.reports : mergedReports(checked.reports, also.reports, POLICY_FILE, delays)));
        for (const file of [...checked.skipped, ...(also?.skipped ?? [])]) if (!skipped.some((known) => known.file === file.file && known.reason === file.reason)) skipped.push(file);
        // Say which registry answered when it is not the public one, if an npm package was looked up there.
        const lookedUp = checked.reports.some(
          (report) => report.kind === 'registry' && !isPythonSpec(report.spec) && !isComposerSpec(report.spec) && report.name !== undefined && !applied.scopes.has(scopeOf(report.name)),
        );
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
    // Known malicious versions, once for the whole command: from api.osv.dev with --osv, else from the local OSV.dev
    // data (decision D-150), whose age the agent hears about in the context. Then the listed versions that were not
    // checked or got no version from the registry (decision D-155).
    if (flags.osv === true) await addOsvFindings(reports, { fetch: dependencies.fetch, lookups, local });
    else addLocalOsvFindings(reports, local);
    addListedVersions(reports, listed);
    const warned = [...skipped.map(skippedNotice), ...dataNotes([...reports, ...listed])];
    const doubts = [unreadable ?? doubt, unlisted].filter((reason): reason is string => reason !== undefined);
    io.stdout(formatDecision(decide(reports, doubts, [...new Set(notes)], warned)) ?? '');
  } catch (error) {
    io.stdout(formatDecision(cannotCheckAll(messageOf(error))) ?? '');
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
    machine: machineOf(dependencies),
    fetch: dependencies.fetch,
    now: dependencies.now(),
    ...(flags.osv === true ? { osv: true } : {}),
    local: localOsvData(dependencies),
  });
  const { document } = outcome;
  const code = outcome.status === 'directory-error' ? EXIT_USAGE : outcome.status === 'policy-error' || failedCheck(document) ? EXIT_FAILURE : EXIT_OK;
  if (flags.json) {
    io.stdout(`${safeJson(document, 2)}\n`);
    return code;
  }
  // Nothing is checked without a directory or with a policy that cannot be used, except the versions the local OSV.dev
  // data lists (decision D-155).
  for (const error of document.errors) reportInputError(error, io);
  // Each notice starts with its level and ends with its code, as in doctor; what to do follows on its own line.
  const colors = paint(io.colors?.stderr);
  for (const notice of document.notices) {
    const level = notice.level === 'warning' ? 'warning:' : colors.cyan('note:');
    io.stderr(`${level} ${printable(notice.message)} ${colors.dim(`(${notice.code})`)}\n`);
    if (notice.fix !== undefined) io.stderr(`  ${colors.green('fix:')} ${printable(notice.fix)}\n`);
  }
  if (outcome.status !== 'checked' && document.packages.length === 0) return code;
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
  /** The machine whose registry and index settings count (decision D-168); this process's when left out. */
  machine?: MachineEnvironment;
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
  /** --osv: the versions picked are looked up in OSV.dev too (decision D-129). */
  osv?: boolean;
  /**
   * The local OSV.dev data of depcurfew osv update (decision D-150): without --osv the versions picked are looked up in
   * it, and a note or warning says when it is old.
   */
  local?: LocalOsvData;
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
 * doctor (decision D-116): the level, a note, or a warning for local OSV.dev data older than 30 days (decision D-150); a
 * code; the file (and line) it concerns, when one does; the message; and what to do, when there is something to do
 * (decision D-118).
 */
export interface CheckNotice {
  level: 'note' | 'warning';
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

/**
 * The notices about the local OSV.dev data the reports were looked up in (decision D-150): when it is old or cannot be
 * read; none with --osv.
 */
export function localNotices(local: LocalOsvData | undefined, reports: readonly PackageReport[], now: Date, options: { osv?: boolean | undefined; audience?: 'person' | 'agent' | undefined } = {}): CheckNotice[] {
  if (local === undefined || options.osv === true) return [];
  return localDataNotices(local, checkedEcosystems(reports), now, options.audience).map((entry): CheckNotice => ({
    level: entry.level,
    code: entry.code,
    location: { file: entry.file },
    message: entry.message,
    fix: entry.fix,
  }));
}

/** Checks the packages as depcurfew check does and returns the document of check --json. */
export async function checkDocument(specs: readonly string[], settings: CheckSettings): Promise<CheckOutcome> {
  // Known malicious versions come first (decision D-155): the exact versions of the specs, looked up in the local
  // OSV.dev data without the network, are reported also when nothing else is checked.
  const listed = settings.local === undefined ? [] : listedReports(specs, settings.local);
  const data = (reports: readonly PackageReport[]) => localNotices(settings.local, reports, settings.now, { osv: settings.osv, audience: settings.audience });
  // Only they are looked up then, so the specs past the most that are looked up in the local data are not (decision D-160).
  const distinct = settings.local === undefined ? 0 : new Set(specs).size;
  const unlisted: CheckNotice[] =
    distinct > MAX_LISTED_SPECS
      ? [
          {
            level: 'warning',
            code: 'too-many-packages',
            message: `the check names ${distinct} package specs, and only the first ${MAX_LISTED_SPECS} could be looked up in the local OSV.dev data`,
            fix: `Check the packages in groups of at most ${MAX_LISTED_SPECS}`,
          },
        ]
      : [];
  // The same error shape as apply --json; nothing else is checked without a directory or with a policy that cannot be used.
  const failed = (status: 'directory-error' | 'policy-error', policy: string | null, error: InputError): CheckOutcome => ({
    status,
    document: { schemaVersion: 1, policy, packages: listed, notices: [...unlisted, ...data(listed)], errors: [error] },
  });
  const target = checkDirectory(settings.dir, settings.cwd);
  if (!target.ok) return failed('directory-error', null, target.error);
  const result = appliedPolicy(target.directory, {
    registry: settings.registry,
    index: settings.index,
    home: settings.home,
    ...(settings.machine === undefined ? {} : { machine: settings.machine }),
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
    ...(settings.osv === true ? { osv: true } : {}),
    ...(settings.local === undefined ? {} : { local: settings.local }),
  });
  addListedVersions(reports, listed);
  const npm = specs.some((spec) => !isPythonSpec(spec) && !isComposerSpec(spec));
  // Without --osv the versions were looked up in the local OSV.dev data: say when it is old or cannot be read.
  const notices = [...policyNotices(applied, npm, { ...(settings.audience === undefined ? {} : { audience: settings.audience }), skipped }), ...data([...reports, ...listed])];
  return { status: 'checked', document: { schemaVersion: 1, policy: applied.file, packages: reports, notices, errors: [] } };
}
