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
  renovate: [{ host: 'docs.renovatebot.com' }, { host: 'github.com', pathPrefix: '/renovatebot/' }],
  dependabot: [
    { host: 'docs.github.com' },
    { host: 'github.blog', pathPrefix: '/changelog/' },
    { host: 'github.com', pathPrefix: '/dependabot/' },
  ],
};

/** Official locations for facts about the environment: Corepack and Node.js, npm, Volta, asdf and GitHub Actions. */
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
];

export function isOfficialSource(url: URL, rules: readonly SourceRule[]): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return rules.some((rule) => host === rule.host && (rule.pathPrefix === undefined || path.startsWith(rule.pathPrefix)));
}
