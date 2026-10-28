// What every generator gets: the tool's knowledge, the policy, the pinned version and helpers for warnings,
// version checks and the file edits. A failed edit is recorded as an error and stops only the tool that made it,
// so every broken file is reported in one run.
import type { Duration } from '../../policy/duration.ts';
import type { ResolvedPolicy } from '../../policy/schema.ts';
import type { ToolId, ToolKnowledge } from '../../knowledge/types.ts';
import { writeIniBlock } from '../ini.ts';
import { jsonArrayAppend, jsonArrayRemove, jsonArrayReplace, jsonGet, jsonSet } from '../json-edit.ts';
import { writeTomlBlock } from '../toml.ts';
import { compareVersions, formatVersion, parseVersion, type Version } from '../version.ts';
import type { Workspace } from '../workspace.ts';
import { yamlGet, yamlSet } from '../yaml-edit.ts';

export interface Snippet {
  tool: ToolId;
  file: string;
  text: string;
}

export interface Context {
  tool: ToolKnowledge;
  name: string;
  policy: ResolvedPolicy;
  /** undefined: no exact version is pinned, so the latest known version is assumed. */
  version: Version | undefined;
  workspace: Workspace;
  warn(message: string): void;
  snippet(file: string, text: string): void;
  /** Whether the pinned version has a setting available since `since`; warns when it is too old. */
  supports(since: string | undefined, setting: string): boolean;
  /** The same check without a warning. */
  atLeast(since: string | undefined): boolean;
  json(file: string): JsonFile;
  yaml(file: string): YamlFile;
  ini(file: string, entries: readonly string[], managedKeys: readonly string[]): void;
  toml(file: string, table: string, entries: readonly string[], managedKeys: readonly string[]): void;
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
}

/** A generator for a package manager returns the cooldown it wrote, in minutes, so bots can wait at least as long. */
export type ManagerGenerator = (context: Context) => number | undefined;
export type BotGenerator = (context: Context, cooldown: Duration | undefined) => void;

export class EditFailed extends Error {}

export function createContext(options: {
  tool: ToolKnowledge;
  policy: ResolvedPolicy;
  version: Version | undefined;
  workspace: Workspace;
  warnings: string[];
  snippets: Snippet[];
  errors: string[];
}): Context {
  const { tool, workspace, warnings, errors } = options;
  const atLeast = (since: string | undefined): boolean => {
    const required = since === undefined ? undefined : parseVersion(since);
    return options.version === undefined || required === undefined || compareVersions(options.version, required) >= 0;
  };
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const guard = <T>(file: string, action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof EditFailed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${tool.name}: cannot edit ${file}: ${message}`);
      throw new EditFailed(message);
    }
  };
  return {
    tool,
    name: tool.name,
    policy: options.policy,
    version: options.version,
    workspace,
    warn,
    snippet: (file, text) => options.snippets.push({ tool: tool.id, file, text }),
    supports(since, setting) {
      if (atLeast(since)) return true;
      warn(`${tool.name} ${formatVersion(options.version ?? [0, 0, 0])} does not support ${setting} (since ${since}); not written`);
      return false;
    },
    atLeast,
    json: (file) => ({
      get: (path) => guard(file, () => (workspace.exists(file) ? jsonGet(workspace.read(file), path) : undefined)),
      set: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonSet(body === '' ? '{}\n' : body, path, value))),
      append: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayAppend(body, path, value))),
      replace: (path, index, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayReplace(body, path, index, value))),
      remove: (path, index) => guard(file, () => workspace.edit(file, (body) => jsonArrayRemove(body, path, index))),
    }),
    yaml: (file) => ({
      get: (path) => guard(file, () => (workspace.exists(file) ? yamlGet(workspace.read(file), path) : undefined)),
      set: (path, value) => guard(file, () => workspace.edit(file, (body) => yamlSet(body, path, value))),
    }),
    ini: (file, entries, managedKeys) => guard(file, () => workspace.edit(file, (body) => writeIniBlock(body, entries, managedKeys))),
    toml: (file, table, entries, managedKeys) =>
      guard(file, () => workspace.edit(file, (body) => writeTomlBlock(body, table, entries, managedKeys))),
  };
}
