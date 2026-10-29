import type { Rule } from '../types.ts';
import { botCooldownMismatch } from './bot-cooldown.ts';
import { broadExclusion } from './broad-exclusion.ts';
import { configDrift } from './config-drift.ts';
import { settingIgnoredByVersion } from './ignored-setting.ts';
import { lockfileForbiddenSource, lockfileInstallScripts } from './lockfile.ts';
import { managerVersionTooOld } from './manager-version.ts';
import { npmrcOverridesPolicy, pnpmSharedWorkspaceLockfile } from './npmrc.ts';
import { unreadableConfig } from './unreadable-config.ts';

/** Every doctor rule, in the order they are documented. unreadable-config runs last, after every other rule has read its files. */
export const RULES: readonly Rule[] = [
  managerVersionTooOld,
  settingIgnoredByVersion,
  npmrcOverridesPolicy,
  pnpmSharedWorkspaceLockfile,
  configDrift,
  botCooldownMismatch,
  broadExclusion,
  lockfileForbiddenSource,
  lockfileInstallScripts,
  unreadableConfig,
];
