// runtime-end-of-life: a declared Node.js version that only allows release lines past their end of life, which get
// no more releases, security fixes included. The dates come from the Node.js release schedule in the knowledge base.
// A version it cannot read gives a note with the place and a fix, so "passed" never stands for "not looked at"
// (decisions D-105 and D-109).
import { environment } from '../../knowledge/environment.ts';
import { namingFor, nodeLines, runtimeFacts, supportedLtsLines, today } from '../runtime-versions.ts';
import { commandsAfterStep, jobIndex, nodeSubject } from './bundled-versions.ts';
import type { Rule } from '../types.ts';
import { declarationLine, SOURCE_LABEL } from './manager-version.ts';

const RULE = 'runtime-end-of-life';

function listing(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}

export const runtimeEndOfLife: Rule = {
  id: RULE,
  checks: 'No declared Node.js version is past its end of life',
  summary: 'A declared Node.js version is past its end of life.',
  description:
    'After its end of life a Node.js release line gets no more releases, security fixes included. A version file, CI step or Dockerfile that only allows such lines keeps running an unpatched Node.js, and an older npm with it.',
  help: 'Move to a Node.js line that is still supported, in every place that declares the version.',
  level: 'warning',
  requiresPolicy: false,
  // Only a repository that declares a Node.js version somewhere has one to check (decision D-098).
  applies: (scope) =>
    [scope.detection, ...(scope.projects ?? []).map((project) => project.detection)].some(
      (detection) => detection.node.versions.length > 0 || detection.dockerfiles.some((file) => file.stages.some((stage) => stage.runtime?.tool === 'node')),
    ),
  check(context) {
    const facts = runtimeFacts(environment);
    const now = today();
    const supported = supportedLtsLines(facts, now).map((line) => `${line.line} (until ${line.end})`);
    const jobs = jobIndex(context.detection);
    const lines = listing(supported);
    const check = supported.length === 0 ? 'check by hand that it is a Node.js line that is still supported' : `check by hand that it is a supported Node.js LTS line: ${lines}`;
    // A note, like an unreadable Renovate preset (decision D-076): it has a place and a fix, which a notice has not.
    const cannotTell = (subject: string, reason: string, location: { file: string; line?: number }, fix: string) =>
      context.report({ level: 'note', location, message: `${RULE} cannot tell whether ${subject} is past its end of life: ${reason}`, fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}` });
    for (const declaration of context.detection.node.versions) {
      // A job that never runs node or a package manager (one that tests an action on an old runner) uses no Node.js of its
      // own; one that only runs code on an old Node.js after installing on a supported one (a compatibility test, as
      // depcurfew's own CI does, decision D-103) installs nothing with it. Installs by pnpm, Yarn and Bun count too.
      if (declaration.source === 'github-actions') {
        const group = jobs.of(declaration);
        if (group !== undefined && !group.job.runsNode) continue;
        if (group !== undefined && declaration.step !== undefined && !commandsAfterStep(group, declaration).some((command) => command.kind === 'install')) continue;
      }
      const label = SOURCE_LABEL[declaration.source];
      const line = declarationLine(context, declaration);
      const location = line === undefined ? { file: declaration.file } : { file: declaration.file, line };
      if (!('version' in declaration)) {
        cannotTell(`the Node.js of ${declaration.versionFile} in ${declaration.file}`, 'depcurfew cannot read the version from that file', location, `${check.replace('it is', `${declaration.versionFile} names`)}`);
        continue;
      }
      const subject = nodeSubject(declaration, label);
      if (declaration.unknown !== undefined) {
        cannotTell(subject, declaration.unknown, location, check.replace('it is', 'every value is'));
        continue;
      }
      const found = nodeLines(declaration.version, namingFor(declaration), facts);
      if (found === undefined) {
        cannotTell(subject, 'it is not a version or a range depcurfew can read', location, `write the version in ${label} as depcurfew reads it (such as 24, 24.11.0 or lts/krypton), or ${check}`);
        continue;
      }
      if (found.length === 0) {
        cannotTell(subject, 'it matches no Node.js release line depcurfew knows', location, `update depcurfew if this Node.js is newer than it knows, or ${check}`);
        continue;
      }
      if (found.some((entry) => entry.end > now)) continue;
      const last = found.reduce((newest, entry) => (entry.line > newest.line ? entry : newest));
      const message =
        found.length === 1
          ? `${subject} is past its end of life (Node.js ${last.line} ended on ${last.end}) and gets no more releases, security fixes included`
          : `${subject} only allows Node.js lines past their end of life (the newest, ${last.line}, ended on ${last.end}), which get no security fixes`;
      context.report({
        location,
        message,
        fix: supported.length === 0 ? `Move to a Node.js line that is still supported, in ${label}` : `Move to a supported Node.js LTS line in ${label}: ${lines}`,
      });
    }
    // A stage that starts from the official node image with a tag depcurfew cannot read declares no version above.
    for (const file of context.detection.dockerfiles) {
      for (const stage of file.stages) {
        if (stage.from !== undefined || stage.runtime?.tool !== 'node' || stage.runtime.version !== undefined) continue;
        cannotTell(
          `Node.js (${stage.image ?? 'node'}) in ${file.file}`,
          stage.runtime.unknown ?? 'the tag names no version',
          { file: file.file, line: stage.line },
          `use a node image tag that names the Node.js version (such as node:24-alpine), or ${check.replace('it is', 'the image has')}`,
        );
      }
    }
  },
};
