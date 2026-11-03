// Composer: config.policy.cooldown (period and ignore) and config.allow-plugins in composer.json, the root package.
// JSON has no markers, so a value that is there counts as written by hand: apply sets the period, adds the policy's
// names to ignore and allow-plugins, and never removes or changes an entry it did not write; an ignore entry it wrote
// in the object form carries its reason, which marks it as apply's (decision D-134). Composer hashes config.policy into
// composer.lock (Composer 2.11.0+), so a change there means composer update --lock.
import { ignoreOutsidePolicy, ignoreOutsideText, keyCoveredBy, pluginPatternMatches } from '../../doctor/composer.ts';
import { delayMinutes } from '../../doctor/durations.ts';
import { jsonSetting } from '../../doctor/settings.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { COMPOSER_PREFIX } from '../../policy/package-pattern.ts';
import { extraOf, firstFile, isRecord, settingOf, sinceOf, values } from '../facts.ts';
import { listing } from '../requirements.ts';
import { cooldownValue, eachSource, exclusions, unreadableDelay } from './common.ts';
import type { Context, JsonFile, ManagerGenerator, StrictJson } from './context.ts';
import type { ApplyWarningCode } from '../warnings.ts';

interface ContentHash {
  file: string;
  key: string;
  settings: string[];
  since: string;
  command: string;
}

const isContentHash = (value: unknown): value is ContentHash =>
  isRecord(value) && typeof value['file'] === 'string' && Array.isArray(value['settings']) && typeof value['command'] === 'string' && typeof value['since'] === 'string';

/** The reason apply writes for a name it adds to an ignore object, whose values are reasons; it marks the entry as apply's. */
const IGNORE_REASON = `cooldown.exclude in ${POLICY_FILE}`;

/** composer.json as it was before apply, for the lines its warnings name. */
interface Manifest {
  file: string;
  text: string | undefined;
}

/** The line of the value at `path` in composer.json as it was, when there is one. */
function locationOf(manifest: Manifest, path: readonly (string | number)[]): { file: string; line?: number } {
  const line = manifest.text === undefined ? undefined : jsonSetting(manifest.text, path)?.line;
  return line === undefined ? { file: manifest.file } : { file: manifest.file, line };
}

/** " (line N)" for a message, when the line is known. */
function lineText(location: { line?: number }): string {
  return location.line === undefined ? '' : ` (line ${location.line})`;
}

/**
 * The first part of `path` that holds something other than an object, where apply cannot write below. Composer reads
 * true for config.policy and for a policy below it as {} (Config::merge), so apply writes its object there.
 */
function blocking(json: JsonFile, path: readonly string[]): { at: string[]; value: unknown } | undefined {
  for (let length = 1; length < path.length; length++) {
    const at = path.slice(0, length);
    const value = json.get(at);
    const sameAsObject = value === true && at[0] === 'config' && at[1] === 'policy';
    if (value !== undefined && !isRecord(value) && !sameAsObject) return { at, value };
  }
  return undefined;
}

function cannotWrite(context: Context, manifest: Manifest, code: ApplyWarningCode, path: string[], value: unknown, what: string): void {
  const location = locationOf(manifest, path);
  const prefix = code === 'cooldown-not-written' ? `${context.name}: cooldown not written: ` : `${context.name}: `;
  context.warn({
    code,
    location,
    message: `${prefix}${path.join('.')} in ${manifest.file}${lineText(location)} is ${JSON.stringify(value)}, not an object, so depcurfew apply does not write ${what} below it`,
    fix:
      value === false
        ? `${path.join('.')}: false turns that Composer protection off; remove it from ${manifest.file} (depcurfew doctor reports it), then run depcurfew apply again`
        : `Write ${path.join('.')} in ${manifest.file} as an object, such as {}, then run depcurfew apply again`,
  });
}

function writeCooldown(context: Context, json: JsonFile, manifest: Manifest): number | undefined {
  const { tool } = context;
  const setting = settingOf(tool.cooldown.setting) ?? 'config.policy.cooldown.period';
  const path = setting.split('.');
  const cooldown = cooldownValue(context);
  if (cooldown === undefined) return undefined;
  const blocked = blocking(json, path);
  if (blocked !== undefined) {
    cannotWrite(context, manifest, 'cooldown-not-written', blocked.at, blocked.value, setting);
    return undefined;
  }
  // The same delay written another way (259200 seconds, "72 hours") stays, so that composer.lock stays up to date.
  const current = json.get(path);
  // A value depcurfew cannot read ("1 month", "P30D", "30d", which Composer rejects too) stays as it is (decision D-167).
  const kept = unreadableDelay(context, manifest.file, setting, current, locationOf(manifest, path).line, cooldown);
  const written = current === undefined ? undefined : delayMinutes(tool, current, undefined);
  if (!kept && (written === undefined || !written.ok || written.minutes !== cooldown.minutes)) json.set(path, cooldown.value);
  writeExclusions(context, json, manifest);
  return kept ? undefined : cooldown.minutes;
}

/**
 * The composer: names of cooldown.exclude in config.policy.cooldown.ignore: a new list, added to a list, or added to an
 * object with apply's reason. An object entry with that reason whose name the policy no longer lists is apply's own and
 * is removed; any other entry the policy does not cover stays, with a warning.
 */
function writeExclusions(context: Context, json: JsonFile, manifest: Manifest): void {
  const { tool } = context;
  const excludeSetting = settingOf(tool.cooldown.exclude.setting);
  const patterns = exclusions(context);
  if (excludeSetting === null || patterns === undefined) return;
  const ignorePath = excludeSetting.split('.');
  const current = json.get(ignorePath);
  const listed = (names: readonly unknown[], pattern: string) => names.some((name) => typeof name === 'string' && name.toLowerCase() === pattern);
  if (current === undefined) {
    if (patterns.length > 0) json.set(ignorePath, patterns);
  } else if (Array.isArray(current)) {
    for (const pattern of patterns) if (!listed(json.get(ignorePath) as unknown[], pattern)) json.append(ignorePath, pattern);
  } else if (isRecord(current)) {
    for (const [key, value] of Object.entries(current)) if (value === IGNORE_REASON && !keyCoveredBy(key, patterns)) json.removeKey(ignorePath, key);
    // The object form maps a name to a reason or to rules; a name already there keeps what it says.
    for (const pattern of patterns) if (!listed(Object.keys(current), pattern)) json.set([...ignorePath, pattern], IGNORE_REASON);
  } else {
    if (patterns.length > 0) {
      const location = locationOf(manifest, ignorePath);
      context.warn({
        code: 'exclude-not-written',
        location,
        message: `${context.name}: ${excludeSetting} in ${manifest.file}${lineText(location)} is ${JSON.stringify(current)}, neither a list nor an object, so depcurfew apply does not add ${listing(patterns)} to it`,
        fix: `Write ${excludeSetting} in ${manifest.file} as a list of package names, such as ${JSON.stringify(patterns)}, then run depcurfew apply again`,
      });
    }
    return;
  }
  const hash = extraOf(tool, 'contentHash', isContentHash);
  const planned = context.exists(manifest.file) ? context.read(manifest.file) : undefined;
  for (const entry of ignoreOutsidePolicy(manifest.text, planned, ignorePath, patterns)) {
    const text = ignoreOutsideText(entry, { setting: excludeSetting, file: manifest.file, policyFile: POLICY_FILE, relock: hash.command }, true);
    context.warn({
      code: 'exclude-entry-outside-policy',
      location: entry.line === undefined ? { file: manifest.file } : { file: manifest.file, line: entry.line },
      message: `${context.name}: ${text.message}; depcurfew apply removes only the entries it wrote, with the reason ${JSON.stringify(IGNORE_REASON)}`,
      fix: text.fix,
    });
  }
}

/**
 * installScripts for Composer is about plugins, the dependency code Composer runs: "deny" lists the allowed ones in
 * allow-plugins (true) and the denied ones (false, which also stops Composer from asking); "allow" sets allow-plugins
 * to true where nothing is set. Patterns are written as they are, because Composer takes them.
 */
function writePlugins(context: Context, json: JsonFile, manifest: Manifest): void {
  const { tool, policy } = context;
  const { file } = manifest;
  const scripts = policy.installScripts;
  if (scripts === undefined) return;
  const setting = settingOf(tool.installScripts.allowList.setting) ?? 'config.allow-plugins';
  if (!context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting)) return;
  const path = setting.split('.');
  const blocked = blocking(json, path);
  if (blocked !== undefined) {
    cannotWrite(context, manifest, 'unexpected-value', blocked.at, blocked.value, setting);
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
  const here = locationOf(manifest, path);
  if (current === false) {
    // false disallows every plugin, which already keeps the denied ones out.
    if (allowed.length > 0) {
      context.warn({
        code: 'deny-conflicts-with-file',
        location: here,
        message: `${context.name}: ${setting} in ${file}${lineText(here)} is false, which blocks every plugin, also ${listing(allowed.map((name) => `${COMPOSER_PREFIX}${name}`))} that installScripts.allow in ${POLICY_FILE} allows; depcurfew apply does not change entries it did not write`,
        fix: `Replace false with an object that lists the plugins to allow, or remove them from installScripts.allow in ${POLICY_FILE}`,
      });
    }
    return;
  }
  if (current === true) {
    context.warn({
      code: 'allow-all-replaced',
      location: here,
      message: `${context.name}: ${setting} in ${file}${lineText(here)} allowed every plugin; replaced with the plugins installScripts.allow lists`,
      fix: `Add the plugins that must run to installScripts.allow in ${POLICY_FILE} (with the prefix ${COMPOSER_PREFIX}), then run depcurfew apply again`,
    });
  } else if (current !== undefined && !isRecord(current)) {
    cannotWrite(context, manifest, 'unexpected-value', path, current, 'the plugins of installScripts');
    return;
  }
  const keys = isRecord(current) ? Object.keys(current) : [];
  const decides = (name: string) => keys.find((key) => pluginPatternMatches(name, key));
  // A key that names the package itself, in any case, is reported with the other entries of the tool's own lists
  // (allow-list-entry-outside-policy, deny-conflicts-with-file); here only an earlier pattern that decides it.
  const isPattern = (key: string, name: string) => key.toLowerCase() !== name;
  const wanted: [string, boolean][] = [];
  for (const name of allowed) {
    const first = decides(name);
    if (first === undefined) wanted.push([name, true]);
    else if (isRecord(current) && current[first] !== true && isPattern(first, name)) {
      // Composer takes the first key that matches, so a later entry would not change anything.
      const location = locationOf(manifest, [...path, first]);
      context.warn({
        code: 'deny-conflicts-with-file',
        location,
        message: `${context.name}: ${setting} in ${file}${lineText(location)} blocks the plugin ${name} with "${first}": ${JSON.stringify(current[first])}, but installScripts.allow in ${POLICY_FILE} allows it; depcurfew apply does not change entries it did not write`,
        fix: `Put "${name}": true before "${first}" in ${setting} of ${file}, because Composer takes the first key that matches, or move ${COMPOSER_PREFIX}${name} from installScripts.allow to installScripts.deny in ${POLICY_FILE}`,
      });
    }
  }
  const denial = denyListSince(context);
  for (const name of denied) {
    const first = decides(name);
    if (first === undefined) {
      if (denial === undefined || context.supports(denial, setting)) wanted.push([name, false]);
    } else if (isRecord(current) && current[first] === true && isPattern(first, name)) {
      const location = locationOf(manifest, [...path, first]);
      context.warn({
        code: 'deny-conflicts-with-file',
        location,
        message: `${context.name}: ${setting} in ${file}${lineText(location)} lets the plugin ${name} run with "${first}": true, although installScripts.deny in ${POLICY_FILE} says it must not run; depcurfew apply does not change entries it did not write`,
        fix: `Put "${name}": false before "${first}" in ${setting} of ${file}, because Composer takes the first key that matches, or move ${COMPOSER_PREFIX}${name} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing the plugin`,
      });
    }
  }
  // Named also when the file already lists them, so that explain shows the same before and after apply, and when
  // apply replaces true.
  if (allowed.length > 0 || denied.length > 0 || current === true) context.writes('installScripts', setting, file);
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
  // Only whether composer.lock is there counts: it is not read, so its size does not matter (decision D-166).
  if (JSON.stringify(before) === JSON.stringify(after) || !context.isFile(hash.file) || !context.atLeast(hash.since)) return;
  context.warn({
    code: 'lockfile-out-of-date',
    location: { file: hash.file },
    message: `${context.name}: ${hash.file} records a hash of ${listing(hash.settings)} in ${file}, which this change alters, so ${hash.file} is out of date: composer install warns about it and composer validate fails`,
    fix: `Run ${hash.command}, which writes the new hash without updating packages, and commit ${hash.file}`,
  });
}

/** Composer reads composer.json as strict JSON (extra.manifestSyntax, decision D-141), so apply does not edit one with a comment or trailing comma. */
function strictness(context: Context, file: string): StrictJson | undefined {
  const fact = context.tool.extra?.['manifestSyntax'] === undefined ? undefined : extraOf(context.tool, 'manifestSyntax', isRecord);
  if (fact === undefined || (fact['comments'] !== false && fact['trailingCommas'] !== false)) return undefined;
  return {
    reason: `Composer reads ${file} with json_decode, which takes no comments or trailing commas, so every Composer command stops on it`,
    fix: `Remove the comment or trailing comma from ${file} (composer validate shows where), then run depcurfew apply again`,
  };
}

export const composer: ManagerGenerator = (context) => {
  const file = firstFile(context.tool.cooldown.configFiles) ?? 'composer.json';
  const manifest: Manifest = { file, text: context.exists(file) ? context.read(file) : undefined };
  const json = context.json(file, strictness(context, file));
  // Refused before anything is planned for the file: get checks the syntax (cannot-edit).
  if (manifest.text !== undefined) json.get([]);
  const hash = extraOf(context.tool, 'contentHash', isContentHash);
  const hashed = (setting: string) => (context.exists(file) ? json.get(setting.split('.')) : undefined);
  const before = hash.settings.map(hashed);
  const minutes = context.policy.cooldown === undefined ? undefined : writeCooldown(context, json, manifest);
  writePlugins(context, json, manifest);
  eachSource(context, () => undefined);
  relockWarning(context, file, before, hash.settings.map(hashed));
  return minutes;
};
