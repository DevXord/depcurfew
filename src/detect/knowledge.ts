// The facts the detector needs, read from the knowledge base. Where official sources disagree, file names are
// combined from every variant, so detection never misses a file because of a disputed fact.
import { evidenceOf } from '../knowledge/facts.ts';
import type {
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

export interface ManagerFacts {
  id: PackageManagerId;
  lockfiles: string[];
  manifests: string[];
  /** The tool's own configuration files, without package.json and .npmrc. */
  configFiles: string[];
  /** `null` when the tool has no workspaces. */
  workspaces: (WorkspaceDeclaration & { objectKey: string | null }) | null;
}

export interface BotFacts {
  id: BotId;
  configFiles: string[];
  packageJsonKey: string | null;
}

export interface DetectionFacts {
  managers: ManagerFacts[];
  bots: BotFacts[];
  yarn: { berryMarker: string; classicHeader: string };
  packageManagerKey: string;
  devEngines: { key: string; packageManagerKey: string; runtimeKey: string };
  volta: { key: string; tools: readonly RuntimeOrTool[] };
  toolVersions: { file: string; plugins: Readonly<Record<string, RuntimeOrTool>> };
  workflows: { directory: string; extensions: readonly string[] };
  setupActions: SetupActionKnowledge[];
}

const PACKAGE_MANAGERS: readonly ToolId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno'];
const BOTS: readonly ToolId[] = ['renovate', 'dependabot'];
const SHARED_FILES = new Set(['package.json', '.npmrc']);

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

function workspaceFacts(declaration: WorkspaceDeclaration | null, objectKey: string | null): ManagerFacts['workspaces'] {
  return declaration === null ? null : { ...declaration, objectKey };
}

function tool(tools: readonly ToolKnowledge[], id: ToolId): ToolKnowledge {
  const found = tools.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`knowledge base: no entry for ${id}`);
  return found;
}

export function detectionFacts(tools: readonly ToolKnowledge[], environment: EnvironmentKnowledge): DetectionFacts {
  const managers = PACKAGE_MANAGERS.map((id): ManagerFacts => {
    const entry = tool(tools, id);
    const project = entry.project;
    if (project === undefined) throw new Error(`knowledge base: ${id} has no project facts`);
    const manifests = unique(values(project.manifests).flat());
    const ownConfig = values(entry.cooldown.configFiles).flat();
    return {
      id: id as PackageManagerId,
      lockfiles: unique(values(project.lockfiles).flatMap(allVersions)),
      manifests,
      configFiles: unique([...ownConfig, ...manifests]).filter((file) => !SHARED_FILES.has(file)),
      workspaces: workspaceFacts(first(project.workspaces), first(project.workspacesObjectKey)),
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
    bots,
    yarn: { berryMarker: extraString(yarn, 'berryLockfileMarker'), classicHeader: extraString(yarn, 'classicLockfileHeader') },
    packageManagerKey: first(environment.corepack.packageManagerField).key,
    devEngines: first(environment.devEngines),
    volta: first(environment.volta.manifest),
    toolVersions: { file: first(environment.asdf.toolVersionsFile), plugins: first(environment.asdf.plugins) },
    workflows: first(actions.workflows),
    setupActions: [actions.setupNode, actions.pnpmActionSetup, actions.pnpmSetup, actions.setupBun, actions.setupDeno].map(first),
  };
}
