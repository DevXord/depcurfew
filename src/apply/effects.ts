// What apply does with installScripts and sources for each tool (decision D-117), for depcurfew explain: the settings
// the generators write and apply's warnings about those parts, from one plan of the repository made as apply makes it,
// so explain never keeps a second description of the tools.
import type { Detection } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { settingOf } from './facts.ts';
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
export type PolicyEffects = (project: string | undefined, part: PolicyPart, tool: ToolId) => ToolEffect;

/**
 * The part of the policy a setting belongs to, by the tool's knowledge: the release-age delay (undefined), a dependency
 * source, or else installScripts. version-too-old names every setting a version lacks in one message, so explain shows
 * it with each part it concerns.
 */
function partOfSetting(tool: ToolKnowledge | undefined, setting: string): PolicyPart | undefined {
  if (tool === undefined) return undefined;
  if ([tool.cooldown.setting, tool.cooldown.exclude.setting].some((fact) => settingOf(fact) === setting)) return undefined;
  if (SOURCE_KINDS.some((kind) => tool.sources !== undefined && settingOf(tool.sources[kind].setting) === setting)) return 'sources';
  return 'installScripts';
}

/**
 * Plans the repository as apply does, without writing anything, and returns what the plan did with installScripts and
 * sources for each tool. A setting in a manifest that does not exist is not written: the warning manifest-missing
 * says so instead.
 */
export function policyEffects(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): PolicyEffects {
  const { result: report, written, missing } = recordSettings(() => planRepository(root, policy, tools, detection));
  const settings = written.map((entry) => ({ ...entry, file: entry.project === undefined ? entry.file : inProject(entry.project, entry.file) }));
  return (project, part, tool) => {
    const mine = (entry: { tool?: ToolId; project?: string }) => entry.tool === tool && entry.project === project;
    const own = settings.filter((entry) => mine(entry) && entry.part === part);
    const knowledge = tools.find((entry) => entry.id === tool);
    const tooOld = missing.some((entry) => mine(entry) && partOfSetting(knowledge, entry.setting) === part);
    const warnings = report.warningDetails.filter(
      (warning) =>
        mine(warning) &&
        ((WARNING_PARTS[warning.code] ?? []).includes(part) ||
          (warning.code === 'version-too-old' && tooOld) ||
          (warning.code === 'manifest-missing' && own.some((entry) => entry.file === warning.location?.file))),
    );
    const skipped = new Set(warnings.filter((warning) => warning.code === 'manifest-missing').map((warning) => warning.location?.file));
    return {
      tool,
      settings: own.filter((entry) => !skipped.has(entry.file)).map(({ setting, file, table }) => ({ setting, file, ...(table === undefined ? {} : { table }) })),
      warnings: warnings.map(({ code, ...rest }) => ({ code, level: 'warning', ...rest })),
    };
  };
}
