// corepack-unavailable (decision D-128): packageManager or devEngines.packageManager pins Yarn or npm, which only
// Corepack reads, while a declared Node.js is 25 or later, which no longer comes with Corepack. Without a separate
// Corepack install the pin then has no effect there. pnpm switches to its pinned version itself (pnpm
// extra.managesOwnVersion) and npm checks devEngines.packageManager itself, so those pins are not reported. A CI job or
// Dockerfile stage that installs or runs Corepack before it installs with the pinned tool is not reported either.
import { parseVersion, type Version } from '../../apply/version.ts';
import { extraOf, isRecord } from '../../apply/facts.ts';
import type { DockerfileInfo, DockerStage, PackageManagerInfo, ToolCommand, VersionDeclaration } from '../../detect/types.ts';
import { environment } from '../../knowledge/environment.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { versionedValue } from '../effective.ts';
import { namingFor, nodeLines, runtimeFacts } from '../runtime-versions.ts';
import type { Rule, RuleContext, RuleScope } from '../types.ts';
import { commandsAfterStep, jobIndex, nodeSubject, SOURCE_LABEL } from './bundled-versions.ts';
import { declarationLine } from './manager-version.ts';

const RULE = 'corepack-unavailable';

/** A pin that only Corepack acts on: the tool, the pin as written, where it is. */
interface Pin {
  tool: PackageManagerInfo['id'];
  name: string;
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
      const name = manager.id;
      return [{ tool: manager.id, name, text: `${name}@${declaration.version}`, declaration }];
    }),
  );
}

/** The installs a command list makes with the pinned tool. */
const installsWith = (tool: Pin['tool']) => (command: ToolCommand) => command.kind === 'install' && command.tool === tool;

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
function usesWithoutCorepack(context: RuleContext, declaration: VersionDeclaration, tool: Pin['tool']): boolean {
  if (declaration.source === 'github-actions') {
    const group = jobIndex(context.detection).of(declaration);
    if (group === undefined) return false;
    if (!group.job.runsNode) return false;
    const install = commandsAfterStep(group, declaration).find(installsWith(tool));
    if (install === undefined) return false;
    return group.job.corepack === undefined || group.job.corepack > install.line;
  }
  if (declaration.source === 'dockerfile') {
    const file = context.detection.dockerfiles.find((entry) => entry.file === declaration.file);
    const index = file === undefined ? undefined : stageOf(file, declaration);
    if (file === undefined || index === undefined) return false;
    return stagesFrom(file, index).some((chain) => {
      const install = chain.at(-1)?.commands.find(installsWith(tool));
      if (install === undefined) return false;
      const corepack = chain.flatMap((stage) => (stage.corepack === undefined ? [] : [stage.corepack]));
      return !corepack.some((line) => line < install.line);
    });
  }
  return declaration.source !== 'volta';
}

/** What to do there: install Corepack, as its README says for Node.js 25 and later, then enable the pinned tool. */
function fixFor(declaration: VersionDeclaration, pin: Pin, node: string): string {
  const install = evidenceOf(environment.corepack.manualInstall)[0]?.value ?? { command: 'npm install -g corepack', enable: 'corepack enable', package: 'corepack' };
  // A bare corepack enable leaves npm alone (environment.corepack.enableNpm).
  const enable = pin.tool === 'npm' ? `${install.enable} npm` : install.enable;
  const steps = `${install.command}, then ${enable}`;
  const npm = pin.tool === 'npm' ? '; npm itself does not read packageManager, while it checks devEngines.packageManager itself' : '';
  if (declaration.source === 'github-actions') return `Install Corepack in job ${declaration.job ?? ''} of ${declaration.file} before it runs ${pin.name} (a step that runs ${steps})${npm}`;
  if (declaration.source === 'dockerfile') return `Install Corepack in ${declaration.file} before ${pin.name} runs (RUN ${install.command} && ${enable})${npm}`;
  return `Install Corepack wherever ${node} is used for this project (${steps}), as the Corepack README says for a Node.js without it${npm}`;
}

export const corepackUnavailable: Rule = {
  id: RULE,
  checks: 'A pin that only Corepack reads has a Node.js that comes with Corepack',
  summary: 'packageManager or devEngines.packageManager pins Yarn or npm, but a declared Node.js is 25 or later, which no longer comes with Corepack.',
  description:
    'Corepack reads packageManager (and devEngines.packageManager) and runs the pinned Yarn, or npm after corepack enable npm. Node.js 25.0.0 stopped distributing Corepack, so where a version file, CI job or Dockerfile chooses Node.js 25 or later, the pin has no effect unless Corepack is installed separately: whatever Yarn or npm is there runs, or none. pnpm 10 and later switches to its pinned version itself, and npm checks devEngines.packageManager itself, so those pins are not reported; nor is a CI job or Dockerfile stage that installs or runs Corepack before it installs with the pinned tool.',
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
      const subject = nodeSubject(declaration, SOURCE_LABEL[declaration.source]);
      const line = declarationLine(context, declaration);
      for (const pin of pins) {
        if (!usesWithoutCorepack(context, declaration, pin.tool)) continue;
        const pinLine = declarationLine(context, pin.declaration);
        const where = `${SOURCE_LABEL[pin.declaration.source] === 'devEngines' ? 'devEngines.packageManager' : 'packageManager'} in ${pin.declaration.file}${pinLine === undefined ? '' : ` (line ${pinLine})`}`;
        context.report({
          location: line === undefined ? { file: declaration.file } : { file: declaration.file, line },
          message: `${where} pins ${pin.text}, but ${subject} does not come with Corepack (Node.js ${removed.slice(0, 3).join('.')} stopped distributing it), and Corepack is what reads that pin: without a separate Corepack install, ${pin.name} there is whatever ${pin.tool === 'npm' ? 'npm comes with that Node.js' : 'Yarn is installed, or none'}`,
          fix: fixFor(declaration, pin, subject.replace(/ in .*$/u, '')),
        });
      }
    }
  },
};
