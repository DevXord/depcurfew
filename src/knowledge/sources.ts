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
  // jiff (BurntSushi) is the library uv reads and prints exclude-newer spans with (extra.spanSyntax).
  uv: [{ host: 'docs.astral.sh' }, { host: 'github.com', pathPrefix: '/astral-sh/' }, { host: 'github.com', pathPrefix: '/burntsushi/jiff/' }],
  pip: [
    { host: 'pip.pypa.io' },
    { host: 'github.com', pathPrefix: '/pypa/' },
    { host: 'packaging.python.org' },
    { host: 'peps.python.org' },
  ],
  // platformdirs (tox-dev) is the library both Poetry and PDM call for their user config directory, without an override.
  poetry: [{ host: 'python-poetry.org' }, { host: 'github.com', pathPrefix: '/python-poetry/' }, { host: 'github.com', pathPrefix: '/tox-dev/' }],
  pdm: [{ host: 'pdm-project.org' }, { host: 'github.com', pathPrefix: '/pdm-project/' }, { host: 'github.com', pathPrefix: '/tox-dev/' }],
  pipenv: [{ host: 'pipenv.pypa.io' }, { host: 'github.com', pathPrefix: '/pypa/' }],
  renovate: [{ host: 'docs.renovatebot.com' }, { host: 'github.com', pathPrefix: '/renovatebot/' }],
  dependabot: [
    { host: 'docs.github.com' },
    { host: 'github.blog', pathPrefix: '/changelog/' },
    { host: 'github.com', pathPrefix: '/dependabot/' },
  ],
};

/** Official locations for facts about the environment: Corepack and Node.js, npm and its registry, Volta, asdf, GitHub Actions, Claude Code, Python packaging, git, the Windows shells, Docker and the Node.js version managers. */
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
  // git: git-scm.com/docs is built from Documentation/ in git/git.
  { host: 'github.com', pathPrefix: '/git/' },
  // PowerShell and cmd.exe: learn.microsoft.com is built from MicrosoftDocs repositories such as PowerShell-Docs.
  { host: 'learn.microsoft.com' },
  { host: 'github.com', pathPrefix: '/microsoftdocs/' },
  // Model Context Protocol (depcurfew mcp): modelcontextprotocol.io is built from docs/ in
  // modelcontextprotocol/modelcontextprotocol, which also holds the schema of every revision.
  { host: 'modelcontextprotocol.io' },
  { host: 'github.com', pathPrefix: '/modelcontextprotocol/' },
  // VS Code as an MCP client: code.visualstudio.com/docs is built from microsoft/vscode-docs.
  { host: 'code.visualstudio.com' },
  { host: 'github.com', pathPrefix: '/microsoft/vscode-docs/' },
  // Official Docker images: docker-library/official-images publishes the tags, docker-library/python builds the python image.
  { host: 'github.com', pathPrefix: '/docker-library/' },
  // The Dockerfile reference on docs.docker.com is vendored from moby/buildkit; moby/moby vendors the image reference rules.
  { host: 'github.com', pathPrefix: '/moby/' },
  // docs.docker.com is built from docker/docs; docker/cli and docker/buildx hold the command references.
  { host: 'github.com', pathPrefix: '/docker/' },
  // Buildah and Podman, the tools that read Containerfile.
  { host: 'github.com', pathPrefix: '/containers/' },
  // Node.js version managers and their version files: nvm (.nvmrc), nodenv (.node-version) and fnm (Schniz/fnm).
  { host: 'github.com', pathPrefix: '/nvm-sh/' },
  { host: 'github.com', pathPrefix: '/nodenv/' },
  { host: 'github.com', pathPrefix: '/schniz/' },
];

export function isOfficialSource(url: URL, rules: readonly SourceRule[]): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return rules.some((rule) => host === rule.host && (rule.pathPrefix === undefined || path.startsWith(rule.pathPrefix)));
}
