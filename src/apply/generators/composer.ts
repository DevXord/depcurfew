// Composer: config.policy.cooldown (period and ignore) and config.allow-plugins in composer.json, the root package.
// JSON has no markers, so a value that is there counts as written by hand: apply sets the period, adds the policy's
// names to ignore and allow-plugins, and never removes or changes an entry it did not write. Composer hashes
// config.policy into composer.lock (Composer 2.11.0+), so a change there means composer update --lock.
import { pluginPatternMatches } from '../../doctor/composer.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { COMPOSER_PREFIX } from '../../policy/package-pattern.ts';
import { extraOf, firstFile, isRecord, settingOf, sinceOf, values } from '../facts.ts';
import { listing } from '../requirements.ts';
import { cooldownValue, eachSource, exclusions } from './common.ts';
import type { Context, JsonFile, ManagerGenerator } from './context.ts';

interface ContentHash {
  file: string;
  key: string;
  settings: string[];
  since: string;
  command: string;
}

const isContentHash = (value: unknown): value is ContentHash =>
  isRecord(value) && typeof value['file'] === 'string' && Array.isArray(value['settings']) && typeof value['command'] === 'string' && typeof value['since'] === 'string';

/** The reason apply writes for a name it adds to an ignore object, whose values are reasons. */
const IGNORE_REASON = `cooldown.exclude in ${POLICY_FILE}`;

/** The value at `path`, and the first part of it that holds something other than an object (where apply cannot write below). */
function blocking(json: JsonFile, path: readonly string[]): { at: string[]; value: unknown } | undefined {
  for (let length = 1; length < path.length; length++) {
    const at = path.slice(0, length);
    const value = json.get(at);
    if (value !== undefined && !isRecord(value)) return { at, value };
  }
  return undefined;
}

function cannotWrite(context: Context, file: string, path: string[], value: unknown, what: string): void {
  context.warn({
    code: 'unexpected-value',
    location: { file },
    message: `${context.name}: ${path.join('.')} in ${file} is ${JSON.stringify(value)}, not an object, so depcurfew apply does not write ${what} below it`,
    fix:
      value === false
        ? `${path.join('.')}: false turns that part of the policy off; remove it from ${file} (depcurfew doctor reports it), then run depcurfew apply again`
        : `Write ${path.join('.')} in ${file} as an object, such as {}, then run depcurfew apply again`,
  });
}

function writeCooldown(context: Context, json: JsonFile, file: string): number | undefined {
  const { tool } = context;
  const setting = settingOf(tool.cooldown.setting) ?? 'config.policy.cooldown.period';
  const path = setting.split('.');
  const cooldown = cooldownValue(context);
  if (cooldown === undefined) return undefined;
  const blocked = blocking(json, path);
  if (blocked !== undefined) {
    cannotWrite(context, file, blocked.at, blocked.value, setting);
    return undefined;
  }
  json.set(path, cooldown.value);

  const excludeSetting = settingOf(tool.cooldown.exclude.setting);
  const patterns = exclusions(context);
  if (excludeSetting === null || patterns === undefined || patterns.length === 0) return cooldown.minutes;
  const ignorePath = excludeSetting.split('.');
  const current = json.get(ignorePath);
  if (current === undefined) {
    json.set(ignorePath, patterns);
  } else if (Array.isArray(current)) {
    for (const pattern of patterns) if (!current.includes(pattern)) json.append(ignorePath, pattern);
  } else if (isRecord(current)) {
    // The object form maps a name to a reason or to rules; a name already there keeps what it says.
    for (const pattern of patterns) if (!Object.hasOwn(current, pattern)) json.set([...ignorePath, pattern], IGNORE_REASON);
  } else {
    context.warn({
      code: 'unexpected-value',
      location: { file },
      message: `${context.name}: ${excludeSetting} in ${file} is ${JSON.stringify(current)}, neither a list nor an object, so depcurfew apply does not add ${listing(patterns)} to it`,
      fix: `Write ${excludeSetting} in ${file} as a list of package names, such as ${JSON.stringify(patterns)}, then run depcurfew apply again`,
    });
  }
  return cooldown.minutes;
}

/**
 * installScripts for Composer is about plugins, the dependency code Composer runs: "deny" lists the allowed ones in
 * allow-plugins (true) and the denied ones (false, which also stops Composer from asking); "allow" sets allow-plugins
 * to true where nothing is set. Patterns are written as they are, because Composer takes them.
 */
function writePlugins(context: Context, json: JsonFile, file: string): void {
  const { tool, policy } = context;
  const scripts = policy.installScripts;
  if (scripts === undefined) return;
  const setting = settingOf(tool.installScripts.allowList.setting) ?? 'config.allow-plugins';
  if (!context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting)) return;
  const path = setting.split('.');
  const blocked = blocking(json, path);
  if (blocked !== undefined) {
    cannotWrite(context, file, blocked.at, blocked.value, setting);
    return;
  }
  const current = json.get(path);
  if (scripts.default === 'allow') {
    // An object written by hand is stricter than the policy; apply does not change entries it did not write.
    if (current === undefined) json.set(path, true);
    if (current === undefined || current === true) context.writes('installScripts', setting, file);
    return;
  }
  const allowed = scripts.allow;
  const denied = scripts.deny;
  if (current === false) {
    // false disallows every plugin, which already keeps the denied ones out.
    if (allowed.length > 0) {
      context.warn({
        code: 'deny-conflicts-with-file',
        location: { file },
        message: `${context.name}: ${setting} in ${file} is false, which blocks every plugin, also ${listing(allowed.map((name) => `${COMPOSER_PREFIX}${name}`))} that installScripts.allow in ${POLICY_FILE} allows; depcurfew apply does not change entries it did not write`,
        fix: `Replace false with an object that lists the plugins to allow, or remove them from installScripts.allow in ${POLICY_FILE}`,
      });
    }
    return;
  }
  if (current === true) {
    context.warn({
      code: 'allow-all-replaced',
      location: { file },
      message: `${context.name}: ${setting} in ${file} allowed every plugin; replaced with the plugins installScripts.allow lists`,
      fix: `Add the plugins that must run to installScripts.allow in ${POLICY_FILE} (with the prefix ${COMPOSER_PREFIX}), then run depcurfew apply again`,
    });
  } else if (current !== undefined && !isRecord(current)) {
    cannotWrite(context, file, path, current, 'the plugins of installScripts');
    return;
  }
  const keys = isRecord(current) ? Object.keys(current) : [];
  const decides = (name: string) => keys.find((key) => pluginPatternMatches(name, key));
  const wanted: [string, boolean][] = [];
  for (const name of allowed) {
    const first = decides(name);
    if (first === undefined) wanted.push([name, true]);
    else if (isRecord(current) && current[first] !== true && first !== name) {
      // Composer takes the first key that matches, so a later entry would not change anything. A key that names the
      // package itself is reported with the other entries of the tool's own lists (deny-conflicts-with-file).
      context.warn({
        code: 'deny-conflicts-with-file',
        location: { file },
        message: `${context.name}: ${setting} in ${file} blocks the plugin ${name} with "${first}": ${JSON.stringify(current[first])}, but installScripts.allow in ${POLICY_FILE} allows it; depcurfew apply does not change entries it did not write`,
        fix: `Set "${first}" to true in ${setting} of ${file} if every plugin it covers may run, or move ${COMPOSER_PREFIX}${name} from installScripts.allow to installScripts.deny in ${POLICY_FILE}`,
      });
    }
  }
  const denial = denyListSince(context);
  for (const name of denied) {
    const first = decides(name);
    if (first === undefined) {
      if (denial === undefined || context.supports(denial, setting)) wanted.push([name, false]);
    } else if (isRecord(current) && current[first] === true && first !== name) {
      context.warn({
        code: 'deny-conflicts-with-file',
        location: { file },
        message: `${context.name}: ${setting} in ${file} lets the plugin ${name} run with "${first}": true, although installScripts.deny in ${POLICY_FILE} says it must not run; depcurfew apply does not change entries it did not write`,
        fix: `Remove "${first}" from ${setting} in ${file} or narrow it, or move ${COMPOSER_PREFIX}${name} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing the plugin`,
      });
    }
  }
  // Named also when the file already lists them, so that explain shows the same before and after apply.
  if (allowed.length > 0 || denied.length > 0) context.writes('installScripts', setting, file);
  if (wanted.length === 0 && current !== true) return;
  if (current === true || current === undefined) {
    json.set(path, Object.fromEntries(wanted));
    return;
  }
  for (const [name, value] of wanted) json.set([...path, name], value);
}

function denyListSince(context: Context): string | undefined {
  const fact = context.tool.extra?.['denyList'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return isRecord(value) && typeof value['since'] === 'string' ? value['since'] : undefined;
}

/** composer.lock hashes config.policy (2.11.0+): after a change there composer install warns and composer validate fails until it is locked again. */
function relockWarning(context: Context, file: string, before: unknown, after: unknown): void {
  const hash = extraOf(context.tool, 'contentHash', isContentHash);
  if (JSON.stringify(before) === JSON.stringify(after) || !context.exists(hash.file) || !context.atLeast(hash.since)) return;
  context.warn({
    code: 'lockfile-out-of-date',
    location: { file: hash.file },
    message: `${context.name}: ${hash.file} records a hash of ${listing(hash.settings)} in ${file}, which this change alters, so ${hash.file} is out of date: composer install warns about it and composer validate fails`,
    fix: `Run ${hash.command}, which writes the new hash without updating packages, and commit ${hash.file}`,
  });
}

export const composer: ManagerGenerator = (context) => {
  const file = firstFile(context.tool.cooldown.configFiles) ?? 'composer.json';
  const json = context.json(file);
  const hash = extraOf(context.tool, 'contentHash', isContentHash);
  const hashed = (setting: string) => (context.exists(file) ? json.get(setting.split('.')) : undefined);
  const before = hash.settings.map(hashed);
  const minutes = context.policy.cooldown === undefined ? undefined : writeCooldown(context, json, file);
  writePlugins(context, json, file);
  eachSource(context, () => undefined);
  relockWarning(context, file, before, hash.settings.map(hashed));
  return minutes;
};
