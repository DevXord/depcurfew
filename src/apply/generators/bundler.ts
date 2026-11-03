// Bundler: the cooldown: keyword of the source "https://rubygems.org" call in the Gemfile (or gems.rb), in whole days,
// rounded up (decision D-152). The Gemfile is committed, so the whole team and CI get the delay; .bundle/config,
// whose cooldown setting would apply to every source, is usually local and git-ignored, and is only checked by doctor.
// apply edits a plain source call only and reports any other form. Bundler has no per-gem exception, no setting that
// stops the build of native extensions and none for git or path sources, so apply says what it cannot write.
import { gemfileIn, gemfileSources, sameServer, setSourceCooldown, type GemfileSource } from '../gemfile.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { cooldownValue, eachSource } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isGap = (value: unknown): value is { since: string; scope: string } => isRecord(value) && typeof value['since'] === 'string' && typeof value['scope'] === 'string';
const isServer = (value: unknown): value is { url: string } => isRecord(value) && typeof value['url'] === 'string';

/** The Gemfile Bundler reads in the directory planned: gems.rb when it is there, otherwise Gemfile. */
export function plannedGemfile(context: Pick<Context, 'tool' | 'exists'>): string {
  const names = context.tool.extra?.['gemfileNames'] === undefined ? ['gems.rb', 'Gemfile'] : extraOf(context.tool, 'gemfileNames', isStrings);
  return gemfileIn((file) => context.exists(file), names);
}

/** Why apply does not edit a source call, for messages. */
function whyNotPlain(source: GemfileSource): string {
  if (source.block) return 'it has a block, so it is the source of the gems in the block only';
  if (source.cooldown === 'other') return 'its cooldown: is not a number';
  return 'it is not written as a plain source "<URL>" call on a line of its own';
}

function writeCooldown(context: Context, file: string, days: number, server: string): boolean {
  const setting = settingOf(context.tool.cooldown.setting) ?? 'cooldown';
  const text = context.read(file);
  const sources = gemfileSources(text);
  const ours = sources.filter((source) => source.url !== undefined && sameServer(source.url, server));
  const plain = ours.filter((source) => source.plain);
  for (const source of ours.filter((item) => !item.plain)) {
    context.warn({
      code: 'cooldown-not-written',
      location: { file, line: source.line },
      message: `${context.name}: cooldown not written: the source "${server}" call on line ${source.line} of ${file} is not edited, because ${whyNotPlain(source)}; depcurfew apply edits only a plain source "${server}" call on a line of its own`,
      fix: `Add ${setting}: ${days} to that call by hand (source "${server}", ${setting}: ${days}${source.block ? ' do' : ''}), or write it as a plain call on a line of its own and run depcurfew apply again`,
    });
  }
  if (plain.length > 0) {
    if (plain.some((source) => source.cooldown !== days)) context.text(file, (body) => setSourceCooldown(body, plain.map((source) => source.line), days));
    return true;
  }
  // A source call whose URL depcurfew cannot read (a variable, an interpolated string) may name rubygems.org.
  const unread = sources.filter((source) => source.url === undefined);
  for (const source of unread) {
    context.warn({
      code: 'cooldown-not-written',
      location: { file, line: source.line },
      message: `${context.name}: cooldown not written: the URL of the source call on line ${source.line} of ${file} is not a literal string, so depcurfew cannot tell whether it is "${server}"`,
      fix: `If it names rubygems.org, write it as source "${server}" on a line of its own and run depcurfew apply again, or add ${setting}: ${days} to that call by hand`,
    });
  }
  if (ours.length > 0 || unread.length > 0) return false;
  context.warn({
    code: 'cooldown-not-written',
    location: { file },
    message: `${context.name}: cooldown not written: ${file} has no source "${server}" call, and depcurfew configures the cooldown of Bundler only on that source`,
    fix: `If the gems come from another gem server, add ${setting}: ${days} to its source call by hand (Bundler holds back only versions the server gives a created_at date); if they come from rubygems.org, add source "${server}" to ${file} and run depcurfew apply again`,
  });
  return false;
}

export const bundler: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const file = plannedGemfile(context);
    const cooldown = cooldownValue(context);
    const lockfiles = tool.project === undefined ? [] : (values(tool.project.lockfiles)[0] ?? []).flatMap((entry) => [...entry.value]);
    const locked = lockfiles.some((name) => context.exists(name));
    // Before 4.0.14 Bundler lost the keyword of a Gemfile source once Gemfile.lock existed (extra.cooldownWithLockfile).
    const gap = tool.extra?.['cooldownWithLockfile'] === undefined ? undefined : extraOf(tool, 'cooldownWithLockfile', isGap);
    const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
    // Checked also when the version has no cooldown at all, so that version-too-old names the version that is needed.
    const keeps = !locked || gap === undefined || context.supports(gap.since, `${setting} ${gap.scope}`);
    const usable = cooldown !== undefined && keeps;
    if (cooldown !== undefined && usable && typeof cooldown.value === 'number') {
      if (!context.exists(file)) {
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
