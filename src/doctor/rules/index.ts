import type { Rule } from '../types.ts';
import { botCooldownMismatch } from './bot-cooldown.ts';
import { broadExclusion } from './broad-exclusion.ts';
import { configDrift } from './config-drift.ts';
import { settingIgnoredByVersion } from './ignored-setting.ts';
import { managerVersionTooOld } from './manager-version.ts';

/** Every doctor rule, in the order they are documented. */
export const RULES: readonly Rule[] = [managerVersionTooOld, settingIgnoredByVersion, configDrift, botCooldownMismatch, broadExclusion];
