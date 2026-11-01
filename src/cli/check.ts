// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one, up to the root of the repository), else the default policy of
// `depcurfew init`. Packages are looked up in the registry given with --registry, else the one the user's .npmrc or
// the project's .npmrc sets (the .npmrc npm reads there, when it belongs to the policy: decision D-113), else the
// public npm registry; pypi: packages in the index given with --index, else PyPI. Exit code 1 when any package breaks
// the policy or cannot be checked, 2 for a usage error such as a --dir that does not exist; in hook mode the decision
// goes to stdout as JSON and the exit code is 0.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { UserEnvironment } from '../user/locate.ts';
import type { McpProcess } from './mcp.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { checkSpecs, type CheckFinding, type CheckRequest, type PackageReport } from '../check/index.ts';
import { parseRange, parseSemver } from '../check/semver.ts';
import { parseSpec } from '../check/spec.ts';
import { isPythonSpec } from '../check/python.ts';
import { blockingExitCode, decide, formatDecision, hookEventExample, readHookEvent, reasonText, requestedSpecs, UNREAD_REGISTRY_FIX_START } from '../check/hook.ts';
import { overrideDoubt } from '../check/command.ts';
import { defaultRegistry, type FetchLike, isLinkLocal, type LookupCache } from '../check/registry.ts';
import { defaultIndex } from '../check/pypi.ts';
import { hasRegistrySettings, npmrcSettings, toolRegistrySettings, type NpmrcSettings, type SkippedFile, type UnreadSetting } from '../check/registry-settings.ts';
import { PopularNames } from '../check/similar.ts';
import { values } from '../apply/facts.ts';
import type { ToolId } from '../knowledge/types.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { popularPythonPackages } from '../knowledge/popular-python.ts';
import { normalizePythonName } from '../policy/python-names.ts';
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

/** The npm registry to ask and where it comes from; `where` is undefined for the public registry. */
function registryOf(given: string | undefined, registries: Pick<NpmrcSettings, 'registry'>): { url: string; where: string | undefined } {
  const url = given === undefined ? (registries.registry?.value ?? defaultRegistry()) : withoutCredentials(given);
  const normalized = (text: string) => text.replace(/\/+$/u, '').toLowerCase();
  if (normalized(url) === normalized(defaultRegistry())) return { url, where: undefined };
  return { url, where: given === undefined ? (registries.registry?.where ?? 'the configuration') : '--registry' };
}

/**
 * What to say about a registry other than the public one: a malicious .npmrc could name any. After a check it says
 * where packages were looked up; for explain_policy of depcurfew mcp, where check_packages looks them up.
 */
function registryNote(registry: { url: string; where: string | undefined }, when: 'checked' | 'explained' = 'checked'): string | undefined {
  if (registry.where === undefined) return undefined;
  let host = '';
  try {
    host = new URL(registry.url).hostname;
  } catch {
    // An invalid URL is reported by the lookup itself.
  }
  // A link-local registry is not asked at all (fetchSameOrigin), so the packages were not looked up there.
  if (when === 'explained') {
    return isLinkLocal(host)
      ? `check_packages would look npm packages up in ${registry.url} (${registry.where}), which depcurfew does not ask`
      : `check_packages looks npm packages up in ${registry.url} (${registry.where}), not in the public npm registry`;
  }
  return isLinkLocal(host)
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
  registry: { url: string; where: string | undefined };
  /** The Python package index pypi: packages are looked up in. */
  index: string;
  /** Registries .npmrc assigns to scopes, whose packages are not looked up. */
  scopes: ReadonlyMap<string, string>;
  /** The dist-tag .npmrc makes npm prefer. */
  tag: { value: string; where: string } | undefined;
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
}

/**
 * The policies, registry and index check uses for packages installed in `start`, an existing directory: the nearest
 * depcurfew.json from `start`, or with `project` the policies of hookPolicyStart. The .npmrc of npm's local prefix
 * counts only when it is the directory of the policy or one of its projects (without a policy: the project directory,
 * else `start`); see src/check/registry-settings.ts.
 */
export function appliedPolicy(start: string, settings: PolicySettings): AppliedPolicyResult {
  const root = settings.project === undefined ? { start } : hookPolicyStart(start, settings.project);
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
  const npmrc = npmrcSettings(start, { trusted, home: settings.home, base });
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

/**
 * The reports of the project's policy with the findings of the nearer policy that add something (decision D-113): a
 * nearer finding is left out only when the project's report of the same package has the same code at the same or a
 * more severe level, and a project finding gives way to a more severe nearer one of the same code. Nearer findings
 * name the file whose policy they break.
 */
function mergedReports(own: readonly PackageReport[], other: readonly PackageReport[] | undefined, nearerFile: string): PackageReport[] {
  if (other === undefined) return [...own];
  return own.map((report, index) => {
    const theirs = other[index]?.findings ?? [];
    const mine = report.findings.filter((finding) => !theirs.some((candidate) => candidate.code === finding.code && severity(candidate) > severity(finding)));
    const added = theirs
      .filter((finding) => !report.findings.some((candidate) => candidate.code === finding.code && severity(candidate) >= severity(finding)))
      .map((finding) => ({ ...finding, message: finding.message.split(POLICY_FILE).join(nearerFile) }));
    return { ...report, findings: [...mine, ...added] };
  });
}

/** The scope of an npm package name, with @; '' for an unscoped name. */
function scopeOf(name: string): string {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '';
}

/** Whether a registry setting the install would use, but depcurfew did not take, applies to this package. */
function appliesTo(setting: UnreadSetting, report: PackageReport, request: CheckRequest): boolean {
  if (report.kind !== 'registry' || report.name === undefined) return false;
  const python = isPythonSpec(report.spec);
  // .npmrc counts for every tool of the npm ecosystem (pnpm and Bun read it too); a tool's own file for that tool only.
  if (setting.tool === 'npm' ? python : setting.tool !== request.tool) return false;
  if (setting.applies === 'scope') return scopeOf(report.name) === setting.scope;
  if (setting.applies === 'tag') {
    // tag= chooses the version only of npm, and only for a name without a version or with a range.
    const selector = parseSpec(report.spec)?.selector?.trim() ?? '';
    return request.ignoresConfigTag !== true && request.tag === undefined && (selector === '' || (parseSemver(selector) === undefined && parseRange(selector) !== undefined));
  }
  return true;
}

/** The finding for a registry setting the install would use but depcurfew did not take (decision D-113). */
function unreadFinding(setting: UnreadSetting, report: PackageReport, applied: Pick<AppliedPolicy, 'registry' | 'index'>): CheckFinding {
  const where = `${setting.file} (line ${setting.line})`;
  const ownFile = setting.tool !== 'npm';
  const lookups = ownFile ? `depcurfew does not read the registry settings of ${setting.file.split('/').at(-1) ?? setting.file}` : `depcurfew takes .npmrc only from the directory of ${POLICY_FILE} and the directories of its projects`;
  if (setting.applies === 'tag') {
    return {
      level: 'error',
      code: 'unverified',
      message: `the install would pick the version by the dist-tag set in ${where}; depcurfew checked the version that ${report.tag ?? 'latest'} names`,
      fix: `${UNREAD_REGISTRY_FIX_START} the version that dist-tag picks; ${lookups}`,
    };
  }
  const python = isPythonSpec(report.spec);
  const what = python ? 'index' : 'registry';
  const checked = python ? applied.index : applied.registry.url;
  return {
    level: 'error',
    code: 'unverified',
    message: `the install would use the ${what}${setting.applies === 'scope' ? ` for ${setting.scope ?? ''}` : ''} from ${where}; depcurfew checked ${checked}`,
    fix: `${UNREAD_REGISTRY_FIX_START} the package in the ${what} that ${setting.file} names; ${lookups}`,
  };
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
}

/**
 * Checks the requests against the policy and, when there is one, the nearer policy too, sharing each lookup between
 * them (decision D-113); then marks the packages a registry setting depcurfew did not take applies to. `skipped`
 * lists the configuration files that were not read.
 */
export async function checkApplied(requests: readonly CheckRequest[], applied: AppliedPolicy, settings: RunSettings): Promise<{ reports: PackageReport[]; skipped: SkippedFile[] }> {
  const lookups: LookupCache = new Map();
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
    skipLookup: (name: string, tool: ToolId | undefined) => unread.some((setting) => setting.applies === 'scope' && setting.scope === scopeOf(name) && (setting.tool === 'npm' || setting.tool === tool)),
    ...(settings.index === undefined ? {} : { index: applied.index }),
    ...(applied.tag === undefined ? {} : { defaultTag: applied.tag.value }),
    ...(settings.scriptBodies === undefined ? {} : { scriptBodies: settings.scriptBodies }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  const policies = applied.nearer === undefined ? [applied.policy] : [applied.policy, applied.nearer.policy];
  const [own = [], other] = await Promise.all(policies.map((policy) => checkSpecs(requests, options(policy))));
  const reports = mergedReports(own, other, applied.nearer?.file ?? POLICY_FILE);
  for (const [index, report] of reports.entries()) {
    const request = requests[index] ?? { spec: report.spec };
    // One finding per package: the first setting that applies to it.
    const setting = unread.find((candidate) => appliesTo(candidate, report, request));
    if (setting !== undefined) report.findings.push(unreadFinding(setting, report, applied));
  }
  return { reports, skipped: [...applied.skipped, ...tools.skipped] };
}

/** What to say about a configuration file that was not read. */
function skippedNotice(skipped: SkippedFile): string {
  const what = skipped.file.split('/').at(-1) === '.npmrc' ? 'its registry settings, if any, were not used' : 'the registry it may set was not looked at';
  return `${skipped.file} was not read: ${skipped.reason}; ${what}`;
}

/** The notice that a nearer depcurfew.json applies besides the main one. */
function nearerNotice(applied: AppliedPolicy, mainName: string): string | undefined {
  if (applied.nearer === undefined) return undefined;
  return `Besides ${mainName}, ${applied.nearer.file} also applies here; the stricter answer counts`;
}

async function hook(flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  let event: ReturnType<typeof readHookEvent>;
  try {
    event = readHookEvent(await dependencies.stdin());
  } catch (error) {
    // Without the event depcurfew cannot tell what would run; this exit code blocks the call even without onFailure.
    // Claude sees stderr as the reason, so the parser's message (which may quote the input) is shown as visible text.
    const colors = paint(io.colors?.stderr);
    io.stderr(`${colors.bold(colors.red('error:'))} cannot read the hook event: ${reasonText(messageOf(error))}\n  ${colors.green('fix:')} ${unreadableEventFix()}\n`);
    return blockingExitCode();
  }
  if (event === undefined) return EXIT_OK;
  try {
    const { specs, unreadable, overrides } = requestedSpecs(event.command, event.shell);
    if (specs.length === 0 && unreadable === undefined && overrides.length === 0) return EXIT_OK;
    const cwd = resolve(flags.dir ?? event.cwd ?? process.cwd());
    const projectDir = flags.dir === undefined ? (dependencies.projectDir ?? (() => process.env[projectDirVariable()]))() : undefined;
    const root = hookPolicyStart(cwd, projectDir);
    const result = appliedPolicy(cwd, {
      registry: flags.registry,
      index: flags.index,
      home: dependencies.home?.() ?? homedir(),
      ...(projectDir === undefined ? {} : { project: projectDir }),
      base: root.project ?? root.start,
    });
    if (!result.ok) {
      // A nearer policy is named, so that the user is not pointed at the project's policy, which is fine (decision D-110).
      const { cause } = result;
      const text = result.nearer ? (cause.issues.length > 0 ? `${result.file} is invalid: ${cause.issues.join('; ')}` : `${result.file}: ${messageOf(cause)}`) : messageOf(cause);
      io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(text)}` }) ?? '');
      return EXIT_OK;
    }
    const { applied } = result;
    const { reports, skipped } = await checkApplied(specs, applied, { fetch: dependencies.fetch, now: dependencies.now(), scriptBodies: false, index: flags.index });
    // Say which registry answered when it is not the public one, if an npm package was looked up there.
    const lookedUp = reports.some((report) => report.kind === 'registry' && !isPythonSpec(report.spec) && report.name !== undefined && !applied.scopes.has(scopeOf(report.name)));
    const note = lookedUp ? registryNote(applied.registry) : undefined;
    const besides = nearerNotice(applied, `the policy of the project (${projectDirVariable()})`);
    const notes = [...(note === undefined ? [] : [`${note}.`]), ...(besides === undefined ? [] : [`${besides}.`])];
    io.stdout(formatDecision(decide(reports, unreadable ?? overrideDoubt(overrides, applied.nearer === undefined ? [applied.policy] : [applied.policy, applied.nearer.policy]), notes, skipped.map(skippedNotice))) ?? '');
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
  for (const notice of document.notices) io.stderr(`note: ${printable(notice.message)}\n`);
  io.stdout(render(document.packages, paint(io.colors?.stdout)));
  return code;
}

/** The document of check --json (and of the check_packages tool of depcurfew mcp). */
export interface CheckDocument {
  schemaVersion: 1;
  /** The depcurfew.json used, relative to the directory checked; null for the default policy. */
  policy: string | null;
  packages: PackageReport[];
  notices: { message: string }[];
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
 * What to say about the policy and the registry: the default policy is used, a nearer policy applies too, npm packages
 * are looked up in a registry other than the public one, npm prefers another dist-tag, a configuration file was not
 * read. The registry and the dist-tag only when `npm` packages are checked. For an agent, the default policy is not an
 * invitation to write depcurfew.json; `explained` says where check_packages looks packages up, in the present tense
 * (explain_policy), instead of where they were looked up.
 */
export function policyNotices(applied: AppliedPolicy, npm: boolean, options: { audience?: 'person' | 'agent'; explained?: boolean; skipped?: readonly SkippedFile[] } = {}): { message: string }[] {
  const note = registryNote(applied.registry, options.explained === true ? 'explained' : 'checked');
  const tag = applied.tag;
  const defaultPolicyNotice =
    options.audience === 'agent'
      ? `no ${POLICY_FILE} found, so the default policy of depcurfew init applies; tell the user if the project should have a policy of its own`
      : `no ${POLICY_FILE} found; checking against the default policy of depcurfew init (depcurfew init writes it)`;
  const besides = nearerNotice(applied, applied.file === null ? 'the default policy' : applied.file);
  return [
    ...(applied.file === null ? [{ message: defaultPolicyNotice }] : []),
    ...(besides === undefined ? [] : [{ message: besides }]),
    ...(npm && note !== undefined ? [{ message: note }] : []),
    ...(tag === undefined || !npm ? [] : [{ message: `npm prefers the dist-tag "${tag.value}" (${tag.where}) for packages named without a version or with a range` }]),
    ...(options.skipped ?? applied.skipped).map((skipped) => ({ message: skippedNotice(skipped) })),
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
