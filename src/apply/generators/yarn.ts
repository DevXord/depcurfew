// Yarn (Berry): settings in .yarnrc.yml, always written explicitly so that Yarn's upgrade migration does not
// write weaker values; the per-package allow-list is dependenciesMeta in the root package.json.
import { yamlSetting } from '../../doctor/settings.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { listing } from '../requirements.ts';
import { extraOf, firstFile, isRecord, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, commentReplacedList, cooldownValue, droppedYamlList, eachSource, exclusions, sameList, sourceLoosened, writeDenyList, wrongListType } from './common.ts';
import { YAML_MARKER } from '../yaml-edit.ts';
import type { ManagerGenerator } from './context.ts';

interface ScriptsSwitch {
  setting: string;
  allow: unknown;
  deny: unknown;
  /** The values Yarn reads as false; every other value runs dependency build scripts (decision D-167). */
  off?: readonly unknown[];
}

const isScriptsSwitch = (value: unknown): value is ScriptsSwitch =>
  isRecord(value) && typeof value['setting'] === 'string' && 'allow' in value && 'deny' in value;

export const yarn: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? '.yarnrc.yml';
  const yaml = context.yaml(file);
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'npmMinimalAgeGate';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      yaml.set([setting], cooldown.value);
    }
    const excludeSetting = settingOf(tool.cooldown.exclude.setting);
    const patterns = cooldown === undefined ? undefined : exclusions(context);
    if (excludeSetting !== null && patterns !== undefined && (patterns.length > 0 || yaml.get([excludeSetting]) !== undefined)) {
      if (!sameList(yaml.get([excludeSetting]), patterns)) {
        // Entries written by hand that the policy does not name stay as a comment (decision D-167).
        const dropped = droppedYamlList(context, file, [excludeSetting], patterns);
        yaml.set([excludeSetting], patterns);
        if (dropped !== undefined) commentReplacedList(context, file, [excludeSetting], dropped);
      }
    }
  }

  if (policy.installScripts !== undefined) {
    const scripts = extraOf(tool, 'scriptsSwitch', isScriptsSwitch);
    const deny = policy.installScripts.default === 'deny';
    // The switch that allows every install script is turned off with the same warning as pnpm's and Deno's (D-116).
    const current = yaml.get([scripts.setting]);
    // Yarn reads 1 and "true" as true too (parseBoolean), and stops on a value it cannot read: every value but the off
    // ones counts as one that runs the scripts (decision D-167).
    const off = scripts.off ?? [scripts.deny];
    if (deny && current !== undefined && !off.includes(current)) {
      const found = context.exists(file) ? yamlSetting(context.read(file), [scripts.setting]) : undefined;
      const reading = current === scripts.allow ? '' : ` (${context.name} reads every value but ${listing(off.map((value) => JSON.stringify(value)))} as true, or stops on it)`;
      context.warn({
        code: 'allow-all-replaced',
        ...(found === undefined ? {} : { location: { file, line: found.line } }),
        message: `${context.name}: ${scripts.setting}: ${JSON.stringify(current)} in ${file}${found === undefined ? '' : ` (line ${found.line})`} allowed every install script${reading}; set to ${JSON.stringify(scripts.deny)} because the policy denies install scripts`,
        fix: `Add the packages whose install scripts must run to installScripts.allow in ${POLICY_FILE}, then run depcurfew apply again`,
      });
    }
    yaml.set([scripts.setting], deny ? scripts.deny : scripts.allow);
    context.writes('installScripts', scripts.setting, file);
    const template = settingOf(tool.installScripts.allowList.setting);
    if (deny && template !== null && policy.installScripts.allow.length > 0) {
      if (context.supports(sinceOf(tool.installScripts.allowList.availableSince), template)) {
        const listFile = settingOf(tool.installScripts.allowList.file) ?? 'package.json';
        const json = context.json(listFile);
        const list = template.split('.')[0] ?? template;
        const names = allowedNames(context, list);
        // dependenciesMeta and each package in it are objects; a value of another type is left as it is (decision D-167).
        if (names.length > 0 && !wrongListType(context, listFile, [list], json.get([list]), 'object', names, `{${JSON.stringify(names[0])}: {"built": true}}`)) {
          context.writes('installScripts', template, listFile);
          for (const name of names) {
            const path = template.split('.').map((segment) => (segment === '<package>' ? name : segment));
            if (wrongListType(context, listFile, path.slice(0, -1), json.get(path.slice(0, -1)), 'object', [name], `{${JSON.stringify(path.at(-1))}: true}`)) continue;
            if (json.get(path) !== true) json.set(path, true);
          }
        }
      }
    }
    if (deny) writeDenyList(context);
  }

  eachSource(context, (kind, setting, access) => {
    context.writes('sources', setting, file);
    const value = access === 'deny' ? [] : ['**'];
    // A list without ** written by hand approves only some git repositories, which "allow" widens (decision D-167).
    const current = yaml.get([setting]);
    const found = access === 'allow' && Array.isArray(current) && !current.includes('**') && context.exists(file) ? yamlSetting(context.read(file), [setting]) : undefined;
    if (found !== undefined && context.read(file).split('\n')[found.line - 2]?.trim() !== YAML_MARKER) {
      sourceLoosened(
        context,
        [kind],
        { file, line: found.line },
        `${setting}: ${JSON.stringify(current)}`,
        (current as unknown[]).length === 0 ? 'approves no git repository' : 'approves only the git repositories it lists',
        `sets it to ${JSON.stringify(value)}, so ${context.name} installs from any git repository`,
      );
    }
    if (!sameList(yaml.get([setting]), value)) yaml.set([setting], value);
  });
  return minutes;
};
