import { bun } from './bun.ts';
import { deno } from './deno.ts';
import { dependabot } from './dependabot.ts';
import { npm } from './npm.ts';
import { pip } from './pip.ts';
import { pdm } from './pdm.ts';
import { pipenv } from './pipenv.ts';
import { pnpm } from './pnpm.ts';
import { poetry } from './poetry.ts';
import { renovate } from './renovate.ts';
import type { ToolKnowledge } from './types.ts';
import { uv } from './uv.ts';
import { yarn } from './yarn.ts';

export { environment } from './environment.ts';

export const knowledgeBase: readonly ToolKnowledge[] = [npm, pnpm, yarn, bun, deno, uv, pip, poetry, pdm, pipenv, renovate, dependabot];

export type * from './types.ts';
