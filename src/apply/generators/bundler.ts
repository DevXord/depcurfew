// Bundler: the cooldown: keyword of the source "https://rubygems.org" call in the Gemfile (or gems.rb), in whole days,
// rounded up (decision D-152). The Gemfile is committed, so the whole team and CI get the delay; .bundle/config,
// whose cooldown setting would apply to every source, is usually local and git-ignored, and is only checked by doctor.
// apply edits a plain source call only and reports any other form, and edits nothing in a Gemfile it cannot read as
// Ruby does (decision D-159). Bundler has no per-gem exception, no setting that stops the build of native extensions
// and none for git or path sources, so apply says what it cannot write.
import { gemfileIn, readGemfile, sameServer, setSourceCooldown, type GemfileSource } from '../gemfile.ts';
import type { ScanUnknown } from '../gemfile-scan.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { cooldownValue, eachSource } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isGap = (value: unknown): value is { since: string; scope: string } => isRecord(value) && typeof value['since'] === 'string' && typeof value['scope'] === 'string';
const isServer = (value: unknown): value is { url: string } => isRecord(value) && typeof value['url'] === 'string';

/**
 * The Gemfile Bundler reads in the directory planned: gems.rb when it is a regular file there, otherwise Gemfile. The
 * names are only looked at (File.file?, extra.gemfileNames), so a directory named gems.rb stops nothing.
 */
export function plannedGemfile(context: Pick<Context, 'tool' | 'isFile'>): string {
  const names = context.tool.extra?.['gemfileNames'] === undefined ? ['gems.rb', 'Gemfile'] : extraOf(context.tool, 'gemfileNames', isStrings);
  return gemfileIn((file) => context.isFile(file), names);
}

/** Why apply does not edit a source call, for messages. */
function whyNotPlain(source: GemfileSource, file: string, setting: string): string {
  if (source.nested === true) return `it is not at the top level of ${file} (it is inside a block, a method, a class, a condition, a loop, begin or brackets), so Ruby runs it only when that code runs`;
  if (source.repeated === true) return `it gives ${setting}: more than once, and which value Bundler takes depends on how Ruby merges the keys`;
  if (source.block) return 'it has a block, so it is the source of the gems in the block only';
  if (source.cooldown === 'other') return `its ${setting}: is not a whole number written as a Ruby integer`;
  return 'it is not written as a plain source "<URL>" call on a line of its own';
}

/**
 * What to do about a source call apply does not edit. Never a shorter cooldown than the call has: one that already
 * waits as long as the policy needs is left as it is (decision D-159).
 */
function fixFor(source: GemfileSource, server: string, setting: string, days: number, file: string): string {
  const plain = source.nested === true ? `move it to the top level of ${file} as a plain call on a line of its own` : 'write it as a plain call on a line of its own';
  const plainly = `or ${plain} and run depcurfew apply again`;
  if (source.repeated === true) return `Keep a single ${setting}: ${days} in that call by hand in place of its ${setting}: keys, ${plainly}`;
  if (typeof source.cooldown === 'number' && source.cooldown >= days) {
    return `No change is needed as long as Ruby runs that call: its ${setting}: ${source.cooldown} is not shorter than the ${days} days of ${POLICY_FILE}. To let depcurfew check it, ${plain} and set cooldown.minimum in ${POLICY_FILE} to "${source.cooldown}d", so that depcurfew apply keeps ${source.cooldown}`;
  }
  if (typeof source.cooldown === 'number') return `Change ${setting}: ${source.cooldown} to ${setting}: ${days} in that call by hand, ${plainly}`;
  if (source.cooldown === 'other') return `Write ${setting}: ${days} in that call by hand in place of its value, ${plainly}`;
  return `Add ${setting}: ${days} to that call by hand (source "${server}", ${setting}: ${days}${source.block ? ' do' : ''}), ${plainly}`;
}

/** The longest cooldown: of the plain rubygems.org calls read before the place depcurfew stopped reading. */
function cooldownBefore(sources: readonly GemfileSource[], server: string): GemfileSource | undefined {
  let best: GemfileSource | undefined;
  for (const source of sources) {
    if (!source.plain || source.url === undefined || !sameServer(source.url, server) || typeof source.cooldown !== 'number') continue;
    if (typeof best?.cooldown !== 'number' || source.cooldown > best.cooldown) best = source;
  }
  return best;
}

/** cooldown-not-written for a Gemfile depcurfew does not read with certainty. */
function notUnderstood(context: Context, file: string, unknown: ScanUnknown, sources: readonly GemfileSource[], days: number, server: string, setting: string): void {
  const kept = cooldownBefore(sources, server);
  const where = `on line ${unknown.line} of ${file}, ${unknown.fix}`;
  context.warn({
    code: 'cooldown-not-written',
    location: { file, line: unknown.line },
    message: `${context.name}: cooldown not written: depcurfew cannot read ${file} as Ruby does from line ${unknown.line} on, because ${unknown.reason}; it does not edit a Gemfile it cannot read with certainty`,
    fix:
      typeof kept?.cooldown === 'number' && kept.cooldown >= days
        ? `No change is needed if Ruby reads ${file} as written: the source "${server}" call on line ${kept.line} has ${setting}: ${kept.cooldown}, not shorter than the ${days} days of ${POLICY_FILE}. To let depcurfew check it, ${where}, then run depcurfew apply again`
        : `${where.charAt(0).toUpperCase()}${where.slice(1)}, then run depcurfew apply again; or add ${setting}: ${days} to the source "${server}" call by hand (source "${server}", ${setting}: ${days})`,
  });
}

/**
 * Whether the cooldown the policy needs may already hold at the place a cooldown-not-written of Bundler names: the
 * call there (or a plain call before a place depcurfew stopped reading) already has at least `days`, or, in a Gemfile
 * without a rubygems.org source (no line), every source call has. doctor reports such a place as a warning rather than
 * an error (decision D-159).
 */
export function cooldownMayHold(text: string, line: number | undefined, days: number, server = 'https://rubygems.org'): boolean {
  const reading = readGemfile(text);
  if (line === undefined) return reading.unknown === undefined && otherServersWait(reading.sources, days);
  if (reading.unknown?.line === line) {
    const kept = cooldownBefore(reading.sources, server);
    return typeof kept?.cooldown === 'number' && kept.cooldown >= days;
  }
  const source = reading.sources.find((item) => item.line === line);
  return typeof source?.cooldown === 'number' && source.cooldown >= days;
}

function writeCooldown(context: Context, file: string, days: number, server: string): boolean {
  const setting = settingOf(context.tool.cooldown.setting) ?? 'cooldown';
  // The text apply edits has \r\n as \n already (decision D-163).
  const text = context.read(file);
  const reading = readGemfile(text, { newlinesRead: true });
  if (reading.unknown !== undefined) {
    notUnderstood(context, file, reading.unknown, reading.sources, days, server, setting);
    return false;
  }
  const sources = reading.sources;
  const ours = sources.filter((source) => source.url !== undefined && sameServer(source.url, server));
  const plain = ours.filter((source) => source.plain);
  for (const source of ours.filter((item) => !item.plain)) {
    context.warn({
      code: 'cooldown-not-written',
      location: { file, line: source.line },
      message: `${context.name}: cooldown not written: the source "${server}" call on line ${source.line} of ${file} is not edited, because ${whyNotPlain(source, file, setting)}; depcurfew apply edits only a plain source "${server}" call on a line of its own`,
      fix: fixFor(source, server, setting, days, file),
    });
  }
  // A source call whose URL depcurfew cannot read (a variable, an interpolated string) may name rubygems.org, and Ruby
  // may run it in place of a plain call, which may sit in code that never runs: it is reported also next to a plain
  // call (decision D-163).
  const unread = sources.filter((source) => source.url === undefined);
  for (const source of unread) {
    context.warn({
      code: 'cooldown-not-written',
      location: { file, line: source.line },
      message: `${context.name}: cooldown not written: the URL of the source call on line ${source.line} of ${file} is not a literal string, so depcurfew cannot tell whether it is "${server}"`,
      fix:
        typeof source.cooldown === 'number' && source.cooldown >= days
          ? `No change is needed if it names rubygems.org and Ruby runs it: its ${setting}: ${source.cooldown} is not shorter than the ${days} days of ${POLICY_FILE}; to let depcurfew check it, write it as source "${server}" on a line of its own`
          : `If it names rubygems.org, write it as source "${server}" on a line of its own and run depcurfew apply again, or add ${setting}: ${days} to that call by hand`,
    });
  }
  if (plain.length > 0) {
    if (plain.some((source) => source.cooldown !== days)) context.text(file, (body) => setSourceCooldown(body, plain.map((source) => source.line), days, { newlinesRead: true }));
    return true;
  }
  if (ours.length > 0 || unread.length > 0) return false;
  context.warn({
    code: 'cooldown-not-written',
    location: { file },
    message: `${context.name}: cooldown not written: ${file} has no source "${server}" call, and depcurfew configures the cooldown of Bundler only on that source`,
    fix: otherServersWait(sources, days)
      ? `No change is needed if the gems come from the gem servers of ${file}: the ${setting}: of each source call is not shorter than the ${days} days of ${POLICY_FILE} (Bundler holds back only versions the server gives a created_at date); if they come from rubygems.org, add source "${server}" to ${file} and run depcurfew apply again`
      : `If the gems come from another gem server, add ${setting}: ${days} to its source call by hand (Bundler holds back only versions the server gives a created_at date); if they come from rubygems.org, add source "${server}" to ${file} and run depcurfew apply again`,
  });
  return false;
}

/** Whether a Gemfile without a rubygems.org source has source calls, each with a cooldown of at least `days`. */
function otherServersWait(sources: readonly GemfileSource[], days: number): boolean {
  return sources.length > 0 && sources.every((source) => typeof source.cooldown === 'number' && source.cooldown >= days);
}

export const bundler: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const file = plannedGemfile(context);
    const cooldown = cooldownValue(context);
    const lockfiles = tool.project === undefined ? [] : (values(tool.project.lockfiles)[0] ?? []).flatMap((entry) => [...entry.value]);
    // Bundler only tests whether the lockfile is there (File.exist?, extra.lockfileExists); apply never reads it.
    const locked = lockfiles.some((name) => context.present(name));
    // Before 4.0.14 Bundler lost the keyword of a Gemfile source once Gemfile.lock existed (extra.cooldownWithLockfile).
    const gap = tool.extra?.['cooldownWithLockfile'] === undefined ? undefined : extraOf(tool, 'cooldownWithLockfile', isGap);
    const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
    // Checked also when the version has no cooldown at all, so that version-too-old names the version that is needed.
    const keeps = !locked || gap === undefined || context.supports(gap.since, `${setting} ${gap.scope}`);
    const usable = cooldown !== undefined && keeps;
    if (cooldown !== undefined && usable && typeof cooldown.value === 'number') {
      if (!context.isFile(file)) {
        context.warn({
          code: 'manifest-missing',
          location: { file },
          message: `${context.name}: there is no ${file}, so ${setting} is not written; depcurfew does not create project manifests`,
          fix: policy.targets === 'auto' ? `If ${context.name} installs gems for this project, create ${file} first, then run depcurfew apply again` : `If ${context.name} installs gems for this project, create ${file} first, then run depcurfew apply again; otherwise remove "${tool.id}" from targets in ${POLICY_FILE}`,
        });
      } else {
        const server = tool.extra?.['rubygemsSource'] === undefined ? 'https://rubygems.org' : extraOf(tool, 'rubygemsSource', isServer).url;
        if (writeCooldown(context, file, cooldown.value, server)) minutes = cooldown.minutes;
      }
    }
    // The policy's exceptions name npm, Python and Composer packages: none of them is a gem, and Bundler has no setting
    // for one either (cooldown.exclude.setting).
    if (context.policyExclusions.length > 0 && settingOf(tool.cooldown.exclude.setting) === null) {
      const update = tool.extra?.['updateCommand'] === undefined ? undefined : values(tool.extra['updateCommand'])[0];
      context.warn({
        code: 'exclude-unsupported',
        message: `${context.name}: no setting exempts single gems from ${setting}, so every gem waits; the exceptions of cooldown.exclude in ${POLICY_FILE} name no Ruby gems and are not applied to ${context.name}`,
        fix: `Nothing to set for ${context.name}. To take a newer version of one gem sooner, review it and run ${typeof update === 'string' ? update : 'bundle update GEM --cooldown 0'} for that gem`,
      });
    }
  }

  // Native extensions are built, and run their build code, when a gem is installed; nothing in Bundler stops them.
  if (policy.installScripts?.default === 'deny' && settingOf(tool.installScripts.disableAll) === null && settingOf(tool.installScripts.allowList.setting) === null) {
    context.warn({
      code: 'scripts-not-enforceable',
      message: `${context.name} builds the native extensions of gems when it installs them, which runs code of the gem (extconf.rb, a Rakefile), and has no setting that blocks this or allows it for some gems only, so installScripts "deny" cannot be enforced`,
      fix: `Review gems with native extensions (extensions in the gemspec, an ext directory) before you add or update them; there is nothing to set for ${context.name}`,
    });
  }

  // Only git and path sources exist in a Gemfile (extra.dependencySources); a Gemfile has no archive sources to deny.
  const kinds = tool.extra?.['dependencySources'] === undefined ? undefined : extraOf(tool, 'dependencySources', isStrings);
  const sources = policy.sources === undefined || kinds === undefined ? policy.sources : Object.fromEntries(Object.entries(policy.sources).filter(([kind]) => kinds.includes(kind)));
  eachSource({ ...context, policy: { ...policy, ...(sources === undefined ? {} : { sources }) } }, () => undefined);
  return minutes;
};
