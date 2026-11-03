// What apply does with installScripts and sources for each tool (decision D-117), for depcurfew explain: the settings
// the generators write and apply's warnings about those parts, from one plan of the repository made as apply makes it,
// so explain never keeps a second description of the tools.
import type { Detection } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { isRecord, settingOf, values } from './facts.ts';
import { recordSettings } from './generators/context.ts';
import { planRepository } from './index.ts';
import { inProject } from './projects.ts';
import { WARNING_PARTS, type ApplyWarning, type PolicyPart } from './warnings.ts';

/** A setting apply writes, with its file relative to the repository root and the TOML table it is written in. */
export interface EffectSetting {
  setting: string;
  file: string;
  table?: string;
}

/** A warning of apply as apply --json gives it. */
export type EffectWarning = ApplyWarning & { level: 'warning' };

/** What apply does with one part of the policy for one tool. */
export interface ToolEffect {
  tool: ToolId;
  /** The settings apply writes for the part, in the order the generator writes them. */
  settings: EffectSetting[];
  /** apply's warnings about the part for the tool: what it cannot enforce, its side effects, and what to do. */
  warnings: EffectWarning[];
}

/** What apply does with a part of the policy for a tool at the repository root (project undefined) or in a listed project. */
export interface PolicyEffects {
  (project: string | undefined, part: PolicyPart, tool: ToolId): ToolEffect;
  /**
   * Why apply writes no release-age delay for a tool although the policy's delay converts (decision D-134: a
   * config.policy of composer.json that is no object), as its cooldown-not-written warning says, or its version-too-old
   * for a version without the delay setting (decision D-173); undefined when it does.
   */
  cooldownNotWritten(tool: ToolId): string | undefined;
}

/**
 * The part of the policy a setting belongs to, by the tool's knowledge: the release-age delay (undefined), a dependency
 * source, or else installScripts. version-too-old names every setting a version lacks in one message, so explain shows
 * it with each part it concerns.
 */
function partOfSetting(tool: ToolKnowledge | undefined, setting: string): PolicyPart | undefined {
  if (tool === undefined) return undefined;
  // "cooldown once Gemfile.lock exists" and "minimumReleaseAge for packages requested by exact version" are the delay too
  // (decision D-173).
  const delay = (name: string | null) => name !== null && (name === setting || setting.startsWith(`${name} `));
  if ([tool.cooldown.setting, tool.cooldown.exclude.setting].some((fact) => delay(settingOf(fact)))) return undefined;
  if (SOURCE_KINDS.some((kind) => tool.sources !== undefined && settingOf(tool.sources[kind].setting) === setting)) return 'sources';
  return 'installScripts';
}

/**
 * The part of the setting a setting-owned-elsewhere warning names ("pnpm: allowBuilds not written: …"); undefined for the
 * settings of the release-age delay, minimumReleaseAgeStrict included.
 */
function ownedPart(tool: ToolKnowledge | undefined, message: string): PolicyPart | undefined {
  const setting = /^[^:]+: (\S+) not written:/u.exec(message)?.[1];
  const strict = tool?.extra?.['minimumReleaseAgeStrict'];
  const strictSetting = strict === undefined ? undefined : values(strict).map((value) => (isRecord(value) ? value['setting'] : undefined))[0];
  return setting === undefined || setting === strictSetting ? undefined : partOfSetting(tool, setting);
}

/**
 * Plans the repository as apply does, without writing anything, and returns what the plan did with installScripts and
 * sources for each tool. A setting in a manifest that does not exist is not written: the warning manifest-missing
 * says so instead.
 */
export function policyEffects(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): PolicyEffects {
  const { result: report, written, missing } = recordSettings(() => planRepository(root, policy, tools, detection));
  const settings = written.map((entry) => ({ ...entry, file: entry.project === undefined ? entry.file : inProject(entry.project, entry.file) }));
  const cooldownNotWritten = (tool: ToolId): string | undefined => {
    const reasons = report.warningDetails.filter((warning) => warning.code === 'cooldown-not-written' && warning.tool === tool).map((warning) => warning.message.replace(/^.*?cooldown not written: /u, ''));
    // A version too old for the delay setting itself gets none either: its version-too-old says why (decision D-173).
    const setting = settingOf(tools.find((entry) => entry.id === tool)?.cooldown.setting);
    if (setting !== null && missing.some((entry) => entry.tool === tool && entry.project === undefined && entry.setting === setting)) {
      reasons.push(...report.warningDetails.filter((warning) => warning.code === 'version-too-old' && warning.tool === tool && warning.project === undefined).map((warning) => warning.message));
    }
    return reasons.length === 0 ? undefined : [...new Set(reasons)].join('; ');
  };
  const effects = (project: string | undefined, part: PolicyPart, tool: ToolId): ToolEffect => {
    const mine = (entry: { tool?: ToolId; project?: string }) => entry.tool === tool && entry.project === project;
    const own = settings.filter((entry) => mine(entry) && entry.part === part);
    const knowledge = tools.find((entry) => entry.id === tool);
    const tooOld = missing.some((entry) => mine(entry) && partOfSetting(knowledge, entry.setting) === part);
    const warnings = report.warningDetails.filter(
      (warning) =>
        mine(warning) &&
        ((WARNING_PARTS[warning.code] ?? []).includes(part) ||
          (warning.code === 'version-too-old' && tooOld) ||
          // pnpm include gives the setting to another source (decision D-164): shown with the part of that setting.
          (warning.code === 'setting-owned-elsewhere' && ownedPart(knowledge, warning.message) === part) ||
          (warning.code === 'manifest-missing' && own.some((entry) => entry.file === warning.location?.file))),
    );
    const skipped = new Set(warnings.filter((warning) => warning.code === 'manifest-missing').map((warning) => warning.location?.file));
    return {
      tool,
      settings: own.filter((entry) => !skipped.has(entry.file)).map(({ setting, file, table }) => ({ setting, file, ...(table === undefined ? {} : { table }) })),
      warnings: warnings.map(({ code, ...rest }) => ({ code, level: 'warning', ...rest })),
    };
  };
  return Object.assign(effects, { cooldownNotWritten });
}
