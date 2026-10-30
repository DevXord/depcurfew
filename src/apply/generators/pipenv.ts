// Pipenv: cool-down-period in one managed block in [pipenv] of the Pipfile, in whole days. Pipenv has no project
// setting for cooldown exceptions or for building from source, so apply says what it cannot write.
import { hasManagedLines } from '../block.ts';
import { extraOf, isRecord, settingOf } from '../facts.ts';
import { cooldownValue, eachSource } from './common.ts';
import type { ManagerGenerator } from './context.ts';
import { compactDuration, tomlValue } from './python.ts';

export const pipenv: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const tables = extraOf(tool, 'configTables', isRecord);
  const file = 'Pipfile';
  const table = typeof tables[file] === 'string' ? tables[file] : 'pipenv';
  const entries: string[] = [];
  const managed: string[] = [];
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'cool-down-period';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting} = ${tomlValue(compactDuration(String(cooldown.value)))}`);
      managed.push(setting);
    }
    // The policy here is the Python view: cooldown.exclude holds the pypi: names, without the prefix.
    if (policy.cooldown.exclude.length > 0 && settingOf(tool.cooldown.exclude.setting) === null) {
      context.warn({
        code: 'exclude-unsupported',
        message: `${context.name}: no setting exempts packages from ${setting}, so the Python packages in cooldown.exclude wait like every other package`,
      });
    }
  }

  if (policy.installScripts?.default === 'deny' && settingOf(tool.installScripts.disableAll) === null) {
    context.warn({
      code: 'build-switch-environment-only',
      message: `${context.name}: the Pipfile has no setting that forbids building packages from source, so installScripts "deny" is not written`,
      fix: 'Set PIP_ONLY_BINARY=:all: where Pipenv installs packages (CI, Dockerfile); Pipenv passes it on to pip',
    });
  }

  eachSource(context, () => undefined);

  if (entries.length > 0 || (context.exists(file) && hasManagedLines(context.read(file)))) context.toml(file, table, entries, managed);
  return minutes;
};
