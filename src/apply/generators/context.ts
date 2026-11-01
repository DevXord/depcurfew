// What every generator gets: the tool's knowledge, the policy, the pinned version and helpers for warnings,
// version checks and the file edits. A failed edit is recorded as an error and stops only the tool that made it,
// so every broken file is reported in one run.
import { parseToml } from '../../detect/toml.ts';
import type { Duration } from '../../policy/duration.ts';
import type { ResolvedPolicy } from '../../policy/schema.ts';
import type { ToolId, ToolKnowledge } from '../../knowledge/types.ts';
import { blockStart } from '../block.ts';
import { mergesYamlKeys } from '../facts.ts';
import { writeIniBlock } from '../ini.ts';
import { jsonArrayAppend, jsonArrayRemove, jsonArrayReplace, jsonGet, jsonSet } from '../json-edit.ts';
import { writeRequirementsBlock } from '../pip-requirements.ts';
import { requirementsLongOptions } from '../../doctor/python.ts';
import { requirementsFormatOf } from '../../doctor/python-lockfiles.ts';
import { describeRequirements, type Requirement } from '../requirements.ts';
import { writeTomlBlock } from '../toml.ts';
import { compareVersions, formatVersion, parseVersion, type Version } from '../version.ts';
import type { ApplyWarning, PolicyPart } from '../warnings.ts';
import type { NpmInUse } from '../../doctor/rules/bundled-versions.ts';
import type { Workspace } from '../workspace.ts';
import { yamlGet, yamlSet, yamlSetMany } from '../yaml-edit.ts';

export interface Snippet {
  tool: ToolId;
  file: string;
  text: string;
}

/**
 * A setting a generator writes for installScripts or sources (decision D-117), for depcurfew explain. Files are
 * relative to the directory planned; `table` is the TOML table the key is written in.
 */
export interface WrittenSetting {
  tool: ToolId;
  /** The directory listed in projects; absent at the root. */
  project?: string;
  part: PolicyPart;
  setting: string;
  file: string;
  table?: string;
}

/** A setting the version is too old for, as `supports` found it; the warning version-too-old names it. */
export interface MissingSetting {
  tool: ToolId;
  project?: string;
  setting: string;
}

let recording: { written: WrittenSetting[]; missing: MissingSetting[]; keys: Set<string> } | undefined;

/**
 * Runs a plan and returns what its generators wrote for installScripts and sources and which settings were too new
 * for the version (decision D-117): explain shows them from the generators apply runs, not from a second description.
 * A generator names a setting with `writes` also when the file already holds it, so a repository apply has already
 * configured shows the same settings.
 */
export function recordSettings<T>(action: () => T): { result: T; written: WrittenSetting[]; missing: MissingSetting[] } {
  const outer = recording;
  // The settings written so far by their text, so that each one is kept once in linear time (decision D-121).
  const current = { written: [] as WrittenSetting[], missing: [] as MissingSetting[], keys: new Set<string>() };
  recording = current;
  try {
    return { result: action(), written: current.written, missing: current.missing };
  } finally {
    recording = outer;
  }
}

/** A file a generator could not read or edit; nothing is written when there is one. */
export interface EditFailure {
  tool: ToolId;
  file: string;
  message: string;
}

export interface Context {
  tool: ToolKnowledge;
  /** Every tool of the knowledge base in use, for bots that serve several package managers. */
  tools: readonly ToolKnowledge[];
  /** The tools this run configures. */
  targets: ReadonlySet<ToolId>;
  name: string;
  policy: ResolvedPolicy;
  /** undefined: no exact version is pinned, so the latest known version is assumed. */
  version: Version | undefined;
  /**
   * npm without a pin for the whole repository: the npm versions the repository runs (the npm of the declared Node.js
   * versions, npm installed in CI and Dockerfiles), for the install-script settings (decision D-105); empty otherwise.
   */
  inUse: readonly NpmInUse[];
  /** The directory listed in projects this run configures, for messages ("npm is not pinned for frontend"); absent at the root. */
  project?: string;
  /** The version as messages show it: as the tool prints it when that is known (24.0), else as major.minor.patch. */
  versionLabel: string;
  /** apply --user: blocks name the user policy, and a version that is too old is updated where it is installed. */
  user: boolean;
  workspace: Workspace;
  /** Whether the file exists; a file that cannot be read stops the generator with an error. */
  exists(file: string): boolean;
  /** The file's text (empty when missing); a file that cannot be read stops the generator with an error. */
  read(file: string): string;
  /** Reports a warning about this tool (the tool is filled in); the same warning twice is reported once. */
  warn(warning: Omit<ApplyWarning, 'tool'>): void;
  snippet(file: string, text: string): void;
  /**
   * Names a setting the generator writes for installScripts or sources, also when the file already has the value; it
   * edits nothing. depcurfew explain shows these (decision D-117).
   */
  writes(part: PolicyPart, setting: string, file: string, table?: string): void;
  /** Whether the pinned version has a setting available since `since`; when it is too old, finish() reports it. */
  supports(since: string | undefined, setting: string): boolean;
  /** The same check without a warning. */
  atLeast(since: string | undefined): boolean;
  /** Reports what the version did not support; called once the generator has run. */
  finish(): void;
  json(file: string): JsonFile;
  yaml(file: string): YamlFile;
  ini(file: string, entries: readonly string[], managedKeys: readonly string[]): void;
  /** A managed block in a TOML table ('' for the top level); `label` names the table in the marker when a file has several. */
  toml(file: string, table: string, entries: readonly string[], managedKeys: readonly string[], label?: string): void;
  /** A managed block of option lines in a pip requirements file. */
  requirements(file: string, entries: readonly string[], managedOptions: readonly string[]): void;
}

export interface JsonFile {
  get(path: readonly (string | number)[]): unknown;
  set(path: readonly (string | number)[], value: unknown): void;
  append(path: readonly (string | number)[], value: unknown): void;
  replace(path: readonly (string | number)[], index: number, value: unknown): void;
  remove(path: readonly (string | number)[], index: number): void;
}

export interface YamlFile {
  get(path: readonly (string | number)[]): unknown;
  set(path: readonly (string | number)[], value: unknown): void;
  /** Sets several values: the same result and checks as set one after another, much faster for many edits. */
  setMany(edits: readonly (readonly [readonly (string | number)[], unknown])[]): void;
}

/** A generator for a package manager returns the cooldown it wrote, in minutes, so bots can wait at least as long. */
export type ManagerGenerator = (context: Context) => number | undefined;
export type BotGenerator = (context: Context, cooldown: Duration | undefined) => void;

export class EditFailed extends Error {}

export function createContext(options: {
  tool: ToolKnowledge;
  tools: readonly ToolKnowledge[];
  targets: ReadonlySet<ToolId>;
  policy: ResolvedPolicy;
  version: Version | undefined;
  /** npm without a pin for the whole repository: the npm versions the repository runs. */
  inUse?: readonly NpmInUse[];
  project?: string;
  workspace: Workspace;
  warnings: ApplyWarning[];
  snippets: Snippet[];
  failures: EditFailure[];
  /** apply --user, with the version as the installed tool states it when it was read from its files. */
  user?: { versionText?: string };
}): Context {
  const { tool, workspace, warnings, failures } = options;
  const user = options.user !== undefined;
  const versionLabel = options.user?.versionText ?? formatVersion(options.version ?? [0, 0, 0]);
  const scope = user ? 'user' : 'project';
  const yamlOptions = { merge: mergesYamlKeys(tool) };
  const atLeast = (since: string | undefined): boolean => {
    const required = since === undefined ? undefined : parseVersion(since);
    return options.version === undefined || required === undefined || compareVersions(options.version, required) >= 0;
  };
  const unsupported: Requirement[] = [];
  const where = options.project === undefined ? {} : { project: options.project };
  const warn =(warning: Omit<ApplyWarning, 'tool'>) => {
    const { code, ...rest } = warning;
    if (!warnings.some((known) => known.code === code && known.message === warning.message)) warnings.push({ code, tool: tool.id, ...rest });
  };
  const guard = <T>(file: string, action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof EditFailed) throw error;
      // Parsers put a code frame after the first line; the first line says what is wrong.
      const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]?.replace(/:$/u, '') ?? '';
      failures.push({ tool: tool.id, file, message });
      throw new EditFailed(message);
    }
  };
  return {
    tool,
    tools: options.tools,
    targets: options.targets,
    name: tool.name,
    policy: options.policy,
    version: options.version,
    inUse: options.inUse ?? [],
    ...(options.project === undefined ? {} : { project: options.project }),
    versionLabel,
    user,
    workspace,
    exists: (file) => guard(file, () => workspace.exists(file)),
    read: (file) => guard(file, () => workspace.read(file)),
    warn,
    snippet: (file, text) => options.snippets.push({ tool: tool.id, file, text }),
    writes(part, setting, file, table) {
      if (recording === undefined) return;
      const entry: WrittenSetting = { tool: tool.id, ...where, part, setting, file, ...(table === undefined || table === '' ? {} : { table }) };
      const key = JSON.stringify(entry);
      if (recording.keys.has(key)) return;
      recording.keys.add(key);
      recording.written.push(entry);
    },
    supports(since, setting) {
      if (atLeast(since)) return true;
      if (since !== undefined) {
        unsupported.push({ setting, since });
        recording?.missing.push({ tool: tool.id, ...where, setting });
      }
      return false;
    },
    finish() {
      // One warning for every setting the version is too old for, grouped by the version that added them.
      if (unsupported.length === 0) return;
      const needed = unsupported.map((item) => item.since).reduce((a, b) => (compareVersions(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0]) >= 0 ? a : b));
      warn({
        code: 'version-too-old',
        message: `${tool.name} ${versionLabel} does not support ${describeRequirements(unsupported)}; not written`,
        // A project pins the version; on this machine the installed tool is what has to change.
        fix: user ? `Update ${tool.name} to ${needed} or later, then run depcurfew apply --user again` : `Require ${tool.name} ${needed} or later where the version is pinned`,
      });
    },
    atLeast,
    // The JSON and YAML editors parse the file before an edit and the result after it, and refuse an edit whose
    // result does not parse or changes anything besides the managed value (see expected.ts).
    json: (file) => ({
      get: (path) => guard(file, () => (workspace.exists(file) ? jsonGet(workspace.read(file), path) : undefined)),
      set: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonSet(body === '' ? '{}\n' : body, path, value))),
      append: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayAppend(body, path, value))),
      replace: (path, index, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayReplace(body, path, index, value))),
      remove: (path, index) => guard(file, () => workspace.edit(file, (body) => jsonArrayRemove(body, path, index))),
    }),
    // A tool's generator edits the tool's own files, so they are read with merge keys where its loader applies them.
    yaml: (file) => ({
      get: (path) => guard(file, () => (workspace.exists(file) ? yamlGet(workspace.read(file), path, yamlOptions) : undefined)),
      set: (path, value) => guard(file, () => workspace.edit(file, (body) => yamlSet(body, path, value, yamlOptions))),
      setMany: (edits) => guard(file, () => workspace.edit(file, (body) => yamlSetMany(body, edits, yamlOptions))),
    }),
    ini: (file, entries, managedKeys) => guard(file, () => workspace.edit(file, (body) => writeIniBlock(body, entries, managedKeys, blockStart(undefined, scope)))),
    // The block is written line by line; a file that does not parse is not edited, and the result has to parse.
    toml: (file, table, entries, managedKeys, label) =>
      guard(file, () =>
        workspace.edit(file, (body) => {
          parseToml(body);
          const edited = writeTomlBlock(body, table, entries, managedKeys, label, scope);
          parseToml(edited);
          return edited;
        }),
      ),
    requirements: (file, entries, managedOptions) =>
      guard(file, () => workspace.edit(file, (body) => writeRequirementsBlock(body, entries, managedOptions, requirementsLongOptions(requirementsFormatOf(tool))))),
  };
}
