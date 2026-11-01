// `depcurfew check [options] <package...>` and `depcurfew check --hook claude-code`. The policy is the depcurfew.json of the
// directory (or the nearest parent that has one, up to the root of the repository), else the default policy of
// `depcurfew init`. Packages are looked up in the registry given with --registry, else the one the project's or the
// user's .npmrc sets, else the public npm registry; pypi: packages in the index given with --index, else PyPI. Exit code
// 1 when any package breaks the policy or cannot be checked, 2 for a usage error such as a --dir that does not exist;
// in hook mode the decision goes to stdout as JSON and the exit code is 0.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { UserEnvironment } from '../user/locate.ts';
import type { McpProcess } from './mcp.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { checkSpecs, type PackageReport } from '../check/index.ts';
import { isPythonSpec } from '../check/python.ts';
import { blockingExitCode, decide, formatDecision, readHookEvent, reasonText, requestedSpecs } from '../check/hook.ts';
import { overrideDoubt } from '../check/command.ts';
import { defaultRegistry, type FetchLike, isLinkLocal } from '../check/registry.ts';
import { defaultIndex } from '../check/pypi.ts';
import { PopularNames } from '../check/similar.ts';
import { Repository } from '../detect/repository.ts';
import { iniEntries } from '../doctor/settings.ts';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { NpmVersionSelectionKnowledge, RegistryConfigKnowledge } from '../knowledge/types.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { popularPythonPackages } from '../knowledge/popular-python.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { findPolicyDirectory, insideRepository } from '../policy/file.ts';
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

/** A setting of an .npmrc and where it is written, for messages: registry= in .npmrc, line 3. */
interface NpmrcSetting {
  value: string;
  where: string;
}

interface Registries {
  /** The registry .npmrc sets for all packages. */
  registry: NpmrcSetting | undefined;
  /** Registries .npmrc assigns to scopes. */
  scopes: Map<string, string>;
  /** The dist-tag .npmrc makes npm prefer (tag=next). */
  tag: NpmrcSetting | undefined;
}

/** The registries and the dist-tag the user's and the project's .npmrc set (registry=url, @scope:registry=url, tag=…); the project's win. */
function npmrcRegistries(directory: string, home: string): Registries {
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  const result: Registries = { registry: undefined, scopes: new Map(), tag: undefined };
  if (npm === undefined) return result;
  const tagKey = npm.extra?.['versionSelection'] === undefined ? undefined : (values(npm.extra['versionSelection'])[0] as NpmVersionSelectionKnowledge | undefined)?.tagKey;
  const fact = extraOf(
    npm,
    'registryConfig',
    (value): value is RegistryConfigKnowledge =>
      isRecord(value) && typeof value['file'] === 'string' && typeof value['userFile'] === 'string' && typeof value['key'] === 'string' && typeof value['scopeKeySuffix'] === 'string',
  );
  let user = '';
  try {
    user = readFileSync(join(home, fact.userFile.replace(/^~[/\\]/u, '')), 'utf8');
  } catch {
    // No user configuration.
  }
  const files = [
    { text: user, file: fact.userFile },
    { text: new Repository(directory).readText(fact.file) ?? '', file: fact.file },
  ];
  for (const { text, file } of files) {
    for (const { key, value, line } of iniEntries(text)) {
      const where = `${key}= in ${file}, line ${line}`;
      // A user name and password in a registry URL are neither sent (fetch refuses them anyway) nor shown.
      if (key === fact.key) result.registry = { value: withoutCredentials(value), where };
      else if (tagKey !== undefined && key === tagKey) result.tag = { value, where };
      else if (key.startsWith('@') && key.endsWith(fact.scopeKeySuffix)) result.scopes.set(key.slice(0, -fact.scopeKeySuffix.length), withoutCredentials(value));
    }
  }
  return result;
}

/** The npm registry to ask and where it comes from; `where` is undefined for the public registry. */
function registryOf(given: string | undefined, registries: Registries): { url: string; where: string | undefined } {
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

function load(start: string, home: string): { policy: ResolvedPolicy; file: string | undefined; registries: Registries } {
  const directory = findPolicyDirectory(start);
  const policy = directory === undefined ? undefined : loadPolicyIfPresent(directory);
  return {
    policy: policy ?? defaultPolicy(),
    file: directory === undefined ? undefined : join(directory, POLICY_FILE),
    registries: npmrcRegistries(directory ?? resolve(start), home),
  };
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

/** What to do about a hook event that cannot be read: what Claude Code sends, and how to run the hook. */
const UNREADABLE_EVENT_FIX =
  'Claude Code sends the PreToolUse event as one JSON object on stdin, at most 1 MiB: run depcurfew check --hook claude-code as a PreToolUse command hook (see the README), or pipe such an event into it to try it, e.g. {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm install lodash"},"cwd":"."}';

/** The variable Claude Code sets for hooks to the project root, from the knowledge base. */
function projectDirVariable(): string {
  return values(environment.claudeCode.sessionStart)[0]?.projectDirVariable ?? 'CLAUDE_PROJECT_DIR';
}

/**
 * Where the hook looks for depcurfew.json (decisions D-108, D-109). Claude's working directory can be anywhere in the
 * project, also in a vendored clone with its own .git or a package folder that ships a depcurfew.json allowing
 * everything, or in a nested repository with a stricter policy of its own. When the project root (by its real path)
 * lies in a git repository and the working directory is inside it, the project's policy applies, and a different
 * policy nearer the working directory is applied too (`also`): the stricter answer counts, so a planted policy cannot
 * relax the check and a nested one still tightens it. A project root outside any repository (a folder that holds
 * several repositories) keeps the lookup from the working directory.
 */
export function hookPolicyStart(cwd: string, projectDir: string | undefined): { start: string; also?: string } {
  if (projectDir === undefined || projectDir === '' || !isAbsolute(projectDir)) return { start: cwd };
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const project = real(projectDir);
  const here = real(cwd);
  if (!isInside(project, here) || !insideRepository(project)) return { start: cwd };
  const nearest = findPolicyDirectory(here);
  const own = findPolicyDirectory(project);
  return nearest === undefined || nearest === own ? { start: project } : { start: project, also: nearest };
}

async function hook(flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  let event: ReturnType<typeof readHookEvent>;
  try {
    event = readHookEvent(await dependencies.stdin());
  } catch (error) {
    // Without the event depcurfew cannot tell what would run; this exit code blocks the call even without onFailure.
    // Claude sees stderr as the reason, so the parser's message (which may quote the input) is shown as visible text.
    const colors = paint(io.colors?.stderr);
    io.stderr(`${colors.bold(colors.red('error:'))} cannot read the hook event: ${reasonText(messageOf(error))}\n  ${colors.green('fix:')} ${UNREADABLE_EVENT_FIX}\n`);
    return blockingExitCode();
  }
  if (event === undefined) return EXIT_OK;
  try {
    const { specs, unreadable, overrides } = requestedSpecs(event.command, event.shell);
    if (specs.length === 0 && unreadable === undefined && overrides.length === 0) return EXIT_OK;
    const cwd = flags.dir ?? event.cwd ?? process.cwd();
    const root = flags.dir === undefined ? hookPolicyStart(resolve(cwd), (dependencies.projectDir ?? (() => process.env[projectDirVariable()]))()) : { start: cwd };
    const loaded = load(root.start, dependencies.home?.() ?? homedir());
    const registry = registryOf(flags.registry, loaded.registries);
    // Registries always come from the project's files; only the policy of a nearer depcurfew.json is applied too.
    const nearerFile = root.also === undefined ? undefined : relative(root.start, join(root.also, POLICY_FILE)).split(sep).join('/');
    let nearer: ResolvedPolicy | undefined;
    if (root.also !== undefined) {
      try {
        nearer = load(root.also, dependencies.home?.() ?? homedir()).policy;
      } catch (error) {
        // Name the file, so that the user is not pointed at the project's policy, which is fine (decision D-110).
        if (!(error instanceof PolicyError)) throw error;
        io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(error.issues.length > 0 ? `${nearerFile ?? POLICY_FILE} is invalid: ${error.issues.join('; ')}` : `${nearerFile ?? POLICY_FILE}: ${messageOf(error)}`)}` }) ?? '');
        return EXIT_OK;
      }
    }
    const policies = nearer === undefined ? [loaded.policy] : [loaded.policy, nearer];
    const options = (policy: ResolvedPolicy) => ({
      policy,
      fetch: dependencies.fetch,
      now: dependencies.now(),
      registry: registry.url,
      popular: new PopularNames(values(popularPackages)[0] ?? []),
      popularPython: popularPython(),
      scopeRegistries: loaded.registries.scopes,
      ...(flags.index === undefined ? {} : { index: withoutCredentials(flags.index) }),
      ...(loaded.registries.tag === undefined ? {} : { defaultTag: loaded.registries.tag.value }),
      scriptBodies: false,
    });
    const [own = [], other] = await Promise.all(policies.map((policy) => checkSpecs(specs, options(policy))));
    // A finding the nearer policy shares with the project's (the same code for the same package) is shown once; the
    // others name the file whose policy they break, as the project's depcurfew.json does not say so.
    const extra = (other ?? []).map((report, index) => ({
      ...report,
      findings: report.findings
        .filter((finding) => !(own[index]?.findings ?? []).some((mine) => mine.code === finding.code))
        .map((finding) => ({ ...finding, message: finding.message.split(POLICY_FILE).join(nearerFile ?? POLICY_FILE) })),
    }));
    const reports = [...own, ...extra.filter((report) => report.findings.length > 0)];
    // Say which registry answered when it is not the public one, if an npm package was looked up there.
    const scopeOf = (name: string) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '');
    const lookedUp = reports.some((report) => report.kind === 'registry' && !isPythonSpec(report.spec) && report.name !== undefined && !loaded.registries.scopes.has(scopeOf(report.name)));
    const note = lookedUp ? registryNote(registry) : undefined;
    const notes = [
      ...(note === undefined ? [] : [`${note}.`]),
      ...(root.also === undefined
        ? []
        : [
            `Besides ${loaded.file === undefined ? `the default policy (the project has no ${POLICY_FILE})` : `the policy of the project (${projectDirVariable()})`}, ${reasonText(nearerFile ?? POLICY_FILE)} also applies here; the stricter answer counts.`,
          ]),
    ];
    io.stdout(formatDecision(decide(reports, unreadable ?? overrideDoubt(overrides, policies), notes)) ?? '');
  } catch (error) {
    io.stdout(formatDecision({ decision: 'ask', reason: `depcurfew cannot check this command: ${reasonText(messageOf(error))}` }) ?? '');
  }
  return EXIT_OK;
}

export async function check(specs: readonly string[], flags: CheckFlags, io: CliIo, dependencies: CheckDependencies): Promise<number> {
  if (flags.hook !== undefined) {
    if (!(HOOKS as readonly string[]).includes(flags.hook)) {
      io.stderr(`depcurfew: unknown hook '${flags.hook}'; supported: ${HOOKS.join(', ')}\nRun 'depcurfew check --help' for usage.\n`);
      return EXIT_USAGE;
    }
    if (specs.length > 0) {
      io.stderr("depcurfew: '--hook' reads the command from stdin and takes no packages\nRun 'depcurfew check --help' for usage.\n");
      return EXIT_USAGE;
    }
    return hook(flags, io, dependencies);
  }
  if (specs.length === 0) {
    io.stderr("depcurfew: 'check' needs at least one package, e.g. depcurfew check lodash@4\nRun 'depcurfew check --help' for usage.\n");
    return EXIT_USAGE;
  }
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

/** The policy that applies to a directory: its depcurfew.json (null when there is none, which means the default policy). */
export interface AppliedPolicy {
  policy: ResolvedPolicy;
  /** The depcurfew.json used, relative to `start`; null for the default policy of depcurfew init. */
  file: string | null;
  /** The npm registry packages are looked up in, and where it comes from (undefined for the public registry). */
  registry: { url: string; where: string | undefined };
  /** The Python package index pypi: packages are looked up in. */
  index: string;
  /** Registries .npmrc assigns to scopes, whose packages are not looked up. */
  scopes: ReadonlyMap<string, string>;
  /** The dist-tag .npmrc makes npm prefer. */
  tag: { value: string; where: string } | undefined;
}

/** Where packages are looked up, which does not depend on the policy: the registry, the index, scopes and the dist-tag. */
export type Lookups = Pick<AppliedPolicy, 'registry' | 'index' | 'scopes' | 'tag'>;

/** The policy that applies, or why it cannot be used; `lookups` either way, as .npmrc and the options set them. */
export type AppliedPolicyResult = { ok: true; applied: AppliedPolicy } | { ok: false; file: string; error: InputError; lookups: Lookups };

/** The policy, registry and index check uses for packages installed in `start`, an existing directory. */
export function appliedPolicy(start: string, settings: Pick<CheckSettings, 'registry' | 'index' | 'home'>): AppliedPolicyResult {
  const directory = findPolicyDirectory(start);
  const registries = npmrcRegistries(directory ?? resolve(start), settings.home);
  const lookups: Lookups = {
    registry: registryOf(settings.registry, registries),
    index: settings.index === undefined ? defaultIndex() : withoutCredentials(settings.index),
    scopes: registries.scopes,
    tag: registries.tag,
  };
  const file = directory === undefined ? undefined : shownPath(start, join(directory, POLICY_FILE));
  let policy: ResolvedPolicy | undefined;
  try {
    policy = directory === undefined ? undefined : loadPolicyIfPresent(directory);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    const shown = file ?? POLICY_FILE;
    return { ok: false, file: shown, error: policyInputError(error, shown), lookups };
  }
  return { ok: true, applied: { policy: policy ?? defaultPolicy(), file: file ?? null, ...lookups } };
}

/**
 * What to say about the policy and the registry: the default policy is used, npm packages are looked up in a registry
 * other than the public one, npm prefers another dist-tag. The last two only when `npm` packages are checked. For an
 * agent, the default policy is not an invitation to write depcurfew.json; `explained` says where check_packages looks
 * packages up, in the present tense (explain_policy), instead of where they were looked up.
 */
export function policyNotices(applied: AppliedPolicy, npm: boolean, options: { audience?: 'person' | 'agent'; explained?: boolean } = {}): { message: string }[] {
  const note = registryNote(applied.registry, options.explained === true ? 'explained' : 'checked');
  const tag = applied.tag;
  const defaultPolicyNotice =
    options.audience === 'agent'
      ? `no ${POLICY_FILE} found, so the default policy of depcurfew init applies; tell the user if the project should have a policy of its own`
      : `no ${POLICY_FILE} found; checking against the default policy of depcurfew init (depcurfew init writes it)`;
  return [
    ...(applied.file === null ? [{ message: defaultPolicyNotice }] : []),
    ...(npm && note !== undefined ? [{ message: note }] : []),
    ...(tag === undefined || !npm ? [] : [{ message: `npm prefers the dist-tag "${tag.value}" (${tag.where}) for packages named without a version or with a range` }]),
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
  const result = appliedPolicy(target.directory, settings);
  if (!result.ok) return failed('policy-error', result.file, result.error);
  const { applied } = result;
  const { registry, tag } = applied;
  const notices = policyNotices(applied, specs.some((spec) => !isPythonSpec(spec)), settings.audience === undefined ? {} : { audience: settings.audience });
  const reports = await checkSpecs(specs, {
    policy: applied.policy,
    fetch: settings.fetch,
    now: settings.now,
    registry: registry.url,
    popular: new PopularNames(values(popularPackages)[0] ?? []),
    popularPython: popularPython(),
    scopeRegistries: applied.scopes,
    ...(settings.index === undefined ? {} : { index: applied.index }),
    ...(tag === undefined ? {} : { defaultTag: tag.value }),
    ...(settings.scriptBodies === undefined ? {} : { scriptBodies: settings.scriptBodies }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  return { status: 'checked', document: { schemaVersion: 1, policy: applied.file, packages: reports, notices, errors: [] } };
}
