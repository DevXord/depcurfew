import type { Rule } from '../types.ts';
import { botCooldownMismatch } from './bot-cooldown.ts';
import { broadExclusion } from './broad-exclusion.ts';
import { configDrift } from './config-drift.ts';
import { depcurfewOutdated } from './depcurfew-outdated.ts';
import { settingIgnoredByVersion } from './ignored-setting.ts';
import { invalidPolicy } from './invalid-policy.ts';
import { invalidProject } from './invalid-project.ts';
import { lockfileForbiddenSource, lockfileInstallScripts } from './lockfile.ts';
import { lockfileOutOfDate } from './lockfile-out-of-date.ts';
import { managerVersionTooOld } from './manager-version.ts';
import { npmrcOverridesPolicy, pnpmSharedWorkspaceLockfile } from './npmrc.ts';
import { pythonConfigIgnored } from './python-config.ts';
import { runtimeEndOfLife } from './runtime-end-of-life.ts';
import { unreadableConfig } from './unreadable-config.ts';

/** Every doctor rule, in the order they are documented. unreadable-config runs last, after every other rule has read its files. */
export const RULES: readonly Rule[] = [
  invalidPolicy,
  invalidProject,
  depcurfewOutdated,
  managerVersionTooOld,
  runtimeEndOfLife,
  settingIgnoredByVersion,
  npmrcOverridesPolicy,
  pnpmSharedWorkspaceLockfile,
  pythonConfigIgnored,
  configDrift,
  botCooldownMismatch,
  broadExclusion,
  lockfileForbiddenSource,
  lockfileInstallScripts,
  lockfileOutOfDate,
  unreadableConfig,
];
