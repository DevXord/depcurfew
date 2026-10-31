// pip: no project configuration. The build options go into requirements.txt in a managed block; the release-age
// delay cannot be set in the project, so apply says how to set it where pip runs.
import { convertCooldown } from '../../policy/convert.ts';
import { hasManagedLines } from '../block.ts';
import { extraOf, firstFile, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { formatVersion } from '../version.ts';
import { eachSource } from './common.ts';
import type { ManagerGenerator } from './context.ts';
import { buildAllowList, buildSwitchScopeWarning, forcedBuildWarning } from './python.ts';

export const pip: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = (tool.project === undefined ? undefined : firstFile(tool.project.manifests)) ?? 'requirements.txt';

  if (policy.cooldown !== undefined) {
    const flag = settingOf(tool.cooldown.setting) ?? 'uploaded-prior-to';
    const variable = extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string');
    const since = sinceOf(tool.cooldown.availableSince);
    const result = convertCooldown(tool, policy.cooldown.minimum);
    const value = result.ok ? `P${String(result.value)}D` : undefined;
    const version = context.version === undefined || context.atLeast(since) ? '' : ` (pip ${formatVersion(context.version)} is too old for it)`;
    context.warn({
      code: 'cooldown-environment-only',
      message: `${context.name}: cooldown not written: pip reads no configuration from the project and rejects --${flag} in requirements files${version}`,
      fix: `Set ${variable}${value === undefined ? '' : `=${value}`} where pip installs packages (CI, Dockerfile), with pip ${since ?? 'a recent version'} or later`,
    });
  }

  const entries: string[] = [];
  const managed: string[] = [];
  if (policy.installScripts?.default === 'deny') {
    const build = extraOf(tool, 'buildSwitch', isSwitch);
    const setting = settingOf(tool.installScripts.allowList.setting);
    if (context.supports(build.since, build.setting)) {
      entries.push(`${build.setting}=${String(build.value)}`);
      managed.push(build.setting);
      buildSwitchScopeWarning(context, build.setting, build.covers);
      if (setting !== null) {
        managed.push(setting);
        const names = policy.installScripts.allow.length > 0 ? buildAllowList(context, setting) : [];
        for (const name of names) entries.push(`${setting}=${name}`);
        forcedBuildWarning(context, setting, names);
      }
    }
  }

  eachSource(context, () => undefined);

  if (!context.exists(file)) {
    if (entries.length > 0) {
      context.warn({
        code: 'requirements-file-missing',
        message: `${context.name}: no ${file}, so ${entries.join(' and ')} not written`,
        fix: `Add ${entries.length === 1 ? 'it' : 'them'} to the pip command or the requirements file pip installs from`,
      });
    }
    return undefined;
  }
  if (entries.length > 0 || hasManagedLines(context.read(file))) context.requirements(file, entries, managed);
  return undefined;
};
