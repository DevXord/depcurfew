// `depcurfew doctor --user` (decision D-087): the user-level configuration of the installed tools against the user
// policy (user-config-drift), values in those files that weaken every project (user-config-weakens), files it cannot
// check (user-config-unreadable), an unusable user policy (user-policy-invalid) and environment variables that move,
// skip or override them (user-environment-overrides). Nothing is written or executed.
import { LineCounter, isMap, isScalar, type Node } from 'yaml';
import { PolicyError } from '../apply/index.ts';
import { BLOCK_END, isBlockStart } from '../apply/block.ts';
import { formatVersion, type Version } from '../apply/version.ts';
import type { ApplyWarning } from '../apply/warnings.ts';
import { YAML_MARKER } from '../apply/yaml-edit.ts';
import { iniLines } from '../doctor/settings.ts';
import type { DoctorReport, Finding, Notice, Rule } from '../doctor/types.ts';
import { parseToml, TomlDateTime, type TomlDocument, type TomlTable } from '../detect/toml.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge, UserFile, UserWeakening } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { withoutCredentials } from '../printable.ts';
import { readLimited } from '../read-limited.ts';
import { isMergePair, mergedPair, parseYamlDocument } from '../yaml-parse.ts';
import { planUserApply } from './apply.ts';
import { shownPath, userFileFor, userFilePath, type UserEnvironment } from './locate.ts';
import { userPolicyPath } from './policy-path.ts';
import { loadUserPolicy, userPolicyFix } from './policy.ts';
import { environmentOverrides } from './variables.ts';
import { findExecutable, installedVersion } from './versions.ts';

const noCheck = (): void => undefined;

export const USER_RULES: readonly Rule[] = [
  {
    id: 'user-policy-invalid',
    summary: 'The user policy does not follow the schema or cannot be read.',
    description:
      'Without a valid user policy (~/.config/depcurfew/depcurfew.json), doctor --user cannot compare the user-level configuration with it, so only the checks that need no user policy run, as when there is none.',
    help: 'Fix what the message lists, or write a new user policy with depcurfew init --user --force.',
    level: 'error',
    requiresPolicy: false,
    check: noCheck,
  },
  {
    id: 'user-config-unreadable',
    summary: 'A user-level configuration file cannot be read, parsed or edited, so depcurfew cannot check it.',
    description:
      'The package manager may still read the file (or stop on it), and its settings may weaken every project on the machine; doctor --user fails closed and reports an error instead of passing silently.',
    help: 'Fix what the message describes: invalid syntax, missing read permission, a symlink apply --user does not write through, or a file over 1 MiB.',
    level: 'error',
    requiresPolicy: false,
    check: noCheck,
  },
  {
    id: 'user-config-drift',
    summary: 'A user-level configuration file does not match the user policy.',
    description:
      'depcurfew apply --user writes the user policy (~/.config/depcurfew/depcurfew.json) into the user-level configuration of each installed tool, which protects every project on the machine that does not set the same settings itself, and npx, uvx and global installs. A file that no longer matches leaves that protection weaker than the policy.',
    help: 'Run depcurfew apply --user.',
    level: 'warning',
    requiresPolicy: true,
    check: noCheck,
  },
  {
    id: 'user-config-weakens',
    summary: 'A user-level configuration file has a value that weakens every project that does not set it itself.',
    description:
      'Settings in the user-level configuration apply to every project that does not set the same key, and some apply even then (lists that tools merge across files). A value that turns the release-age delay off, exempts packages or allows install scripts or git dependencies there weakens all of them at once, and so does a file the tool reads ahead of the user file.',
    help: 'Remove the value from the file, or set it in the policy and run depcurfew apply --user.',
    level: 'warning',
    requiresPolicy: false,
    check: noCheck,
  },
  {
    id: 'user-environment-overrides',
    summary: 'An environment variable moves, skips or overrides the user-level configuration or the policy.',
    description:
      'Package managers read settings from environment variables before their configuration files, and some variables make them read another file or none. A variable set in a shell profile or a CI runner can switch the protection off without any file showing it.',
    help: 'Unset the variable, or set it to a value the policy allows.',
    level: 'warning',
    requiresPolicy: false,
    check: noCheck,
  },
];

const MAX_FILE = 1024 * 1024;

/** A key of a user file with its value: INI keys by line (lists one value per line), TOML and YAML keys at any depth. */
interface Entry {
  /** The key; dotted keys and nested tables as separate parts. */
  path: readonly string[];
  /** INI: the [section] the key is in; undefined above the first header. */
  section?: string;
  value: unknown;
  line?: number;
  /** Inside depcurfew's managed block, or under its YAML marker. */
  managed: boolean;
}

type Read = { ok: true; entries: Entry[] } | { ok: false; message: string; line?: number; fix: string };

/** The 1-based lines between the markers of depcurfew's managed blocks (INI and TOML). */
function blockLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let open = false;
  lines.forEach((line, index) => {
    if (isBlockStart(line)) open = true;
    else if (line.trim() === BLOCK_END) open = false;
    else if (open) inside.add(index + 1);
  });
  return inside;
}

/** The key as the tool reads it: pip takes only_binary as only-binary (UserFile.underscoresAsDashes). */
function iniKey(file: UserFile, key: string): string {
  return file.underscoresAsDashes === true ? key.toLowerCase().replaceAll('_', '-') : key;
}

function iniRead(text: string, file?: UserFile): Entry[] {
  const managed = blockLines(text.split(/\r\n|\r|\n/u));
  return iniLines(text).map((entry) => ({
    path: [file === undefined ? entry.key.replace(/\[\]$/u, '') : iniKey(file, entry.key.replace(/\[\]$/u, ''))],
    ...(entry.section === undefined ? {} : { section: entry.section }),
    value: entry.value,
    line: entry.line,
    managed: managed.has(entry.line),
  }));
}

const isTable = (value: unknown): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof TomlDateTime);

function tomlRead(text: string): Entry[] {
  const document: TomlDocument = parseToml(text);
  const managed = blockLines(text.split(/\r?\n/u));
  const entries: Entry[] = [];
  const walk = (table: TomlTable, path: readonly string[]) => {
    for (const [key, value] of Object.entries(table)) {
      const at = [...path, key];
      const line = document.lineOf(at);
      entries.push({ path: at, value, ...(line === undefined ? {} : { line }), managed: line !== undefined && managed.has(line) });
      if (isTable(value)) walk(value, at);
    }
  };
  walk(document.root, []);
  return entries;
}

/** A YAML user file; with `merge` (UserFile.mergeKeys) the keys a map gets through merge keys (<<) count as its own. */
function yamlRead(text: string, merge = false): Read {
  const lineCounter = new LineCounter();
  const document = parseYamlDocument(text, lineCounter, { merge });
  const [error] = document.errors;
  if (error !== undefined) {
    const line = error.linePos?.[0].line;
    return { ok: false, message: error.message.split('\n', 1)[0] ?? 'invalid YAML', ...(line === undefined ? {} : { line }), fix: 'Fix the YAML error' };
  }
  let data: unknown;
  try {
    // An alias that expands to more than the yaml package allows (a "billion laughs" file) throws here.
    data = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch (thrown) {
    return { ok: false, message: (thrown instanceof Error ? thrown.message : String(thrown)).split('\n', 1)[0] ?? '', fix: 'Remove the YAML aliases (*name) that expand to more than the file holds' };
  }
  const lines = text.split(/\r?\n/u);
  const entries: Entry[] = [];
  const walk = (node: Node | null | undefined, value: unknown, path: readonly string[], marked: boolean) => {
    if (!isMap(node) || typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const own = new Set<string>();
    const visit = (pair: (typeof node.items)[number], key: string) => {
      const start = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
      const line = start === undefined ? undefined : lineCounter.linePos(start).line;
      // apply --user puts the marker on the line above a key it sets; the keys inside it are managed with it.
      const managed = marked || (line !== undefined && lines[line - 2]?.trim() === YAML_MARKER);
      const child = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
      entries.push({ path: [...path, key], value: child, ...(line === undefined ? {} : { line }), managed });
      walk(pair.value as Node | null, child, [...path, key], managed);
    };
    for (const pair of node.items) {
      if (!isScalar(pair.key) || isMergePair(pair)) continue;
      own.add(String(pair.key.value));
      visit(pair, String(pair.key.value));
    }
    // A key the map gets through a merge key, at the line of the merged map that sets it; the map's own keys win.
    for (const key of merge ? Object.keys(value).filter((name) => !own.has(name)) : []) {
      const found = mergedPair(document, node, key);
      if (found !== undefined) visit(found.pair, key);
    }
  };
  walk(document.contents as Node | null, data, [], false);
  return { ok: true, entries };
}

function parse(file: UserFile, text: string): Read {
  if (file.format === 'yaml') return yamlRead(text, file.mergeKeys === true);
  if (file.format === 'ini') return { ok: true, entries: iniRead(text, file) };
  try {
    return { ok: true, entries: tomlRead(text) };
  } catch (thrown) {
    const message = (thrown instanceof Error ? thrown.message : String(thrown)).split('\n', 1)[0] ?? '';
    const line = /^invalid TOML at line (\d+)/u.exec(message)?.[1];
    return { ok: false, message, ...(line === undefined ? {} : { line: Number(line) }), fix: 'Fix the TOML error' };
  }
}

/** The keys of the entry match the dotted key; `*` matches any one key (npmScopes.*.npmMinimalAgeGate). INI keys are not dotted. */
function keyMatches(file: UserFile, entry: Entry, key: string): boolean {
  if (file.format === 'ini') return entry.path.length === 1 && entry.path[0] === iniKey(file, key);
  const parts = key.split('.');
  return parts.length === entry.path.length && parts.every((part, index) => part === '*' || part === entry.path[index]);
}

function matches(value: unknown, weakening: UserWeakening, file: UserFile): boolean {
  const { values } = weakening;
  if (values !== 'any' && 'except' in values) {
    // A switch that turns a protection off: every value the tool does not read as off weakens (fail closed). INI
    // values are text, which the tools trim.
    const read = file.format === 'ini' && typeof value === 'string' ? value.trim() : value;
    return !values.except.some((off) => off === read);
  }
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDateTime) && Object.keys(value).length === 0) return false;
  if (values === 'any') return true;
  return values.some((wanted) => String(wanted) === String(value));
}

/** Keys whose values are credentials: their values are never printed. */
const SECRET_KEY = /(?:^|[:_.-])(?:_?auth(?:token)?|_?password|token|secret|username)$/iu;

/** A value as JSON; TOML integers too large for a number and TOML dates as their text. */
const json = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item instanceof TomlDateTime ? item.toString() : item));

/** A value for a message: JSON, without the credentials of URLs in it; undefined for a credential. */
function shownValue(key: string, value: unknown): string | undefined {
  if (SECRET_KEY.test(key)) return undefined;
  const text = json(value);
  return text === undefined ? undefined : withoutCredentials(text);
}

/** A key and its value for a message (key = "value"), or the key alone for credentials. */
function keyAndValue(entry: Entry): string {
  const key = entry.path.join('.');
  const value = shownValue(key, entry.value);
  return value === undefined ? key : `${key} = ${value}`;
}

/** Whether the tool reads keys of this INI section; every section counts when the knowledge base does not say. */
function readsSection(file: UserFile, entry: Entry): boolean {
  return file.format !== 'ini' || file.sections === undefined || file.sections.includes(entry.section ?? '');
}

/** The same key with the same value in depcurfew's managed content of the planned file. */
function sameAsPlanned(entry: Entry, planned: readonly Entry[] | undefined): boolean {
  if (planned === undefined) return false;
  const value = json(entry.value);
  return planned.some((other) => other.managed && other.section === entry.section && other.path.join('\0') === entry.path.join('\0') && json(other.value) === value);
}

/** The text of a read problem, as the file is shown. */
function readProblem(shown: string, read: ReturnType<typeof readLimited>, tool: ToolKnowledge): { message: string; fix: string } | undefined {
  if (read.ok || read.problem === 'missing') return undefined;
  if (read.problem === 'too-large') return { message: `${shown} is larger than 1 MiB, so depcurfew cannot check it`, fix: `Make ${shown} smaller than 1 MiB, or check its settings by hand` };
  if (read.problem === 'unreadable') {
    return {
      message: `${shown} cannot be read (${read.error.code ?? read.error.message}), so depcurfew cannot check it`,
      fix: `Make ${shown} readable for the user that runs depcurfew; ${tool.name} may read it`,
    };
  }
  return { message: `${shown} is not a regular file, so depcurfew cannot check it`, fix: `Replace ${shown} with a regular file, or remove it` };
}

export interface UserDoctorOptions {
  environment: UserEnvironment;
  versions?: Partial<Record<ToolId, Version>>;
  tools?: readonly ToolKnowledge[];
}

const SKIPPED = new Set<ApplyWarning['code']>(['version-unknown', 'no-user-config']);

export function runUserDoctor(options: UserDoctorOptions): DoctorReport & { policyFile: string } {
  const { environment } = options;
  const tools = options.tools ?? knowledgeBase;
  const findings: Finding[] = [];
  const notices: Notice[] = [];
  const notice = (message: string) => {
    if (!notices.some((known) => known.message === message)) notices.push({ message });
  };
  let policy: ResolvedPolicy | undefined;
  let status: DoctorReport['policy'] = 'valid';
  const policyFile = shownPath(userPolicyPath(environment), environment);
  try {
    policy = loadUserPolicy(environment).policy;
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    if (error.code === 'policy-missing') {
      status = 'missing';
      notice(`${error.message}: only the checks that do not need a user policy ran`);
    } else {
      status = 'invalid';
      notice(`${policyFile} cannot be used: only the checks that do not need a user policy ran`);
      findings.push({
        rule: 'user-policy-invalid',
        level: 'error',
        location: { file: policyFile },
        message: error.issues.length === 0 ? error.message : `${error.message}: ${error.issues.join('; ')}`,
        fix: userPolicyFix(error, policyFile),
      });
    }
  }

  const installed = tools.filter((tool) => tool.kind === 'package-manager' && tool.user !== undefined && findExecutable(tool.id, environment) !== undefined);
  const versions = new Map<ToolId, Version | undefined>(
    installed.map((tool) => [tool.id, options.versions?.[tool.id] ?? installedVersion(tool.id, ecosystemOfTool(tool), environment)?.version]),
  );
  const unreadable = new Set<string>();
  const reportUnreadable = (shown: string, problem: { message: string; fix: string; line?: number }) => {
    if (unreadable.has(shown)) return;
    unreadable.add(shown);
    findings.push({ rule: 'user-config-unreadable', level: 'error', location: { file: shown, ...(problem.line === undefined ? {} : { line: problem.line }) }, message: problem.message, fix: problem.fix });
  };

  // What apply --user would write: per absolute path, the planned text of the files it covers.
  const planned = new Map<string, string | undefined>();
  let tooOld: ApplyWarning[] = [];
  if (policy !== undefined) {
    const plan = planUserApply(policy, { environment, ...(options.versions === undefined ? {} : { versions: options.versions }), tools });
    const skipped = new Set(plan.report.warningDetails.filter((warning) => SKIPPED.has(warning.code)).map((warning) => warning.tool));
    const pathOf = (tool: ToolKnowledge): string | undefined => {
      const file = userFileFor(tool, versions.get(tool.id) ?? options.versions?.[tool.id]);
      return file === null ? undefined : userFilePath(file, environment);
    };
    // A file apply --user cannot edit is not planned for any tool (npm and Deno share ~/.npmrc).
    const failedPaths = new Set<string>();
    for (const failure of plan.report.failures) {
      const tool = tools.find((candidate) => candidate.id === failure.tool);
      const path = tool === undefined ? undefined : pathOf(tool);
      if (path !== undefined) failedPaths.add(path);
      const shown = path === undefined ? failure.file : shownPath(path, environment);
      const reason = failure.message.startsWith(`${failure.file} `) ? `${shown} ${failure.message.slice(failure.file.length + 1)}` : failure.message;
      reportUnreadable(shown, {
        message: `depcurfew apply --user cannot edit ${shown} for ${tool?.name ?? failure.tool} (${reason}), so it cannot be compared with the user policy (${policyFile})`,
        fix: /symlink/u.test(failure.message)
          ? 'Replace the symlink with the file it points to, so that depcurfew apply --user can write it, or add the settings of the user policy to that file by hand'
          : 'Fix what the message describes, then run depcurfew apply --user; or add the settings of the user policy by hand',
      });
    }
    for (const change of plan.report.changes) {
      if (!failedPaths.has(change.path)) planned.set(change.path, change.after);
      findings.push({
        rule: 'user-config-drift',
        level: 'warning',
        location: { file: change.file },
        message: change.before === null ? `${change.file} does not exist, so the user policy is not applied there` : `${change.file} does not match the user policy (${policyFile})`,
        fix: 'Run depcurfew apply --user --dry-run to see the difference, then depcurfew apply --user',
      });
    }
    const targets = policy.targets;
    for (const tool of installed) {
      if ((targets !== 'auto' && !targets.includes(tool.id)) || skipped.has(tool.id)) continue;
      const path = pathOf(tool);
      // A covered file without a change is planned as it is.
      if (path !== undefined && !failedPaths.has(path) && !planned.has(path)) planned.set(path, undefined);
    }
    for (const warning of plan.report.warningDetails) {
      const tool = tools.find((candidate) => candidate.id === warning.tool);
      if (warning.code === 'version-unknown' && tool !== undefined) {
        const file = userFileFor(tool, undefined);
        const path = file === null ? undefined : userFilePath(file, environment);
        const where = path === undefined ? 'its user file' : shownPath(path, environment);
        notice(
          `${tool.name}: depcurfew cannot read the installed version from its files, so depcurfew apply --user leaves ${where} alone (${tool.name} stops every command on a value its version does not understand) and doctor --user does not compare it with the user policy; pass the version with --for ${tool.id}@<version> (${tool.id} --version shows it)`,
        );
      } else if (warning.code === 'no-user-config' || warning.code === 'nothing-to-configure') {
        notice(warning.message);
      }
    }
    tooOld = plan.report.warningDetails.filter((warning) => warning.code === 'version-too-old');
  }

  const reads = new Map<string, Read | undefined>();
  /** The entries of a file, read and parsed once; undefined when it does not exist or cannot be checked (reported). */
  const entriesOf = (file: UserFile, path: string, tool: ToolKnowledge): Entry[] | undefined => {
    const key = `${file.format}\0${path}`;
    if (!reads.has(key)) {
      const shown = shownPath(path, environment);
      const read = readLimited(path, MAX_FILE);
      const problem = readProblem(shown, read, tool);
      let result: Read | undefined;
      if (problem !== undefined) reportUnreadable(shown, problem);
      else if (read.ok) {
        result = parse(file, read.bytes.toString('utf8'));
        if (!result.ok) {
          reportUnreadable(shown, {
            message: `${shown} cannot be parsed (${result.message}), so depcurfew cannot check it`,
            fix: `${result.fix}; ${tool.name} may stop on it or read settings depcurfew cannot see`,
            ...(result.line === undefined ? {} : { line: result.line }),
          });
        }
      }
      reads.set(key, result);
    }
    const result = reads.get(key);
    return result?.ok === true ? result.entries : undefined;
  };
  /** The entries of the planned text of a file apply --user covers. */
  const plannedEntries = (file: UserFile, path: string, current: readonly Entry[]): readonly Entry[] | undefined => {
    if (!planned.has(path)) return undefined;
    const text = planned.get(path);
    if (text === undefined) return current;
    const result = parse(file, text);
    return result.ok ? result.entries : undefined;
  };
  const reported = new Set<string>();
  const weakens = (tool: ToolKnowledge, shown: string, entry: Entry, message: string, fix: string) => {
    const at = `${tool.id}\0${shown}\0${entry.line ?? entry.path.join('.')}`;
    if (reported.has(at)) return;
    reported.add(at);
    findings.push({ rule: 'user-config-weakens', level: 'warning', location: { file: shown, ...(entry.line === undefined ? {} : { line: entry.line }) }, message, fix });
  };
  const orPolicy = policy === undefined ? '' : ', or put what you need into the user policy and run depcurfew apply --user';

  for (const tool of installed) {
    const user = tool.user;
    if (user === undefined) continue;
    const version = versions.get(tool.id);
    const weakening = evidenceOf(user.weakening)[0]?.value ?? [];
    // Without a version every file the tool has had is checked: the one in use is not known.
    const files = version === undefined ? (evidenceOf(user.files)[0]?.value ?? []).map((entry) => entry.value) : [userFileFor(tool, version)];
    const seen = new Set<string>();
    for (const file of files) {
      const path = file === null ? undefined : userFilePath(file, environment);
      if (file === null || path === undefined || seen.has(path)) continue;
      seen.add(path);
      const shown = shownPath(path, environment);
      const entries = entriesOf(file, path, tool);
      const plannedHere = entries === undefined ? undefined : plannedEntries(file, path, entries);
      for (const entry of entries ?? []) {
        if (!readsSection(file, entry) || sameAsPlanned(entry, plannedHere)) continue;
        for (const rule of weakening) {
          if (!keyMatches(file, entry, rule.key) || !matches(entry.value, rule, file)) continue;
          const where = entry.section === undefined ? shown : `[${entry.section}] of ${shown}`;
          const scope = /\bprojects?\b/u.test(rule.effect) ? '' : ', in every project that does not set it itself';
          weakens(tool, shown, entry, `${keyAndValue(entry)} in ${where} ${rule.effect} (${tool.name})${scope}`, `Remove ${entry.path.join('.')} from ${where}${orPolicy}`);
        }
      }
      for (const other of file.overriddenBy ?? []) {
        const otherPath = userFilePath(other, environment);
        if (otherPath === undefined) continue;
        const otherShown = shownPath(otherPath, environment);
        const otherEntries = entriesOf(other, otherPath, tool);
        const otherPlanned = otherEntries === undefined ? undefined : plannedEntries(other, otherPath, otherEntries);
        const ahead = `${tool.name} reads ${otherShown} ahead of ${shown}`;
        const read = (otherEntries ?? []).filter((entry) => readsSection(other, entry));
        for (const entry of read) {
          if (sameAsPlanned(entry, otherPlanned)) continue;
          const rule = weakening.find((candidate) => keyMatches(other, entry, candidate.key) && matches(entry.value, candidate, other));
          if (rule === undefined) continue;
          const scope = /\bprojects?\b/u.test(rule.effect) ? '' : ', in every project that does not set it itself';
          weakens(tool, otherShown, entry, `${keyAndValue(entry)} in ${otherShown} ${rule.effect} (${ahead})${scope}`, `Remove ${entry.path.join('.')} from ${otherShown}${orPolicy}`);
        }
        // A key apply --user writes into the user file: a different value in the file read ahead of it replaces it.
        const values = (entries: readonly Entry[], key: string) => entries.filter((entry) => entry.path.join('.') === key).map((entry) => String(entry.value));
        const written = (plannedHere ?? []).filter((entry) => entry.managed);
        for (const key of new Set(read.map((entry) => entry.path.join('.')))) {
          const mine = values(written, key);
          const theirs = values(read, key);
          const first = read.find((entry) => entry.path.join('.') === key);
          if (first === undefined || mine.length === 0 || (mine.length === theirs.length && mine.every((value, index) => value === theirs[index]))) continue;
          weakens(
            tool,
            otherShown,
            first,
            `${keyAndValue(first)} in ${otherShown} replaces the ${key} that depcurfew apply --user writes to ${shown} (${ahead}), so the user policy does not hold there`,
            `Remove ${key} from ${otherShown}, or give it the value in ${shown}`,
          );
        }
      }
    }
    for (const warning of tooOld.filter((candidate) => candidate.tool === tool.id)) {
      const file = userFileFor(tool, version);
      const path = file === null ? undefined : userFilePath(file, environment);
      const where = path === undefined ? 'its user file' : shownPath(path, environment);
      const shownVersion = version === undefined ? '' : ` ${formatVersion(version)}`;
      notice(
        `${warning.message.replace(/; not written$/u, '')}, so depcurfew apply --user does not write it to ${where} and the user policy does not protect ${tool.name} there; update ${tool.name}, or pass the installed version with --for ${tool.id}@<version> if${shownVersion} is not it (${tool.id} --version shows it)`,
      );
    }
  }

  // One finding per variable as it is set, with what it does for each tool that reads it.
  const overrides = environmentOverrides(environment, installed, Object.fromEntries(versions));
  for (const name of new Set(overrides.map((override) => override.name))) {
    const forName = overrides.filter((override) => override.name === name);
    const listed = forName.find((override) => !override.anyValue);
    const effects = forName.map((override) => `${override.effect} (${tools.find((tool) => tool.id === override.tool)?.name ?? override.tool})`);
    // Values matter only for variables whose weakening values the knowledge base lists; others may hold credentials.
    const subject = listed === undefined ? name : `${name}=${withoutCredentials(listed.value.trim())}`;
    const npmPassed = /^npm_config_/iu.test(name) && (environment.env['npm_execpath'] ?? '') !== '';
    findings.push({
      rule: 'user-environment-overrides',
      level: 'warning',
      location: { file: 'environment', variable: name },
      message:
        forName.length === 1
          ? `${subject} is set in the environment (${tools.find((tool) => tool.id === forName[0]?.tool)?.name ?? ''}): ${forName[0]?.effect ?? ''}`
          : `${subject} is set in the environment: ${effects.join('; ')}`,
      fix: `Unset ${name} in your shell profile or CI settings, or set it to a value the policy allows${npmPassed ? '; under npx or npm run, npm sets npm_config_* variables from the .npmrc files and flags it read' : ''}`,
    });
  }

  // Grouped by file in the order the files came up, and by line within a file; the sort is stable.
  const order = new Map<string, number>();
  for (const finding of findings) if (!order.has(finding.location.file)) order.set(finding.location.file, order.size);
  findings.sort((a, b) => (order.get(a.location.file) ?? 0) - (order.get(b.location.file) ?? 0) || (a.location.line ?? 0) - (b.location.line ?? 0));
  // Messages carry values from files and the environment: never the credentials of a URL in them.
  const clean = findings.map((finding) => ({ ...finding, message: withoutCredentials(finding.message), ...(finding.fix === undefined ? {} : { fix: withoutCredentials(finding.fix) }) }));
  return { schemaVersion: 1, policy: status, findings: clean, notices: notices.map((item) => ({ ...item, message: withoutCredentials(item.message) })), policyFile };
}
