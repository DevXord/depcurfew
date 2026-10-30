// The facts the detector needs, read from the knowledge base. Where official sources disagree, file names are
// combined from every variant, so detection never misses a file because of a disputed fact.
import { isRecord } from '../apply/facts.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type {
  Ecosystem,
  EnvironmentKnowledge,
  Fact,
  RuntimeOrTool,
  SetupActionKnowledge,
  ToolId,
  ToolKnowledge,
  Versioned,
  WorkspaceDeclaration,
} from '../knowledge/types.ts';
import type { BotId, PackageManagerId } from './types.ts';

/** Where a tool's own configuration requires a version of the tool: a key path in a TOML file. */
export interface RequiredVersionFacts {
  file: string;
  path: string[];
}

export interface ManagerFacts {
  id: PackageManagerId;
  ecosystem: Ecosystem;
  lockfiles: string[];
  manifests: string[];
  /** The tool's own configuration files, without package.json and .npmrc. */
  configFiles: string[];
  /** `null` when the tool has no workspaces. */
  workspaces: (WorkspaceDeclaration & { objectKey: string | null }) | null;
  /** The pyproject.toml table that marks a project of this tool (Python tools only). */
  pyprojectTable: string | null;
  requiredVersions: RequiredVersionFacts[];
  /** The configuration files in the order the tool picks one, using only the first that exists (uv); `null` otherwise. */
  configFileOrder: string[] | null;
  /** Lockfiles with a name of the project's choosing, such as pylock.dev.toml; `null` when the names are fixed. */
  lockfilePattern: RegExp | null;
}

export interface BotFacts {
  id: BotId;
  configFiles: string[];
  packageJsonKey: string | null;
}

export interface DetectionFacts {
  managers: ManagerFacts[];
  /** The project file of Python projects (pyproject.toml). */
  pythonProject: string;
  /** Hatch's table in pyproject.toml and its own file; Hatch is not configured, only pointed to uv. */
  hatch: { pyprojectTable: string; configFile: string };
  bots: BotFacts[];
  yarn: { berryMarker: string; classicHeader: string };
  packageManagerKey: string;
  devEngines: { key: string; packageManagerKey: string; runtimeKey: string };
  volta: { key: string; tools: readonly RuntimeOrTool[] };
  toolVersions: { file: string; plugins: Readonly<Record<string, RuntimeOrTool>> };
  workflows: { directory: string; extensions: readonly string[] };
  setupActions: SetupActionKnowledge[];
}

const PACKAGE_MANAGERS: readonly ToolId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'pip', 'poetry', 'pdm', 'pipenv'];
const BOTS: readonly ToolId[] = ['renovate', 'dependabot'];
/** Files several tools read; a Python tool counts the project file only when it has the tool's table. */
const SHARED_FILES = ['package.json', '.npmrc'];

function values<T>(fact: Fact<T>): T[] {
  return evidenceOf(fact).map((evidence) => evidence.value);
}

/** The value of a fact; for a disputed fact the first variant, which must agree with the others in shape. */
function first<T>(fact: Fact<T>): T {
  const [value] = values(fact);
  return value as T;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function allVersions<T>(versioned: Versioned<readonly T[]>): T[] {
  return versioned.flatMap((entry) => [...entry.value]);
}

function extraString(tool: ToolKnowledge, key: string): string {
  const fact = tool.extra?.[key];
  const value = fact === undefined ? undefined : first(fact);
  if (typeof value !== 'string') throw new Error(`knowledge base: ${tool.id} extra.${key} must be a string`);
  return value;
}

function extraValue(tool: ToolKnowledge, key: string): unknown {
  const fact = tool.extra?.[key];
  return fact === undefined ? undefined : first(fact);
}

/** required-version in [tool.uv] of pyproject.toml and at the top of uv.toml; requires-poetry in [tool.poetry]. */
function requiredVersions(tool: ToolKnowledge, pythonProject: string): RequiredVersionFacts[] {
  const required = extraValue(tool, 'requiredVersion');
  if (!isRecord(required) || typeof required['table'] !== 'string' || typeof required['key'] !== 'string') return [];
  const key = required['key'];
  const tables = extraValue(tool, 'configTables');
  const files: [string, string][] = isRecord(tables)
    ? Object.entries(tables).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    : [[pythonProject, required['table']]];
  return files.map(([file, table]) => ({ file, path: [...(table === '' ? [] : table.split('.')), key] }));
}

function workspaceFacts(declaration: WorkspaceDeclaration | null, objectKey: string | null): ManagerFacts['workspaces'] {
  return declaration === null ? null : { ...declaration, objectKey };
}

function tool(tools: readonly ToolKnowledge[], id: ToolId): ToolKnowledge {
  const found = tools.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`knowledge base: no entry for ${id}`);
  return found;
}

export function detectionFacts(tools: readonly ToolKnowledge[], environment: EnvironmentKnowledge): DetectionFacts {
  const pythonProject = first(environment.python.projectFile);
  const shared = new Set([...SHARED_FILES, pythonProject]);
  const managers = PACKAGE_MANAGERS.map((id): ManagerFacts => {
    const entry = tool(tools, id);
    const project = entry.project;
    if (project === undefined) throw new Error(`knowledge base: ${id} has no project facts`);
    const manifests = unique(values(project.manifests).flat());
    const ownConfig = values(entry.cooldown.configFiles).flat();
    const pyprojectTable = extraValue(entry, 'pyprojectTable');
    const order = extraValue(entry, 'configFileOrder');
    const pattern = extraValue(entry, 'lockfilePattern');
    return {
      id: id as PackageManagerId,
      ecosystem: entry.ecosystem ?? 'npm',
      lockfiles: unique(values(project.lockfiles).flatMap(allVersions)),
      manifests,
      configFiles: unique([...ownConfig, ...manifests]).filter((file) => !shared.has(file)),
      workspaces: workspaceFacts(first(project.workspaces), first(project.workspacesObjectKey)),
      pyprojectTable: typeof pyprojectTable === 'string' ? pyprojectTable : null,
      requiredVersions: requiredVersions(entry, pythonProject),
      configFileOrder: Array.isArray(order) && order.every((file) => typeof file === 'string') ? order : null,
      lockfilePattern: typeof pattern === 'string' ? new RegExp(pattern, 'u') : null,
    };
  });

  const bots = BOTS.map((id): BotFacts => {
    const entry = tool(tools, id);
    const packageJson = entry.extra?.['packageJsonConfig'];
    const key = packageJson === undefined ? null : (first(packageJson) as { key?: unknown }).key;
    return {
      id: id as BotId,
      configFiles: unique(values(entry.cooldown.configFiles).flat()),
      packageJsonKey: typeof key === 'string' ? key : null,
    };
  });

  const yarn = tool(tools, 'yarn');
  const actions = environment.githubActions;
  return {
    managers,
    pythonProject,
    hatch: first(environment.python.hatch),
    bots,
    yarn: { berryMarker: extraString(yarn, 'berryLockfileMarker'), classicHeader: extraString(yarn, 'classicLockfileHeader') },
    packageManagerKey: first(environment.corepack.packageManagerField).key,
    devEngines: first(environment.devEngines),
    volta: first(environment.volta.manifest),
    toolVersions: { file: first(environment.asdf.toolVersionsFile), plugins: first(environment.asdf.plugins) },
    workflows: first(actions.workflows),
    setupActions: [
      actions.setupNode,
      actions.pnpmActionSetup,
      actions.pnpmSetup,
      actions.setupBun,
      actions.setupDeno,
      actions.setupPython,
      actions.setupUv,
      actions.installPoetry,
      actions.actionsPoetry,
    ].map(first),
  };
}
