// Describes a repository: package managers and the versions it pins, bots, workspaces, .npmrc files and CI
// workflows. Only reads files; facts about file names, keys and CI actions come from the knowledge base.
import { parse as parseYaml } from 'yaml';
import { environment as environmentKnowledge } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { EnvironmentKnowledge, RuntimeOrTool, ToolKnowledge } from '../knowledge/types.ts';
import { parseJsonc } from './jsonc.ts';
import { detectionFacts, type DetectionFacts, type ManagerFacts } from './knowledge.ts';
import { joinPath, Repository } from './repository.ts';
import type {
  BotInfo,
  Detection,
  Evidence,
  EvidenceKind,
  PackageManagerId,
  PackageManagerInfo,
  VersionDeclaration,
  VersionSource,
  WorkspaceInfo,
} from './types.ts';
import { readWorkflows } from './workflows.ts';
import { expandWorkspaces } from './workspaces.ts';

export type * from './types.ts';

const EVIDENCE_ORDER: readonly EvidenceKind[] = ['lockfile', 'packageManager', 'devEngines', 'config', 'ci', 'default'];
const SOURCE_ORDER: readonly VersionSource[] = ['packageManager', 'devEngines', 'volta', 'tool-versions', 'github-actions'];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

/** devEngines entries may be one object or a list of objects with a name and an optional version. */
function devEngineEntries(value: unknown): { name: string; version?: string }[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) =>
    isObject(entry) && typeof entry['name'] === 'string'
      ? [{ name: entry['name'], ...(typeof entry['version'] === 'string' ? { version: entry['version'] } : {}) }]
      : [],
  );
}

function compareVersions(a: VersionDeclaration, b: VersionDeclaration): number {
  return (
    SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return EVIDENCE_ORDER.indexOf(a.kind) - EVIDENCE_ORDER.indexOf(b.kind) || a.file.localeCompare(b.file);
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Collector {
  readonly evidence = new Map<PackageManagerId, Evidence[]>();
  readonly versions = new Map<RuntimeOrTool, VersionDeclaration[]>();

  addEvidence(manager: PackageManagerId, kind: EvidenceKind, file: string): void {
    const list = this.evidence.get(manager) ?? [];
    if (!list.some((item) => item.kind === kind && item.file === file)) list.push({ kind, file });
    this.evidence.set(manager, list);
  }

  addVersion(tool: RuntimeOrTool, declaration: VersionDeclaration): void {
    const list = this.versions.get(tool) ?? [];
    list.push(declaration);
    this.versions.set(tool, list);
  }
}

function readPackageJson(repository: Repository): Json | undefined {
  if (!repository.isFile('package.json')) return undefined;
  const parsed = repository.parse('package.json', (text) => JSON.parse(text) as unknown);
  return isObject(parsed) ? parsed : undefined;
}

function readPackageManagerField(repository: Repository, facts: DetectionFacts, manifest: Json, collector: Collector): string | undefined {
  const value = manifest[facts.packageManagerKey];
  if (value === undefined) return undefined;
  const match = typeof value === 'string' ? /^(@?[^@\s]+)@([^+\s]+)(?:\+.*)?$/u.exec(value) : null;
  if (match === null) {
    repository.warn('invalid-package-manager', `${facts.packageManagerKey} ${JSON.stringify(value)} is not in the form name@version`, ['package.json']);
    return undefined;
  }
  const [, name = '', version = ''] = match;
  const manager = facts.managers.find((entry) => entry.id === name);
  if (manager === undefined) {
    repository.warn('invalid-package-manager', `${facts.packageManagerKey} names ${name}, which depgate does not know`, ['package.json']);
    return undefined;
  }
  collector.addEvidence(manager.id, 'packageManager', 'package.json');
  collector.addVersion(manager.id, { version, source: 'packageManager', file: 'package.json' });
  return manager.id;
}

function readDevEngines(facts: DetectionFacts, manifest: Json, collector: Collector): void {
  const devEngines = manifest[facts.devEngines.key];
  if (!isObject(devEngines)) return;
  for (const entry of devEngineEntries(devEngines[facts.devEngines.packageManagerKey])) {
    const manager = facts.managers.find((item) => item.id === entry.name);
    if (manager === undefined) continue;
    collector.addEvidence(manager.id, 'devEngines', 'package.json');
    if (entry.version !== undefined) collector.addVersion(manager.id, { version: entry.version, source: 'devEngines', file: 'package.json' });
  }
  for (const entry of devEngineEntries(devEngines[facts.devEngines.runtimeKey])) {
    if (entry.name === 'node' && entry.version !== undefined) {
      collector.addVersion('node', { version: entry.version, source: 'devEngines', file: 'package.json' });
    }
  }
}

function readVolta(facts: DetectionFacts, manifest: Json, collector: Collector): void {
  const volta = manifest[facts.volta.key];
  if (!isObject(volta)) return;
  for (const tool of facts.volta.tools) {
    const version = volta[tool];
    if (typeof version === 'string') collector.addVersion(tool, { version, source: 'volta', file: 'package.json' });
  }
}

function readToolVersions(repository: Repository, facts: DetectionFacts, collector: Collector): void {
  const file = facts.toolVersions.file;
  const text = repository.isFile(file) ? repository.readText(file) : undefined;
  if (text === undefined) return;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const [plugin, version] = (raw.split('#', 1)[0] ?? '').trim().split(/\s+/u);
    const tool = plugin === undefined ? undefined : facts.toolVersions.plugins[plugin];
    if (tool !== undefined && version !== undefined) collector.addVersion(tool, { version, source: 'tool-versions', file, line: index + 1 });
  });
}

function yarnVariant(repository: Repository, facts: DetectionFacts, collector: Collector): { variant: 'berry' | 'classic'; file: string } {
  if (repository.isFile('yarn.lock')) {
    const head = repository.readHead('yarn.lock') ?? '';
    if (head.includes(facts.yarn.classicHeader)) return { variant: 'classic', file: 'yarn.lock' };
    if (new RegExp(`^${facts.yarn.berryMarker}:`, 'mu').test(head)) return { variant: 'berry', file: 'yarn.lock' };
  }
  const declared = collector.versions.get('yarn')?.find((entry) => entry.source === 'packageManager');
  if (declared !== undefined && 'version' in declared && /^1\./u.test(declared.version)) return { variant: 'classic', file: 'package.json' };
  return { variant: 'berry', file: 'package.json' };
}

function readWorkspaces(repository: Repository, facts: DetectionFacts, manifest: Json | undefined): WorkspaceInfo | null {
  const declarations: { file: string; patterns: string[] }[] = [];
  const seen = new Set<string>();
  for (const manager of facts.managers) {
    const { files, key, objectKey } = manager.workspaces;
    for (const file of files) {
      const id = `${file}#${key}`;
      if (seen.has(id) || !repository.isFile(file)) continue;
      seen.add(id);
      const document = readConfig(repository, file, manifest);
      if (!isObject(document)) continue;
      const value = document[key];
      const patterns = stringList(value) ?? (objectKey !== null && isObject(value) ? stringList(value[objectKey]) : undefined);
      if (patterns !== undefined) declarations.push({ file, patterns });
      break;
    }
  }
  if (declarations.length === 0) return null;
  const manifests = [...new Set(facts.managers.flatMap((manager) => manager.manifests))];
  const packages = new Set<string>();
  for (const declaration of declarations) {
    for (const directory of expandWorkspaces(repository, declaration.patterns, manifests, declaration.file)) packages.add(directory);
  }
  return { declarations, packages: [...packages].sort(byPath) };
}

/** Reads a workspace declaration file: package.json is already parsed, others are YAML or JSONC. */
function readConfig(repository: Repository, file: string, manifest: Json | undefined): unknown {
  if (file === 'package.json') return manifest;
  return repository.parse(file, /\.ya?ml$/u.test(file) ? (text) => parseYaml(text) as unknown : parseJsonc);
}

function configFiles(repository: Repository, manager: ManagerFacts, directories: readonly string[]): string[] {
  return directories
    .flatMap((directory) => manager.configFiles.map((file) => joinPath(directory, file)))
    .filter((file) => repository.isFile(file))
    .sort(byPath);
}

/**
 * Describes the repository at `root`. Never executes anything from the repository and never leaves it;
 * problems with individual files become warnings.
 */
export function detectProject(
  root: string,
  tools: readonly ToolKnowledge[] = knowledgeBase,
  environment: EnvironmentKnowledge = environmentKnowledge,
): Detection {
  const repository = new Repository(root);
  const facts = detectionFacts(tools, environment);
  const collector = new Collector();

  const manifest = readPackageJson(repository);
  const declaredManager = manifest === undefined ? undefined : readPackageManagerField(repository, facts, manifest, collector);
  if (manifest !== undefined) {
    readDevEngines(facts, manifest, collector);
    readVolta(facts, manifest, collector);
  }
  readToolVersions(repository, facts, collector);

  const lockfiles = new Map<PackageManagerId, string[]>();
  for (const manager of facts.managers) {
    const present = manager.lockfiles.filter((file) => repository.isFile(file)).sort(byPath);
    if (present.length > 0) lockfiles.set(manager.id, present);
    for (const file of present) collector.addEvidence(manager.id, 'lockfile', file);
    for (const file of manager.configFiles.filter((name) => repository.isFile(name))) collector.addEvidence(manager.id, 'config', file);
  }

  const workflows = readWorkflows(repository, facts);
  for (const { tool, file } of workflows.installs) {
    if (tool !== 'node') collector.addEvidence(tool as PackageManagerId, 'ci', file);
  }
  for (const { tool, declaration } of workflows.versions) collector.addVersion(tool, declaration);

  const workspaces = readWorkspaces(repository, facts, manifest);
  const directories = ['.', ...(workspaces?.packages ?? [])];

  if (manifest !== undefined && collector.evidence.size === 0) {
    collector.addEvidence('npm', 'default', 'package.json');
    repository.warn('package-manager-assumed', 'no lockfile, packageManager or devEngines found; assuming npm', ['package.json']);
  }

  const packageManagers: PackageManagerInfo[] = [];
  for (const manager of facts.managers) {
    const evidence = collector.evidence.get(manager.id);
    if (evidence === undefined) continue;
    const yarn = manager.id === 'yarn' ? yarnVariant(repository, facts, collector) : undefined;
    if (yarn?.variant === 'classic') {
      repository.warn('yarn-classic-unsupported', 'Yarn Classic (1.x) is not supported; depgate configures Yarn 2 and later', [yarn.file]);
    }
    packageManagers.push({
      id: manager.id,
      ...(yarn === undefined ? {} : { variant: yarn.variant }),
      supported: yarn?.variant !== 'classic',
      evidence: [...evidence].sort(compareEvidence),
      versions: [...(collector.versions.get(manager.id) ?? [])].sort(compareVersions),
      configFiles: configFiles(repository, manager, directories),
    });
  }

  const bots: BotInfo[] = [];
  for (const bot of facts.bots) {
    const files = bot.configFiles.filter((file) => repository.isFile(file));
    if (bot.packageJsonKey !== null && manifest !== undefined && bot.packageJsonKey in manifest) {
      files.push('package.json');
      repository.warn(
        'renovate-config-in-package-json',
        'Renovate configuration in package.json is deprecated and depgate does not edit it; move it to renovate.json',
        ['package.json'],
      );
    }
    if (files.length > 0) bots.push({ id: bot.id, configFiles: files });
  }

  const withLockfiles = [...lockfiles.entries()];
  if (withLockfiles.length > 1) {
    const files = withLockfiles.flatMap(([, list]) => list).sort(byPath);
    repository.warn('multiple-lockfiles', `lockfiles of several package managers: ${files.join(', ')}`, files);
  }
  if (declaredManager !== undefined && !lockfiles.has(declaredManager as PackageManagerId) && withLockfiles.length > 0) {
    repository.warn(
      'package-manager-mismatch',
      `${facts.packageManagerKey} names ${declaredManager}, but no ${declaredManager} lockfile exists`,
      ['package.json'],
    );
  }
  if (manifest === undefined && packageManagers.length === 0 && !repository.isFile('package.json')) {
    repository.warn('nothing-detected', 'no package.json, deno.json or lockfile found', []);
  }

  return {
    packageManagers,
    node: { versions: [...(collector.versions.get('node') ?? [])].sort(compareVersions) },
    bots,
    workspaces,
    npmrcFiles: directories.map((directory) => joinPath(directory, '.npmrc')).filter((file) => repository.isFile(file)).sort(byPath),
    workflows: workflows.files,
    warnings: [...repository.warnings].sort((a, b) => a.code.localeCompare(b.code) || a.files.join().localeCompare(b.files.join())),
  };
}
