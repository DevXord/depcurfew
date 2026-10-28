import { bun } from './bun.ts';
import { deno } from './deno.ts';
import { dependabot } from './dependabot.ts';
import { npm } from './npm.ts';
import { pnpm } from './pnpm.ts';
import { renovate } from './renovate.ts';
import type { ToolKnowledge } from './types.ts';
import { yarn } from './yarn.ts';

export { environment } from './environment.ts';

export const knowledgeBase: readonly ToolKnowledge[] = [npm, pnpm, yarn, bun, deno, renovate, dependabot];

export type * from './types.ts';
