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
    // The registry's own documents of the npm package: its versions and dist-tags (decision D-173).
    { host: 'registry.npmjs.org', pathPrefix: '/npm' },
    { host: 'registry.npmjs.org', pathPrefix: '/-/package/npm/' },
  ],
  pnpm: [{ host: 'pnpm.io' }, { host: 'github.com', pathPrefix: '/pnpm/' }],
  // Clipanion (arcanis) is the library Yarn parses its command line with (extra.runnerOptions).
  yarn: [{ host: 'yarnpkg.com' }, { host: 'github.com', pathPrefix: '/yarnpkg/' }, { host: 'github.com', pathPrefix: '/arcanis/clipanion/' }],
  bun: [{ host: 'bun.com' }, { host: 'bun.sh' }, { host: 'github.com', pathPrefix: '/oven-sh/' }],
  deno: [{ host: 'docs.deno.com' }, { host: 'deno.com' }, { host: 'github.com', pathPrefix: '/denoland/' }],
  // jiff (BurntSushi) is the library uv reads and prints exclude-newer spans with (extra.spanSyntax).
  uv: [{ host: 'docs.astral.sh' }, { host: 'github.com', pathPrefix: '/astral-sh/' }, { host: 'github.com', pathPrefix: '/burntsushi/jiff/' }],
  // configparser of the standard library (python/cpython) is what pip reads pip.conf with (extra.configSectionNames).
  pip: [
    { host: 'pip.pypa.io' },
    { host: 'github.com', pathPrefix: '/pypa/' },
    { host: 'packaging.python.org' },
    { host: 'peps.python.org' },
    { host: 'github.com', pathPrefix: '/python/cpython/' },
  ],
  // platformdirs (tox-dev) is the library both Poetry and PDM call for their user config directory, without an override.
  poetry: [{ host: 'python-poetry.org' }, { host: 'github.com', pathPrefix: '/python-poetry/' }, { host: 'github.com', pathPrefix: '/tox-dev/' }],
  pdm: [{ host: 'pdm-project.org' }, { host: 'github.com', pathPrefix: '/pdm-project/' }, { host: 'github.com', pathPrefix: '/tox-dev/' }],
  pipenv: [{ host: 'pipenv.pypa.io' }, { host: 'github.com', pathPrefix: '/pypa/' }],
  // Packagist.org is Composer's default repository; its API documentation and the files it serves describe it. Composer
  // runs on symfony/console, which resolves its command names, and orders versions with PHP's version_compare (php-src).
  composer: [
    { host: 'getcomposer.org' },
    { host: 'github.com', pathPrefix: '/composer/' },
    { host: 'packagist.org' },
    { host: 'repo.packagist.org' },
    { host: 'github.com', pathPrefix: '/symfony/console/' },
    { host: 'github.com', pathPrefix: '/php/php-src/' },
    // WPackagist serves the WordPress plugin and theme directories as a Composer repository (repositoryArchiveHosts).
    { host: 'github.com', pathPrefix: '/outlandishideas/wpackagist/' },
  ],
  // bundler.io is built from the man pages of ruby/rubygems (formerly rubygems/rubygems), where RubyGems lives too; the
  // RubyGems blog is built from rubygems/rubygems.github.io; rubygems.org serves the versions of the bundler gem.
  bundler: [
    { host: 'bundler.io' },
    { host: 'github.com', pathPrefix: '/ruby/rubygems/' },
    { host: 'github.com', pathPrefix: '/rubygems/' },
    { host: 'blog.rubygems.org' },
    { host: 'guides.rubygems.org' },
    { host: 'rubygems.org', pathPrefix: '/api/' },
    // Ruby's parser (parse.y, prism) decides which lines of a Gemfile are code, since Bundler runs it with instance_eval;
    // Ruby's String#to_i reads the number settings of Bundler (rubySyntax, stringToInteger).
    { host: 'github.com', pathPrefix: '/ruby/ruby/' },
  ],
  renovate: [{ host: 'docs.renovatebot.com' }, { host: 'github.com', pathPrefix: '/renovatebot/' }],
  // Psych (ruby/psych) is the YAML library dependabot-core loads dependabot.yml with (extra.yamlScalars).
  dependabot: [
    { host: 'docs.github.com' },
    { host: 'github.blog', pathPrefix: '/changelog/' },
    { host: 'github.com', pathPrefix: '/dependabot/' },
    { host: 'github.com', pathPrefix: '/ruby/psych/' },
    // Ruby's File.fnmatch, with which dependabot-core matches cooldown exclude and include (excludeMatching).
    { host: 'github.com', pathPrefix: '/ruby/ruby/' },
  ],
};

/** Official locations for facts about the environment: Corepack and Node.js, npm and its registry, Volta, asdf, GitHub Actions, Claude Code, Python packaging, git, the Windows shells, Docker, the Node.js version managers and the ecosystems updated by bots only. */
export const ENVIRONMENT_SOURCES: readonly SourceRule[] = [
  { host: 'nodejs.org' },
  { host: 'github.com', pathPrefix: '/nodejs/' },
  { host: 'github.com', pathPrefix: '/npm/' },
  { host: 'github.com', pathPrefix: '/volta-cli/' },
  { host: 'github.com', pathPrefix: '/asdf-vm/' },
  { host: 'docs.github.com' },
  { host: 'github.com', pathPrefix: '/actions/' },
  // GitLab's npm registry (decision D-168): docs.gitlab.com is built from doc/ in gitlab-org/gitlab.
  { host: 'gitlab.com', pathPrefix: '/gitlab-org/gitlab/' },
  { host: 'github.com', pathPrefix: '/pnpm/' },
  { host: 'github.com', pathPrefix: '/oven-sh/' },
  { host: 'github.com', pathPrefix: '/denoland/' },
  { host: 'code.claude.com', pathPrefix: '/docs/' },
  { host: 'packaging.python.org' },
  { host: 'github.com', pathPrefix: '/pypa/' },
  // PyPI: docs.pypi.org is built from docs/user in pypi/warehouse.
  { host: 'github.com', pathPrefix: '/pypi/' },
  // OSV.dev (--osv, decision D-129): osv.dev is built from docs/ in google/osv.dev; the OSV schema and the OpenSSF
  // malicious-packages database are in ossf/osv-schema and ossf/malicious-packages.
  { host: 'github.com', pathPrefix: '/google/osv.dev/' },
  { host: 'github.com', pathPrefix: '/ossf/' },
  // CPython: docs.python.org is built from Doc/ in python/cpython.
  { host: 'docs.python.org' },
  { host: 'github.com', pathPrefix: '/python/' },
  { host: 'github.com', pathPrefix: '/astral-sh/' },
  { host: 'github.com', pathPrefix: '/python-poetry/' },
  // Third-party actions that install Poetry: their own repositories describe their inputs.
  { host: 'github.com', pathPrefix: '/snok/' },
  { host: 'github.com', pathPrefix: '/abatilo/' },
  // ruby/setup-ruby, the action that installs Ruby and Bundler (decision D-152).
  { host: 'github.com', pathPrefix: '/ruby/setup-ruby/' },
  // pdm-project/setup-pdm, the action that installs PDM, and mise with jdx/mise-action, which pin Node.js and Python
  // (decision D-173).
  { host: 'github.com', pathPrefix: '/pdm-project/setup-pdm/' },
  { host: 'github.com', pathPrefix: '/jdx/mise/' },
  { host: 'github.com', pathPrefix: '/jdx/mise-action/' },
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
  // Ecosystems updated by bots only (decision D-151): Cargo, its book and the RFCs (rust-lang), the go command and
  // go.dev (golang/go, golang/website), Maven and its site (apache/maven*), Gradle, NuGet with its designs and docs
  // (NuGet/Home, NuGet/NuGet.Client, NuGet/docs.microsoft.com-nuget) and the .NET SDK (dotnet/dotnet, dotnet/core,
  // dotnet/docs).
  { host: 'github.com', pathPrefix: '/rust-lang/' },
  { host: 'github.com', pathPrefix: '/golang/' },
  { host: 'github.com', pathPrefix: '/apache/maven' },
  { host: 'github.com', pathPrefix: '/gradle/' },
  { host: 'github.com', pathPrefix: '/nuget/' },
  { host: 'github.com', pathPrefix: '/dotnet/' },
  // npm packages whose install scripts are known (decision D-127): each package's own repository at a release tag.
  { host: 'github.com', pathPrefix: '/evanw/esbuild/' },
  { host: 'github.com', pathPrefix: '/evilmartians/lefthook/' },
  { host: 'github.com', pathPrefix: '/fsevents/fsevents/' },
];

export function isOfficialSource(url: URL, rules: readonly SourceRule[]): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return rules.some((rule) => host === rule.host && (rule.pathPrefix === undefined || path.startsWith(rule.pathPrefix)));
}
