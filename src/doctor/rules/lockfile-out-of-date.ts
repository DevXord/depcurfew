// lockfile-out-of-date: a uv.lock or pdm.lock locked with other settings than the project has now (decision D-116).
// depcurfew apply warns when it changes what the lockfile records (lockfile-out-of-date of apply); this finds it later
// too, after an apply whose warning went unread or a change by hand. uv: exclude-newer and exclude-newer-package in
// [options] of uv.lock, compared as uv compares them. PDM: the content hash in pdm.lock, computed as PDM computes it.
import { extraOf, isRecord, values } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { tomlValueAt } from '../../detect/toml.ts';
import { pdmHash, uvLockChange } from '../locked-settings.ts';
import { pythonSettingPaths, readPythonSetting, readTomlDocument } from '../python.ts';
import type { Rule, RuleContext } from '../types.ts';

interface LockedSettings {
  lock: string;
  failing: string[];
}

const isLockedSettings = (value: unknown): value is LockedSettings =>
  isRecord(value) && typeof value['lock'] === 'string' && Array.isArray(value['failing']) && value['failing'].every((item) => typeof item === 'string');

/** The lockfile of the tool the project has, from the knowledge base, with the commands that lock again and that fail. */
function lockfileOf(context: RuleContext, tool: ToolKnowledge): { file: string; locked: LockedSettings } | undefined {
  if (tool.extra?.['lockedSettings'] === undefined) return undefined;
  const locked = extraOf(tool, 'lockedSettings', isLockedSettings);
  const names = tool.project === undefined ? [] : values(tool.project.lockfiles).flatMap((versions) => versions.flatMap((entry) => [...entry.value]));
  const file = names.find((name) => context.repository.isFile(name));
  return file === undefined ? undefined : { file, locked };
}

function checkUv(context: RuleContext, tool: ToolKnowledge): void {
  const found = lockfileOf(context, tool);
  if (found === undefined) return;
  const lock = readTomlDocument(context.repository, found.file);
  if (lock === undefined) return;
  const packages = tomlValueAt(lock, ['package']);
  const names = Array.isArray(packages) ? packages.flatMap((item) => (isRecord(item) && typeof item['name'] === 'string' ? [item['name']] : [])) : [];
  const configFile = pythonSettingPaths(context.repository, tool, 'exclude-newer')[0]?.file ?? 'pyproject.toml';
  const change = uvLockChange(tool, lock, names, configFile, (key) => readPythonSetting(context.repository, tool, key));
  if (change === undefined) return;
  context.report({
    location: change.line === undefined ? { file: found.file } : { file: found.file, line: change.line },
    message: `${found.file} was locked ${change.locked === undefined ? `without ${change.setting}` : `with ${change.locked}`}, but ${change.current} now${change.note ?? ''}, so ${listing(found.locked.failing)} fail until ${found.locked.lock} runs again`,
    fix: `Run ${found.locked.lock} and commit ${found.file}, or set ${change.setting} back in ${configFile} if the change was not intended`,
  });
}

function checkPdm(context: RuleContext, tool: ToolKnowledge): void {
  const found = lockfileOf(context, tool);
  if (found === undefined) return;
  const lock = readTomlDocument(context.repository, found.file);
  const pyproject = readTomlDocument(context.repository, 'pyproject.toml');
  if (lock === undefined || pyproject === undefined) return;
  const result = pdmHash(tool, lock, pyproject);
  if (result === undefined || result.matches) return;
  context.report({
    location: result.line === undefined ? { file: found.file } : { file: found.file, line: result.line },
    message: `${found.file} does not match pyproject.toml: its content_hash is not the one ${tool.name} computes from the dependencies, sources and [tool.pdm.resolution] settings of pyproject.toml now, so ${listing(found.locked.failing)} fail until ${found.locked.lock} runs again`,
    fix: `Run ${found.locked.lock} and commit ${found.file}, or undo the change to pyproject.toml if it was not intended`,
  });
}

const TOOLS: ReadonlySet<string> = new Set(['uv', 'pdm']);

export const lockfileOutOfDate: Rule = {
  id: 'lockfile-out-of-date',
  checks: 'uv.lock and pdm.lock were locked with the settings the project has now',
  summary: 'A uv.lock or pdm.lock was locked with other settings than the project has now.',
  description:
    'uv records the release-age delay (exclude-newer and exclude-newer-package) in uv.lock, and PDM checks pdm.lock against a hash of the dependencies, the sources and the [tool.pdm.resolution] table, the delay and the build ban included. After a change, by depcurfew apply or by hand, uv sync --locked, uv lock --check, pdm lock --check and pdm install --check fail until the lockfile is locked again, and the lockfile still holds what was resolved under the old settings.',
  help: 'Lock again (uv lock or pdm lock) and commit the lockfile.',
  level: 'warning',
  requiresPolicy: false,
  applies: (scope) =>
    scope.detection.packageManagers.some((manager) => manager.supported && TOOLS.has(manager.id) && manager.evidence.some((evidence) => evidence.kind === 'lockfile')),
  check(context) {
    for (const manager of context.detection.packageManagers) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined || !manager.supported) continue;
      if (tool.id === 'uv') checkUv(context, tool);
      if (tool.id === 'pdm') checkPdm(context, tool);
    }
  },
};
