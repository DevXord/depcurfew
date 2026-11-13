// Cargo (E07): registry.global-min-publish-age in a managed block of the [registry] table of .cargo/config.toml, the
// file Cargo reads in the directory and its parents. A value written by hand is replaced (a longer one is reported by
// the comparison of delays, cooldown-shortened); one depcurfew cannot read, or a span Cargo may wrap, stays with
// cooldown-not-written. Settings of the same file that undo the delay stay and are reported (cooldown-overridden). The
// older name .cargo/config is not edited: Cargo uses it over config.toml, so the fix is to rename it.
import { delayMinutes, formatMinutes } from '../../doctor/durations.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { cooldownValue, eachSource, unreadableDelay } from './common.ts';
import type { ManagerGenerator } from './context.ts';
import { tomlCurrent, tomlValue } from './python.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Key and table of a dotted setting: registry.global-min-publish-age is global-min-publish-age in [registry]. */
function split(setting: string): { table: string; key: string } {
  const at = setting.lastIndexOf('.');
  return at === -1 ? { table: '', key: setting } : { table: setting.slice(0, at), key: setting.slice(at + 1) };
}

export const cargo: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = values(tool.cooldown.configFiles)[0]?.[0] ?? '.cargo/config.toml';
  const legacy = extraOf(tool, 'legacyConfig', isRecord);
  const legacyFile = typeof legacy['file'] === 'string' ? legacy['file'] : undefined;
  const setting = settingOf(tool.cooldown.setting) ?? 'registry.global-min-publish-age';
  const { table, key } = split(setting);
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    // Written also for a Rust older than 1.100.0, which ignores it (version-too-old), so that it works once Rust is updated.
    const cooldown = cooldownValue(context, undefined, { olderToo: true });
    if (legacyFile !== undefined && context.exists(legacyFile)) {
      const both = context.exists(file);
      context.warn({
        code: 'cooldown-not-written',
        location: { file: legacyFile },
        message: `${context.name}: cooldown not written: the Cargo configuration of this directory is ${legacyFile}, the older name, which depcurfew apply does not edit`,
        fix: both
          ? `Move the settings of ${legacyFile} into ${file} and delete ${legacyFile} (Cargo reads ${legacyFile} and ignores ${file} when both are there), then run depcurfew apply again`
          : `Rename ${legacyFile} to ${file}, the name Cargo prefers (it reads both), then run depcurfew apply again`,
      });
    } else if (cooldown !== undefined) {
      const current = tomlCurrent(context, file, table, key);
      if (!unreadableDelay(context, file, setting, current?.value, current?.line, cooldown)) {
        context.toml(file, table, [`${key} = ${tomlValue(cooldown.value)}`], [key]);
        minutes = cooldown.minutes;
        overrides(context, file, cooldown.minutes);
      }
      limits(context, file, key);
    }
    // The policy's exceptions name npm, Python and Composer packages, and Cargo has no setting for single crates.
    if (context.policyExclusions.length > 0 && settingOf(tool.cooldown.exclude.setting) === null) {
      context.warn({
        code: 'exclude-unsupported',
        message: `${context.name}: no setting exempts single crates from ${key}, so every crate waits; the exceptions of cooldown.exclude in ${POLICY_FILE} name no Rust crates and are not applied to ${context.name}`,
        fix: `Nothing to set for ${context.name}. To take a newer version of one crate sooner, review it and run cargo update --precise for it with CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow for that command only`,
      });
    }
  }

  // Build scripts (build.rs) and procedural macros of dependencies run at cargo build, check and test.
  if (policy.installScripts?.default === 'deny' && settingOf(tool.installScripts.disableAll) === null && settingOf(tool.installScripts.allowList.setting) === null) {
    context.warn({
      code: 'scripts-not-enforceable',
      message: `${context.name} compiles and runs the build scripts (build.rs) of dependencies, and their procedural macros run in the compiler, at cargo build, check and test; nothing in ${context.name} blocks this or allows it for some crates only, so installScripts "deny" cannot be enforced`,
      fix: `Review crates with a build.rs or a proc-macro crate type before you add or update them; there is nothing to set for ${context.name}`,
    });
  }

  // Cargo has git and path dependencies only (extra.dependencySources): no tarball URLs or archives to deny.
  const kinds = tool.extra?.['dependencySources'] === undefined ? undefined : extraOf(tool, 'dependencySources', isStrings);
  const sources = policy.sources === undefined || kinds === undefined ? policy.sources : Object.fromEntries(Object.entries(policy.sources).filter(([kind]) => kinds.includes(kind)));
  eachSource({ ...context, policy: { ...policy, ...(sources === undefined ? {} : { sources }) } }, () => undefined);
  return minutes;
};

/** The settings of the file that undo the delay apply writes: the resolver switch, and a shorter value for crates.io. */
function overrides(context: Parameters<ManagerGenerator>[0], file: string, written: number): void {
  const { tool } = context;
  const resolver = extraOf(tool, 'resolverSwitch', isRecord);
  const registry = extraOf(tool, 'registryMinPublishAge', isRecord);
  const turnsOff = typeof resolver['turnsOff'] === 'string' ? resolver['turnsOff'] : 'allow';
  if (typeof resolver['key'] === 'string') {
    const { table, key } = split(resolver['key']);
    const current = tomlCurrent(context, file, table, key);
    if (current?.value === turnsOff) {
      const where = current.line === undefined ? '' : ` (line ${current.line})`;
      context.warn({
        code: 'cooldown-overridden',
        location: current.line === undefined ? { file } : { file, line: current.line },
        message: `${context.name}: ${resolver['key']} = ${JSON.stringify(turnsOff)} in ${file}${where} turns the release-age delay off, the one depcurfew apply writes included`,
        fix: `Remove ${resolver['key']} from ${file}, or set it to "deny"; for one version that has to come sooner, use cargo update --precise with it for that command only`,
      });
    }
  }
  const cratesIo = typeof registry['cratesIo'] === 'string' ? registry['cratesIo'] : 'crates-io';
  const key = typeof registry['key'] === 'string' ? (registry['key'].split('.').at(-1) ?? 'min-publish-age') : 'min-publish-age';
  const current = tomlCurrent(context, file, `registries.${cratesIo}`, key);
  if (current === undefined) return;
  const delay = delayMinutes(tool, current.value, context.version);
  if (delay.ok && delay.minutes >= written) return;
  const where = current.line === undefined ? '' : ` (line ${current.line})`;
  context.warn({
    code: 'cooldown-overridden',
    location: current.line === undefined ? { file } : { file, line: current.line },
    message: `${context.name}: registries.${cratesIo}.${key} in ${file}${where} is ${JSON.stringify(current.value)}, which takes the place of the ${formatMinutes(written)} depcurfew apply writes for crates.io`,
    fix: `Remove ${key} from [registries.${cratesIo}] in ${file}, or set it to at least the ${formatMinutes(written)} of cooldown.minimum in ${POLICY_FILE}`,
  });
}

/** What Cargo's delay does not cover (extra.notCovered), once per directory. */
function limits(context: Parameters<ManagerGenerator>[0], file: string, key: string): void {
  const environment = extraOf(context.tool, 'environment', isRecord);
  const global = typeof environment['global'] === 'string' ? environment['global'] : 'CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE';
  const resolver = typeof environment['resolver'] === 'string' ? environment['resolver'] : 'CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE';
  context.warn({
    code: 'cooldown-limits',
    location: { file },
    message: `${context.name}: ${key} holds back new versions when Cargo resolves dependencies, but not cargo install of a crate, not versions a registry gives no publish time, and not versions already in Cargo.lock; a value in $CARGO_HOME/config.toml, an environment variable or --config takes the place of the one in ${file}`,
    fix: `Install tools with cargo install --locked and an exact --version; check ${global}, ${resolver} and $CARGO_HOME/config.toml where Cargo runs`,
  });
}
