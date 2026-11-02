// corepack-unavailable (decision D-128): packageManager or devEngines.packageManager pins Yarn or npm, which only
// Corepack reads, while a declared Node.js is 25 or later, which no longer comes with Corepack. Without a separate
// Corepack install the pin then has no effect there. pnpm switches to its pinned version itself (pnpm
// extra.managesOwnVersion) and npm checks devEngines.packageManager itself, so those pins are not reported. A CI job or
// Dockerfile stage that installs or runs Corepack before it installs with the pinned tool is not reported either, nor
// one that installs the pinned npm release itself first (npm install -g npm@<version>, decision D-144).
import { posix } from 'node:path';
import { compareVersions, parseVersion, type Version } from '../../apply/version.ts';
import { extraOf, isRecord, yamlOptionsFor } from '../../apply/facts.ts';
import { yamlSetting } from '../settings.ts';
import type { DockerfileInfo, DockerStage, PackageManagerInfo, ToolCommand, VersionDeclaration, WorkflowJob } from '../../detect/types.ts';
import { declarationJob } from '../../detect/workflows.ts';
import { environment } from '../../knowledge/environment.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { versionedValue } from '../effective.ts';
import { lowestVersion } from '../version-range.ts';
import { namingFor, nodeLines, runtimeFacts } from '../runtime-versions.ts';
import type { Rule, RuleContext, RuleScope } from '../types.ts';
import { commandsAfterStep, jobIndex, nodeSubject, SOURCE_LABEL } from './bundled-versions.ts';
import { declarationLine } from './manager-version.ts';

const RULE = 'corepack-unavailable';

/** A pin that only Corepack acts on: the tool, the pin as written, where it is. */
interface Pin {
  tool: PackageManagerInfo['id'];
  name: string;
  /** The pinned version, without the hash Corepack may check (+sha512...). */
  version: string;
  text: string;
  declaration: VersionDeclaration;
}

/** The first release without Corepack after releases with it (25.0.0), from environment.corepack.bundledWithNode. */
function removedIn(): Version | undefined {
  for (const evidence of evidenceOf(environment.corepack.bundledWithNode)) {
    let bundled = false;
    for (const entry of evidence.value) {
      if (entry.value) bundled = true;
      else if (bundled) return parseVersion(entry.since);
    }
  }
  return undefined;
}

/** Whether the tool acts on its own pin: pnpm 10 and later switches to it (managesOwnVersion). */
function managesOwnVersion(tool: ToolKnowledge | undefined): boolean {
  return tool?.extra?.['managesOwnVersion'] !== undefined && isRecord(extraOf(tool, 'managesOwnVersion', isRecord));
}

const isYarnPathFact = (value: unknown): value is { file: string; key: string } => isRecord(value) && typeof value['file'] === 'string' && typeof value['key'] === 'string';

/**
 * Whether .yarnrc.yml names, with yarnPath, a Yarn release in the repository: Yarn 1.18 and later, and Yarn 2 and later,
 * run that release instead of themselves, so it is the Yarn that runs with or without Corepack (yarn extra.yarnPathRuns,
 * decision D-134). A path outside the repository is not committed with it.
 */
function committedYarnPath(scope: RuleScope): boolean {
  const yarn = scope.tools.find((tool) => tool.id === 'yarn');
  if (yarn?.extra?.['yarnPathRuns'] === undefined) return false;
  const fact = extraOf(yarn, 'yarnPathRuns', isYarnPathFact);
  const text = scope.repository.readText(fact.file);
  const value = text === undefined ? undefined : yamlSetting(text, [fact.key], yamlOptionsFor(fact.file))?.value;
  if (typeof value !== 'string' || value === '' || /^(?:[a-z]:)?[\\/]/iu.test(value)) return false;
  const path = posix.normalize(value.replaceAll('\\', '/'));
  return path !== '..' && !path.startsWith('../') && scope.repository.isFile(path);
}

/** The pins of the tools Corepack manages that nothing else acts on. */
function pinsOf(scope: RuleScope): Pin[] {
  const managers = new Set<string>(evidenceOf(environment.corepack.packageManagerField).flatMap((evidence) => [...evidence.value.managers]));
  return scope.detection.packageManagers.flatMap((manager) =>
    manager.versions.flatMap((declaration): Pin[] => {
      if (!managers.has(manager.id) || !('version' in declaration)) return [];
      if (declaration.source !== 'packageManager' && declaration.source !== 'devEngines') return [];
      // npm checks devEngines.packageManager itself (environment.devEngines); pnpm switches to its pin itself.
      if (manager.id === 'npm' && declaration.source === 'devEngines') return [];
      if (managesOwnVersion(scope.tools.find((tool) => tool.id === manager.id))) return [];
      // A release committed under yarnPath runs whichever Yarn starts.
      if (manager.id === 'yarn' && committedYarnPath(scope)) return [];
      const name = manager.id;
      return [{ tool: manager.id, name, version: declaration.version, text: `${name}@${declaration.version}`, declaration }];
    }),
  );
}

/** The installs a command list makes with the pinned tool. */
const installsWith = (tool: Pin['tool']) => (command: ToolCommand) => command.kind === 'install' && command.tool === tool;

/** How a place uses the pinned tool without Corepack: with the release it comes with, or with another one it installs. */
interface Use {
  /** The last command before the install that installs another release of the tool itself (npm install -g npm@latest). */
  other?: ToolCommand;
}

/**
 * The one release an install spec names, read as manager-version-too-old reads npm install -g npm@<spec>: 11.19.1,
 * v11.19.1, =11.19.1 and 11.19.1+sha512... all name 11.19.1 (decision D-146); a range, a tag or a variable names none.
 */
function exactRelease(spec: string): Version | undefined {
  const exact = parseVersion(spec);
  if (exact !== undefined) return exact;
  const lowest = lowestVersion(spec);
  return lowest.kind === 'exact' && lowest.prerelease === undefined ? lowest.version : undefined;
}

/**
 * The tool installing a release of itself before the install (npm install -g npm@11.19.1, decision D-144): the pinned
 * release then runs there without Corepack, so nothing is reported; another release runs instead of the pin. The spec
 * and the pin are compared as releases, not as text (decision D-146).
 */
function ownRelease(before: readonly ToolCommand[], pin: Pin): Use | undefined {
  const own = before.filter((command) => command.kind === 'upgrade' && command.tool === pin.tool && command.version !== undefined).at(-1);
  if (own === undefined) return {};
  const installed = exactRelease(own.version ?? '');
  const pinned = parseVersion(pin.version);
  return installed !== undefined && pinned !== undefined && compareVersions(installed, pinned) === 0 ? undefined : { other: own };
}

/** The stage a Dockerfile declaration belongs to, by its name or its number from 0. */
function stageOf(file: DockerfileInfo, declaration: VersionDeclaration): number | undefined {
  if (declaration.stage === undefined) return undefined;
  const byName = file.stages.findIndex((stage) => stage.name === declaration.stage);
  if (byName !== -1) return byName;
  const index = Number(declaration.stage);
  return Number.isInteger(index) && index >= 0 && index < file.stages.length ? index : undefined;
}

/** The stages that start from `index`, directly or through others, with it; each with the stages from `index` to it. */
function stagesFrom(file: DockerfileInfo, index: number): DockerStage[][] {
  const chains: DockerStage[][] = [];
  file.stages.forEach((stage, at) => {
    const chain: DockerStage[] = [stage];
    let current = at;
    for (let guard = 0; current !== index && guard < file.stages.length; guard++) {
      const from = file.stages[current]?.from;
      if (from === undefined) return;
      current = from;
      chain.unshift(file.stages[current] as DockerStage);
    }
    if (current === index) chains.push(chain);
  });
  return chains;
}

/**
 * Whether the place of a Node.js declaration uses the pinned tool without Corepack: a CI job that installs with it after
 * the step without a Corepack command before; a Dockerfile stage (or one that starts from it) likewise; any other
 * place (a version file, engines) always, since people run the tool there.
 */
function usesWithoutCorepack(context: RuleContext, declaration: VersionDeclaration, pin: Pin): Use | undefined {
  if (declaration.source === 'github-actions') {
    const group = jobIndex(context.detection).of(declaration);
    if (group === undefined) return undefined;
    if (!group.job.runsNode) return undefined;
    const commands = commandsAfterStep(group, declaration);
    const at = commands.findIndex(installsWith(pin.tool));
    // Corepack before the install in the job, also on its line (decision D-141).
    if (at === -1 || commands[at]?.afterCorepack === true) return undefined;
    return ownRelease(commands.slice(0, at), pin);
  }
  if (declaration.source === 'dockerfile') {
    const file = context.detection.dockerfiles.find((entry) => entry.file === declaration.file);
    const index = file === undefined ? undefined : stageOf(file, declaration);
    if (file === undefined || index === undefined) return undefined;
    for (const chain of stagesFrom(file, index)) {
      const commands = chain.at(-1)?.commands ?? [];
      const at = commands.findIndex(installsWith(pin.tool));
      // Corepack in an earlier stage of the chain, or before the install in its own (decision D-141).
      if (at === -1 || commands[at]?.afterCorepack === true || chain.slice(0, -1).some((stage) => stage.corepack !== undefined)) continue;
      const use = ownRelease([...chain.slice(0, -1).flatMap((stage) => stage.commands), ...commands.slice(0, at)], pin);
      if (use !== undefined) return use;
    }
    return undefined;
  }
  return declaration.source === 'volta' ? undefined : {};
}

/** What to do there: install Corepack, as its README says for Node.js 25 and later, then enable the pinned tool. */
function fixFor(declaration: VersionDeclaration, pin: Pin, node: string, jobs: readonly WorkflowJob[]): string {
  const install = evidenceOf(environment.corepack.manualInstall)[0]?.value ?? { command: 'npm install -g corepack', enable: 'corepack enable', package: 'corepack' };
  // A bare corepack enable leaves npm alone (environment.corepack.enableNpm).
  const enable = pin.tool === 'npm' ? `${install.enable} npm` : install.enable;
  const steps = `${install.command}, then ${enable}`;
  const npm = pin.tool === 'npm' ? '; npm itself does not read packageManager, while it checks devEngines.packageManager itself' : '';
  // The job by its id only when GitHub accepts it as one, else by its line: a fix never repeats other text (D-135).
  if (declaration.source === 'github-actions') return `Install Corepack in ${declarationJob(declaration, jobs)} of ${declaration.file} before it runs ${pin.name} (a step that runs ${steps})${npm}`;
  if (declaration.source === 'dockerfile') return `Install Corepack in ${declaration.file} before ${pin.name} runs (RUN ${install.command} && ${enable})${npm}`;
  return `Install Corepack wherever ${node} is used for this project (${steps}), as the Corepack README says for a Node.js without it${npm}`;
}

export const corepackUnavailable: Rule = {
  id: RULE,
  checks: 'A pin that only Corepack reads has a Node.js that comes with Corepack',
  summary: 'packageManager or devEngines.packageManager pins Yarn or npm, but a declared Node.js is 25 or later, which no longer comes with Corepack.',
  description:
    'Corepack reads packageManager (and devEngines.packageManager) and runs the pinned Yarn, or npm after corepack enable npm. Node.js 25.0.0 stopped distributing Corepack, so where a version file, CI job or Dockerfile chooses Node.js 25 or later, the pin has no effect unless Corepack is installed separately: whatever Yarn or npm is there runs, or none. pnpm 10 and later switches to its pinned version itself, npm checks devEngines.packageManager itself, and every Yarn from 1.18 runs a release committed under yarnPath in .yarnrc.yml, so those pins are not reported; nor is a CI job or Dockerfile stage that installs or runs Corepack, or installs the pinned npm release itself, before it installs with the pinned tool.',
  help: 'Install Corepack where that Node.js runs (npm install -g corepack, then corepack enable), before the pinned tool runs.',
  level: 'warning',
  requiresPolicy: false,
  // Only a repository that pins Yarn or npm for Corepack and declares a Node.js version has something to check.
  applies: (scope) => pinsOf(scope).length > 0 && scope.detection.node.versions.some((declaration) => declaration.source !== 'volta'),
  check(context) {
    const pins = pinsOf(context);
    const removed = removedIn();
    if (pins.length === 0 || removed === undefined) return;
    const facts = runtimeFacts(environment);
    const bundled = evidenceOf(environment.corepack.bundledWithNode)[0]?.value ?? [];
    // Every release line the declaration allows comes without Corepack, from the release that stopped it on.
    const withoutCorepack = (declaration: VersionDeclaration & { version: string }) => {
      if (declaration.unknown !== undefined) return false;
      const lines = nodeLines(declaration.version, namingFor(declaration), facts);
      if (lines === undefined || lines.length === 0) return false;
      return lines.every((line) => line.line >= removed[0] && versionedValue(bundled, [line.line, 0, 0]) === false);
    };
    for (const declaration of context.detection.node.versions) {
      if (declaration.source === 'volta' || !('version' in declaration) || !withoutCorepack(declaration)) continue;
      const subject = nodeSubject(declaration, SOURCE_LABEL[declaration.source], context.detection.jobs);
      const line = declarationLine(context, declaration);
      for (const pin of pins) {
        const use = usesWithoutCorepack(context, declaration, pin);
        if (use === undefined) continue;
        const pinLine = declarationLine(context, pin.declaration);
        const where = `${SOURCE_LABEL[pin.declaration.source] === 'devEngines' ? 'devEngines.packageManager' : 'packageManager'} in ${pin.declaration.file}${pinLine === undefined ? '' : ` (line ${pinLine})`}`;
        const fix = fixFor(declaration, pin, subject.replace(/ in .*$/u, ''), context.detection.jobs);
        // Another release of the tool that the place installs itself runs instead of the pin (decision D-144).
        const runs =
          use.other === undefined
            ? `without a separate Corepack install, ${pin.name} there is whatever ${pin.tool === 'npm' ? 'npm comes with that Node.js' : 'Yarn is installed, or none'}`
            : `${pin.name} there is ${pin.name}@${use.other.version ?? 'latest'}, which line ${use.other.line} of ${declaration.file} installs`;
        context.report({
          location: line === undefined ? { file: declaration.file } : { file: declaration.file, line },
          message: `${where} pins ${pin.text}, but ${subject} does not come with Corepack (Node.js ${removed.slice(0, 3).join('.')} stopped distributing it), and Corepack is what reads that pin: ${runs}`,
          fix: use.other === undefined ? fix : `Make line ${use.other.line} of ${declaration.file} install the pinned release (npm install -g ${pin.text}), or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}`,
        });
      }
    }
  },
};
