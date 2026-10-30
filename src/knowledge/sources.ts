import type { ToolId } from './types.ts';

/** An official documentation or changelog location: a host, optionally limited to a path prefix. */
export interface SourceRule {
  host: string;
  pathPrefix?: string;
}

export const OFFICIAL_SOURCES: Readonly<Record<ToolId, readonly SourceRule[]>> = {
  npm: [
    { host: 'docs.npmjs.com' },
    { host: 'github.com', pathPrefix: '/npm/' },
    { host: 'github.blog', pathPrefix: '/changelog/' },
  ],
  pnpm: [{ host: 'pnpm.io' }, { host: 'github.com', pathPrefix: '/pnpm/' }],
  yarn: [{ host: 'yarnpkg.com' }, { host: 'github.com', pathPrefix: '/yarnpkg/' }],
  bun: [{ host: 'bun.com' }, { host: 'bun.sh' }, { host: 'github.com', pathPrefix: '/oven-sh/' }],
  deno: [{ host: 'docs.deno.com' }, { host: 'deno.com' }, { host: 'github.com', pathPrefix: '/denoland/' }],
  uv: [{ host: 'docs.astral.sh' }, { host: 'github.com', pathPrefix: '/astral-sh/' }],
  pip: [
    { host: 'pip.pypa.io' },
    { host: 'github.com', pathPrefix: '/pypa/' },
    { host: 'packaging.python.org' },
    { host: 'peps.python.org' },
  ],
  poetry: [{ host: 'python-poetry.org' }, { host: 'github.com', pathPrefix: '/python-poetry/' }],
  renovate: [{ host: 'docs.renovatebot.com' }, { host: 'github.com', pathPrefix: '/renovatebot/' }],
  dependabot: [
    { host: 'docs.github.com' },
    { host: 'github.blog', pathPrefix: '/changelog/' },
    { host: 'github.com', pathPrefix: '/dependabot/' },
  ],
};

/** Official locations for facts about the environment: Corepack and Node.js, npm and its registry, Volta, asdf, GitHub Actions, Claude Code and Python packaging. */
export const ENVIRONMENT_SOURCES: readonly SourceRule[] = [
  { host: 'nodejs.org' },
  { host: 'github.com', pathPrefix: '/nodejs/' },
  { host: 'github.com', pathPrefix: '/npm/' },
  { host: 'github.com', pathPrefix: '/volta-cli/' },
  { host: 'github.com', pathPrefix: '/asdf-vm/' },
  { host: 'docs.github.com' },
  { host: 'github.com', pathPrefix: '/actions/' },
  { host: 'github.com', pathPrefix: '/pnpm/' },
  { host: 'github.com', pathPrefix: '/oven-sh/' },
  { host: 'github.com', pathPrefix: '/denoland/' },
  { host: 'code.claude.com', pathPrefix: '/docs/' },
  { host: 'packaging.python.org' },
  { host: 'github.com', pathPrefix: '/pypa/' },
  // PyPI: docs.pypi.org is built from docs/user in pypi/warehouse.
  { host: 'github.com', pathPrefix: '/pypi/' },
  // CPython: docs.python.org is built from Doc/ in python/cpython.
  { host: 'docs.python.org' },
  { host: 'github.com', pathPrefix: '/python/' },
  { host: 'github.com', pathPrefix: '/astral-sh/' },
  { host: 'github.com', pathPrefix: '/python-poetry/' },
  // Third-party actions that install Poetry: their own repositories describe their inputs.
  { host: 'github.com', pathPrefix: '/snok/' },
  { host: 'github.com', pathPrefix: '/abatilo/' },
];

export function isOfficialSource(url: URL, rules: readonly SourceRule[]): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return rules.some((rule) => host === rule.host && (rule.pathPrefix === undefined || path.startsWith(rule.pathPrefix)));
}
