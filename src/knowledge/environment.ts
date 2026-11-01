// Facts about the environment around the package managers: how repositories pin tool versions (Corepack,
// npm devEngines, Volta, asdf) and how GitHub Actions workflows install them.
import { verifiedOn } from './define.ts';
import type { EnvironmentKnowledge, UserDirectory } from './types.ts';

const { verified } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const python = verifiedOn('2026-10-30');
const gitFacts = verifiedOn('2026-10-30');
const audited = verifiedOn('2026-10-31');
const release13 = verifiedOn('2026-11-01');
const mcpFacts = verifiedOn('2026-11-01');
const actionChecks = verifiedOn('2026-11-01');
const leftovers = verifiedOn('2026-11-01');

const COREPACK_README = 'https://github.com/nodejs/corepack/blob/main/README.md';
const COREPACK_CHANGELOG = 'https://github.com/nodejs/corepack/blob/main/CHANGELOG.md';
const COREPACK_V0_36_0 = 'https://github.com/nodejs/corepack/blob/v0.36.0';
/** The variables Corepack's code reads for its home folder, in order; a variable counts when it is set, even empty (??). */
const COREPACK_VARIABLES: readonly UserDirectory[] = [
  { from: { env: 'COREPACK_HOME', emptyCounts: true }, path: '' },
  { from: { env: 'XDG_CACHE_HOME', emptyCounts: true }, path: 'node/corepack' },
  { from: { env: 'LOCALAPPDATA', emptyCounts: true }, path: 'node/corepack' },
];
const NPM_PACKAGE_JSON = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md';
// docs.pypi.org is built from docs/user in the warehouse repository; the specifications from pypa/packaging.python.org.
const PYPI_INDEX_API = 'https://github.com/pypi/warehouse/blob/c137701f3afcd80c346c574c31c9b46eeb738664/docs/user/api/index-api.md';
const SPECIFICATIONS = 'https://github.com/pypa/packaging.python.org/blob/6fa4790c1fb668830f6eb94bbfe832320a9b0a2b/source/specifications';
// modelcontextprotocol.io is built from docs/ in the specification repository; schema/ holds the TypeScript schema of
// each revision.
const MCP = 'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/d0e246ea3c69eafaa2806bc4cd28025703ba2c2b';
// code.visualstudio.com/docs is built from docs/ in microsoft/vscode-docs.
const VSCODE_MCP = 'https://github.com/microsoft/vscode-docs/blob/5a54a294d553935c53374f43c668e37d08f0118e/docs/agents/reference/mcp-configuration.md';

export const environment: EnvironmentKnowledge = {
  corepack: {
    packageManagerField: verified(
      { key: 'packageManager', managers: ['npm', 'pnpm', 'yarn'] },
      COREPACK_README,
      'Format name@x.y.z, optionally followed by +<hash algorithm>.<hash>; a URL to a .js or .tgz file is also allowed. setup-bun also reads bun@x from this key.',
    ),
    devEnginesSince: verified(
      '0.32.0',
      COREPACK_CHANGELOG,
      'Limited support at first; since 0.36.0 Corepack uses the devEngines.packageManager range when packageManager is missing.',
    ),
    envFileSince: verified(
      '0.32.0',
      COREPACK_CHANGELOG,
      'Corepack reads COREPACK_* keys from .corepack.env; since 0.36.0 only the closest file. COREPACK_ENV_FILE=0 turns it off.',
    ),
    bundledWithNode: verified(
      [
        { since: '0.0.0', value: false },
        { since: '14.19.0', value: true },
        { since: '25.0.0', value: false },
      ],
      'https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V25.md',
      'Node.js 25.0.0 stopped distributing Corepack; the Corepack README says it ships with Node.js from 14.19.0 up to (but not including) 25.0.0.',
    ),
    package: leftovers.verified(
      'corepack',
      `${COREPACK_V0_36_0}/package.json`,
      'Its published bin field (publishConfig.bin) declares yarn (./dist/yarn.js), yarnpkg, pnpm and pnpx next to corepack. corepack enable links them from the folder of the corepack executable (a relative symlink to dist/<name>.js on Linux and macOS, a cmd-shim on Windows; sources/commands/Enable.ts), so the package.json behind a yarn or pnpm shim is Corepack\'s, which says nothing about the version the shim runs.',
    ),
    toolPackages: leftovers.verified(
      { npm: ['npm'], pnpm: ['pnpm'], yarn: ['yarn', '@yarnpkg/cli-dist'] },
      `${COREPACK_V0_36_0}/config.json`,
      'The npm packages Corepack installs each package manager from: npm; pnpm; yarn below 2.0.0 (Yarn Classic) and, with COREPACK_NPM_REGISTRY, @yarnpkg/cli-dist for Yarn 2 and later ("npmRegistry": { "package": "@yarnpkg/cli-dist", "bin": "bin/yarn.js" }). npm i -g @yarnpkg/cli-dist installs the same package, whose package.json declares bin yarn and carries the Yarn version (observed for 4.18.1).',
    ),
    defaults: leftovers.disputed(
      'Corepack 0.36.0 runs the version lastKnownGood.json names for a package manager when no package.json above the current folder sets packageManager; without an entry it fetches the latest version of the npm package (yarn: Yarn Classic 1.x, which never reads .yarnrc.yml) and records it there, or with COREPACK_DEFAULT_TO_LATEST=0 uses its built-in default (getDefaultVersion in sources/Engine.ts). The code looks for the home folder in COREPACK_HOME, XDG_CACHE_HOME, LOCALAPPDATA (on every system) and then the home folder, using a variable that is set even when it is empty (??); the README leaves out XDG_CACHE_HOME and LOCALAPPDATA outside Windows. The code is what runs, so depcurfew follows it; the layout is the same since 0.13.0 (sources/folderUtils.ts), before which the folder was ~/.node/corepack. Values carry a hash after + (1.22.22+sha1.ac34...), which is not part of the version.',
      leftovers.evidence(
        {
          since: '0.13.0',
          locations: [
            {
              platforms: ['linux', 'darwin'],
              directories: [...COREPACK_VARIABLES, { from: 'home', path: '.cache/node/corepack' }],
              file: 'lastKnownGood.json',
            },
            {
              platforms: ['win32'],
              directories: [...COREPACK_VARIABLES, { from: 'home', path: 'AppData/Local/node/corepack' }],
              file: 'lastKnownGood.json',
            },
          ],
        },
        `${COREPACK_V0_36_0}/sources/folderUtils.ts`,
        'getCorepackHomeFolder: process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), process.platform === `win32` ? `AppData/Local` : `.cache`), `node/corepack`); sources/Engine.ts reads join(getCorepackHomeFolder(), `lastKnownGood.json`), a JSON object of package manager names and versions.',
      ),
      leftovers.evidence(
        {
          since: '0.13.0',
          locations: [
            { platforms: ['linux', 'darwin'], directories: [{ from: { env: 'COREPACK_HOME' }, path: '' }, { from: 'home', path: '.cache/node/corepack' }], file: 'lastKnownGood.json' },
            { platforms: ['win32'], directories: [{ from: { env: 'COREPACK_HOME' }, path: '' }, { from: { env: 'LOCALAPPDATA' }, path: 'node/corepack' }], file: 'lastKnownGood.json' },
          ],
        },
        `${COREPACK_V0_36_0}/README.md`,
        '"COREPACK_HOME can be set in order to define where Corepack should install the package managers. By default it is set to %LOCALAPPDATA%\\node\\corepack on Windows, and to $HOME/.cache/node/corepack everywhere else."',
      ),
    ),
  },
  devEngines: verified(
    { key: 'devEngines', packageManagerKey: 'packageManager', runtimeKey: 'runtime' },
    `${NPM_PACKAGE_JSON}#devengines`,
    'Each entry is an object or a list of objects with name (required), version and onFail (warn, error by default, or ignore). Corepack and the setup actions read it too.',
  ),
  devEnginesSince: verified('10.9.0', 'https://github.com/npm/cli/blob/v10.9.0/CHANGELOG.md', 'npm version that introduced devEngines.'),
  volta: {
    manifest: verified(
      { key: 'volta', tools: ['node', 'npm', 'pnpm', 'yarn'] },
      'https://github.com/volta-cli/volta/blob/main/crates/volta-core/src/project/serial.rs',
      'Also extends: a path to another JSON file with a volta key. pnpm support is experimental and needs VOLTA_FEATURE_PNPM=1.',
    ),
    maintained: verified(false, 'https://github.com/volta-cli/volta/blob/main/README.md', 'The README says Volta is unmaintained and recommends migrating to mise.'),
  },
  asdf: {
    toolVersionsFile: verified(
      '.tool-versions',
      'https://github.com/asdf-vm/asdf/blob/master/docs/manage/configuration.md',
      'One tool per line followed by one or more versions separated by spaces (fallbacks); # starts a comment.',
    ),
    plugins: verified(
      { nodejs: 'node', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', deno: 'deno', python: 'python', uv: 'uv', poetry: 'poetry' },
      'https://github.com/asdf-vm/asdf-plugins/tree/master/plugins',
      'Short names in the asdf plugin index; there is no plugin named node. python, uv and poetry checked on 2026-10-30 (danhper/asdf-python, asdf-community/asdf-uv, asdf-community/asdf-poetry).',
    ),
  },
  githubActions: {
    workflows: verified(
      { directory: '.github/workflows', extensions: ['.yml', '.yaml'] },
      'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax',
    ),
    setupNode: verified(
      {
        action: 'actions/setup-node',
        installs: ['node'],
        inputs: [
          { name: 'node-version', kind: 'version', tool: 'node' },
          { name: 'node-version-file', kind: 'version-file', tool: 'node' },
        ],
      },
      'https://github.com/actions/setup-node/blob/main/action.yml',
      'Current major v7. node-version-file reads package.json, .nvmrc, .node-version, .tool-versions or mise.toml; node-version wins when both are set.',
    ),
    pnpmActionSetup: verified(
      { action: 'pnpm/action-setup', installs: ['pnpm'], inputs: [{ name: 'version', kind: 'version', tool: 'pnpm' }] },
      'https://github.com/pnpm/action-setup/blob/master/action.yml',
      'Current major v6. Without version the action reads devEngines.packageManager or packageManager from package.json (package_json_file).',
    ),
    pnpmSetup: verified(
      {
        action: 'pnpm/setup',
        installs: ['pnpm'],
        inputs: [
          { name: 'version', kind: 'version', tool: 'pnpm' },
          { name: 'runtime', kind: 'runtime' },
          { name: 'node-version-file', kind: 'version-file', tool: 'node' },
        ],
      },
      'https://github.com/pnpm/setup/blob/main/action.yml',
      'For pnpm 11 and later. Without version it reads devEngines.packageManager or packageManager; runtime takes <name>@<version> for node, bun or deno.',
    ),
    setupBun: verified(
      {
        action: 'oven-sh/setup-bun',
        installs: ['bun'],
        inputs: [
          { name: 'bun-version', kind: 'version', tool: 'bun' },
          { name: 'bun-version-file', kind: 'version-file', tool: 'bun' },
        ],
      },
      'https://github.com/oven-sh/setup-bun/blob/main/action.yml',
      'Current major v2. Without bun-version it reads packageManager (bun@x), then engines.bun, then installs latest.',
    ),
    setupDeno: verified(
      {
        action: 'denoland/setup-deno',
        installs: ['deno'],
        inputs: [
          { name: 'deno-version', kind: 'version', tool: 'deno' },
          { name: 'deno-version-file', kind: 'version-file', tool: 'deno' },
        ],
      },
      'https://github.com/denoland/setup-deno/blob/main/action.yml',
      'Current major v2. deno-version defaults to 2.x; deno-version-file reads .dvmrc or .tool-versions.',
    ),
    setupPython: python.verified(
      {
        action: 'actions/setup-python',
        installs: ['python'],
        inputs: [
          { name: 'python-version', kind: 'version', tool: 'python' },
          { name: 'python-version-file', kind: 'version-file', tool: 'python' },
          { name: 'pip-version', kind: 'version', tool: 'pip' },
        ],
      },
      'https://github.com/actions/setup-python/blob/v7.1.0/action.yml',
      'Current version v7.1.0. Without python-version it reads .python-version; python-version wins over python-version-file. pip-version (major[.minor][.patch], CPython only) since v6.0.0. Python comes with pip, but the step alone does not show that pip installs the project.',
    ),
    setupUv: python.verified(
      {
        action: 'astral-sh/setup-uv',
        installs: ['uv'],
        inputs: [
          { name: 'version', kind: 'version', tool: 'uv' },
          { name: 'version-file', kind: 'version-file', tool: 'uv' },
        ],
      },
      'https://github.com/astral-sh/setup-uv/blob/v10.3.3/action.yml',
      'Current version v10.3.3, with no moving v10 tag. Without version or version-file it reads required-version from uv.toml, then pyproject.toml, in the working directory, and installs the latest uv when neither has one.',
    ),
    installPoetry: python.verified(
      { action: 'snok/install-poetry', installs: ['poetry'], inputs: [{ name: 'version', kind: 'version', tool: 'poetry' }] },
      'https://github.com/snok/install-poetry/blob/v1.4.2/action.yml',
      'A third-party action (current v1.4.2); version defaults to latest, so without it the Poetry version is not pinned.',
    ),
    actionsPoetry: python.verified(
      { action: 'abatilo/actions-poetry', installs: ['poetry'], inputs: [{ name: 'poetry-version', kind: 'version', tool: 'poetry' }] },
      'https://github.com/abatilo/actions-poetry/blob/v4.0.0/action.yml',
      'A third-party action (current v4.0.0); poetry-version defaults to latest.',
    ),
    codeScanningUpload: checked.verified(
      {
        action: 'github/codeql-action/upload-sarif',
        inputs: { sarifFile: 'sarif_file', category: 'category' },
        permissions: { always: { 'security-events': 'write' }, privateRepositories: { actions: 'read', contents: 'read' } },
      },
      'https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file',
      'The example workflow on this page needs security-events: write in every repository and actions: read with contents: read only in private ones. The inputs come from upload-sarif/action.yml in github/codeql-action (current major v4, v4.39.1 checked); category tells analyses of the same tool and commit apart.',
    ),
    stopCommands: checked.verified(
      { stop: '::stop-commands::{token}', resume: '::{token}::' },
      'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#stopping-and-starting-workflow-commands',
      'Lines between the two are logged without being processed as workflow commands. The token must be randomly generated and unique for each run. Read from the page source in github/docs.',
    ),
    annotations: checked.verified(
      {
        commands: { error: 'error', warning: 'warning', note: 'notice' },
        properties: { file: 'file', line: 'line', title: 'title' },
        escape: [
          ['%', '%25'],
          ['\r', '%0D'],
          ['\n', '%0A'],
        ],
        escapeProperty: [
          [':', '%3A'],
          [',', '%2C'],
        ],
      },
      'https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts',
      'escapeData and escapeProperty in @actions/core: the message and property values replace %, CR and LF; property values also replace : and , because properties are separated by commas. The commands and their file, line and title parameters are on https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands (line counts from 1).',
    ),
    annotationLimits: checked.verified(
      { perLevelPerStep: 10, perJob: 50 },
      'https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md#limitations',
      '10 error, 10 warning and 10 notice annotations per step; 50 annotations per job, summed over all steps. Annotations over the limit are not shown.',
    ),
    checkRuns: actionChecks.verified(
      {
        endpoints: {
          create: '/repos/{repository}/check-runs',
          update: '/repos/{repository}/check-runs/{id}',
          list: '/repos/{repository}/commits/{ref}/check-runs',
        },
        query: { checkName: 'check_name', filter: 'filter', latest: 'latest' },
        apiVersion: '2022-11-28',
        permission: { checks: 'write' },
        summaryMaxLength: 65535,
        annotationsPerRequest: 50,
        annotationLevels: { error: 'failure', warning: 'warning', note: 'notice' },
        annotationTitleMaxLength: 255,
        annotationMessageMaxBytes: 64_000,
        variables: { apiUrl: 'GITHUB_API_URL', repository: 'GITHUB_REPOSITORY', sha: 'GITHUB_SHA', eventPath: 'GITHUB_EVENT_PATH' },
        pullRequestHeadSha: ['pull_request', 'head', 'sha'],
      },
      'https://docs.github.com/en/rest/checks/runs',
      'Read from the sources of this page (#create-a-check-run, #update-a-check-run, #list-check-runs-for-a-git-reference), the REST description github/rest-api-description (descriptions/api.github.com/api.github.com.json, commit f9ed74230d54847b5ca00a1343e8e349e858b8fb) and github/docs (commit 33b1f4a6fec2d9b6fd3d374afa56bcd9f0875b57); content/rest/checks/runs.md is generated from the REST description. POST /repos/{owner}/{repo}/check-runs ("Create a check run") needs name and head_sha and takes external_id, "A reference for the run on the integrator\'s system"; PATCH /repos/{owner}/{repo}/check-runs/{check_run_id} ("Update a check run") takes the same fields but head_sha, with only summary required in output, and "OAuth apps and personal access tokens (classic) cannot use this endpoint"; GET /repos/{owner}/{repo}/commits/{ref}/check-runs ("List check runs for a Git reference", ref a SHA, heads/BRANCH or tags/TAG) takes check_name ("Returns check runs with the specified name"), filter (latest, the default, or all: "latest returns the most recent check runs"), per_page (at most 100) and app_id, and answers {total_count, check_runs}, each with id, name, external_id (nullable), app (with slug, not required) and output.annotations_count. Fine-grained permissions (src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json in github/docs): the list needs Checks read, update and create need Checks write; "write includes read" (github-token-scope-descriptions.md). output.annotations: "maxItems": 50 per request, "To create more than 50 annotations, you have to make multiple requests to the Update a check run endpoint. Each time you update the check run, annotations are appended"; each annotation requires path, start_line, end_line (lines start at 1), annotation_level (notice, warning or failure) and message ("The maximum size is 64 KB"), with an optional title ("The maximum size is 255 characters"). No total per check run is documented; the same description says "GitHub Actions are limited to 10 warning annotations and 10 error annotations per step" without saying whether that binds check runs created through the API (uncertain). Not documented either: whether only the app that created a run may update it, and the app slug of runs created with the workflow token. A check suite holds the runs of one GitHub App for one commit (using-the-rest-api-to-interact-with-checks.md), and GitHub keeps at most 1000 runs of the same name per suite. status completed needs a conclusion (success, neutral, failure and others); output.title and output.summary (Markdown, maxLength 65535) show in the Checks tab; only GitHub Apps can create check runs, which the workflow token is. checks: write "permits an action to create a check run" (data/reusables/actions/github-token-scope-descriptions.md in github/docs, which links the permissions with apiVersion=2022-11-28); a pull request from a fork gets a read-only token unless the repository sends write tokens to such workflows (workflow-syntax.md, How permissions are calculated). For pull_request, GITHUB_SHA is the "Last merge commit on the GITHUB_REF branch" (events-that-trigger-workflows.md), so the check goes on pull_request.head.sha from the payload file GITHUB_EVENT_PATH names (webhook-pull-request-opened schema; variables.md for GITHUB_API_URL, GITHUB_REPOSITORY and GITHUB_EVENT_PATH).',
    ),
    stepSummary: checked.verified(
      { variable: 'GITHUB_STEP_SUMMARY', maxBytes: 1024 * 1024 },
      'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary',
      'GitHub flavored Markdown appended to the file named by the variable; at most 1 MiB per step (over that the upload fails with an error annotation), and at most 20 step summaries are shown per job.',
    ),
  },
  npmRegistry: {
    api: checked.verified(
      {
        url: 'https://registry.npmjs.org/',
        packagePath: '/{escaped name}',
        timeField: 'time',
        distTagsField: 'dist-tags',
        defaultTag: 'latest',
        versionsField: 'versions',
        scriptsField: 'scripts',
        deprecatedField: 'deprecated',
        installScripts: ['preinstall', 'install', 'postinstall'],
      },
      'https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md',
      'GET /{package} returns the full document by default: dist-tags maps tags to versions (every package has latest), versions maps versions to version objects, time maps every version to its publish time, and a version object carries scripts (from its package.json) and deprecated. The abbreviated document (Accept: application/vnd.npm.install-v1+json) has no time field and adds hasInstallScript. Scoped names are escaped with %2f (escapedName in github.com/npm/npm-package-arg); the registry answered the same document for @types/node and @types%2fnode on 2026-10-29. Install scripts: preinstall, install and postinstall run for a dependency, and npm runs node-gyp rebuild as install when the package has binding.gyp and no install or preinstall script (github.com/npm/cli/blob/v12.2.1/docs/lib/content/using-npm/scripts.md); binding.gyp is not visible in the document.',
    ),
    notFoundStatus: checked.uncertain(
      404,
      'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md',
      'The API description leaves its Errors section empty; a name that does not exist answered 404 with {"error":"Not found"} on 2026-10-29.',
    ),
    search: checked.uncertain(
      { path: '/-/v1/search', maxSize: 250, weeklyDownloadsField: 'downloads.weekly' },
      'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md',
      'The description documents text, size (at most 250) and from. Results carried downloads.weekly on 2026-10-29, which the description does not list, and from was ignored, so one query returns at most 250 packages.',
    ),
  },
  pypiIndex: {
    api: python.verified(
      {
        url: 'https://pypi.org/simple/',
        accept: 'application/vnd.pypi.simple.v1+json',
        notFoundStatus: 404,
        filesField: 'files',
        filenameField: 'filename',
        uploadTimeField: 'upload-time',
        yankedField: 'yanked',
        versionsField: 'versions',
        statusField: 'project-status',
        statusValueField: 'status',
        statusReasonField: 'reason',
      },
      `${SPECIFICATIONS}/simple-repository-api.rst`,
      'GET /simple/<project>/ with Accept: application/vnd.pypi.simple.v1+json returns name, files, meta, versions and project-status; the project is matched case-insensitively with _, - and . considered equal (index-api.md in pypi/warehouse, the source of docs.pypi.org/api/index-api/, which recommends the JSON form for new integrations; the JSON API of /pypi/<project>/json marks its releases key deprecated). A file has filename, url, hashes, size, an optional upload-time (yyyy-mm-ddThh:mm:ss.ffffffZ, UTC) and an optional yanked (true or a reason string). Every file belongs to a version listed in versions, but the response does not say which: the version is part of the file name. On 2026-10-30 pypi.org answered api-version 1.4 for requests and 404 for a name it does not know.',
    ),
    projectStatus: python.verified(
      { blocked: ['quarantined'], warned: ['archived', 'deprecated'] },
      `${SPECIFICATIONS}/project-status-markers.rst`,
      'A project has exactly one status, active when none is given. quarantined: considered generally unsafe (for example malware), and the index must not offer any of its files. archived: no new uploads, existing files stay; installers may warn. deprecated: obsolete, perhaps superseded by another project; installers may warn.',
    ),
  },
  claudeCode: {
    hooks: audited.verified(
      {
        settingsFile: '.claude/settings.json',
        event: 'PreToolUse',
        matcherSeparator: '|',
        input: { event: 'hook_event_name', tool: 'tool_name', command: 'tool_input.command', cwd: 'cwd' },
        output: { container: 'hookSpecificOutput', event: 'hookEventName', decision: 'permissionDecision', reason: 'permissionDecisionReason' },
        decisions: { deny: 'deny', ask: 'ask' },
        blockingExitCode: 2,
        onFailure: { field: 'onFailure', value: 'block', since: '2.1.295' },
        projectDir: '${CLAUDE_PROJECT_DIR}',
        settings: { hooks: 'hooks', matcher: 'matcher', handlers: 'hooks', type: 'type', commandType: 'command', command: 'command', args: 'args' },
      },
      'https://code.claude.com/docs/en/hooks',
      'A PreToolUse command hook gets the event as JSON on stdin and decides by printing one JSON object and exiting 0: deny prevents the call and shows the reason to Claude, ask prompts the user (also in auto mode), deny wins over ask. The PowerShell tool passes its command in tool_input.command with the same fields as the Bash tool. A matcher of names separated by | matches each of them exactly. With args set, command runs as an executable without a shell; on Windows it must resolve to a real executable such as a .exe, not a .cmd or .bat shim from node_modules/.bin. Without onFailure, a hook that fails to start, crashes or times out lets the call through. The if filter is best-effort; the docs recommend the permission system for hard allow or deny rules.',
    ),
    sessionStart: release13.verified(
      {
        event: 'SessionStart',
        matchers: ['startup', 'resume'],
        projectDirVariable: 'CLAUDE_PROJECT_DIR',
        firstResponseWaits: true,
        missingScriptWithBlock: 'blocks',
        cloudSetupScriptRunsBeforeClaudeCode: true,
      },
      'https://code.claude.com/docs/en/hooks#sessionstart',
      'SessionStart runs when a session starts or resumes; its matcher startup fires for a new session (also resume, clear, compact and fork). Hooks run in the background, but "Claude\'s first response still waits for the hooks to finish", and a prompt sent meanwhile does not reach Claude until they finish. A command hook may be shell form (command with $CLAUDE_PROJECT_DIR, the repository root). With onFailure set to "block" (#block-the-action-when-a-hook-fails), a PreToolUse hook whose script is missing blocks the call ("failed; blocking because onFailure is \"block\"" followed by node\'s error output); without it, the same missing script is a non-blocking error and the command runs. In cloud sessions (https://code.claude.com/docs/en/cloud-environments#setup-scripts) a setup script is a Bash script that runs as root before Claude Code launches and is skipped when a cached environment exists; SessionStart hooks of the repository\'s .claude/settings.json run in local and cloud sessions (in a session with one repository, outside a project thread), user-level ~/.claude/settings.json hooks do not reach the cloud. The docs recommend a SessionStart hook for project setup such as npm install.',
    ),
    shellTools: audited.verified(
      [
        { tool: 'Bash', shell: 'bash' },
        { tool: 'PowerShell', shell: 'powershell' },
        { tool: 'Monitor', shell: 'bash' },
      ],
      'https://code.claude.com/docs/en/tools-reference',
      'Tool names are the exact strings of hook matchers. Bash executes shell commands. PowerShell executes PowerShell commands natively; hooks get its command in tool_input.command with the same fields as Bash, and the docs say to match Bash|PowerShell in hooks that inspect shell commands: on Windows, wherever the PowerShell tool is enabled, Claude treats PowerShell as the primary shell, and without Git Bash it is enabled automatically and the Bash tool is not registered at all (also https://code.claude.com/docs/en/hooks#powershell). On Windows with Git Bash it is on by default for claude.ai and Console accounts, CLAUDE_CODE_USE_POWERSHELL_TOOL=0 turns it off, and Claude Code runs pwsh.exe or else powershell.exe 5.1. Monitor runs a command in the background and feeds its output lines back to Claude, with the same permission rules as Bash; on Windows it is available only with Git Bash; a WebSocket watch takes a ws input in place of command.',
    ),
  },
  mcp: {
    revisions: mcpFacts.verified(
      { legacy: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], modern: ['2026-07-28'] },
      `${MCP}/docs/specification/2026-07-28/basic/versioning.mdx`,
      'Modern: revisions that carry version, identity and capabilities on every request (2026-07-28 and later); legacy: revisions that open a session with the initialize handshake (2025-11-25 and earlier). A dual-era server may serve both on one stdio process: a request with the modern per-request _meta is served statelessly, an initialize request selects legacy semantics for the process. docs/docs.json lists 2026-07-28 (latest), 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05; schema/2026-07-28/schema.ts and schema/draft/schema.ts both say LATEST_PROTOCOL_VERSION = "2026-07-28".',
    ),
    lifecycle: mcpFacts.verified(
      {
        initialize: 'initialize',
        initialized: 'notifications/initialized',
        ping: 'ping',
        request: { protocolVersion: 'protocolVersion', capabilities: 'capabilities', clientInfo: 'clientInfo' },
        result: { protocolVersion: 'protocolVersion', capabilities: 'capabilities', serverInfo: 'serverInfo', instructions: 'instructions' },
      },
      `${MCP}/docs/specification/2025-11-25/basic/lifecycle.mdx`,
      'If the server supports the requested protocolVersion it must answer with the same one, otherwise with another version it supports, which should be its latest; a client that cannot use it disconnects (the same wording in 2024-11-05). After the result the client sends notifications/initialized. The initialize request must not be cancelled and, in 2025-03-26, must not be part of a batch. ping (basic/utilities/ping.mdx) is answered promptly with an empty result and may be sent before initialization. 2026-07-28 removes initialize, notifications/initialized and ping (docs/specification/2026-07-28/changelog.mdx).',
    ),
    stateless: mcpFacts.verified(
      {
        metaField: '_meta',
        protocolVersion: 'io.modelcontextprotocol/protocolVersion',
        clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
        clientInfo: 'io.modelcontextprotocol/clientInfo',
        serverInfo: 'io.modelcontextprotocol/serverInfo',
        discover: 'server/discover',
        discoverResult: { supportedVersions: 'supportedVersions', capabilities: 'capabilities', instructions: 'instructions' },
        resultType: { field: 'resultType', complete: 'complete' },
        caching: { ttl: 'ttlMs', scope: 'cacheScope', publicScope: 'public' },
        unsupportedVersionData: { supported: 'supported', requested: 'requested' },
      },
      `${MCP}/docs/specification/2026-07-28/basic/index.mdx`,
      'Every 2026-07-28 request carries params._meta with io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities (required; a request missing either is rejected with -32602) and optionally io.modelcontextprotocol/clientInfo; servers should put io.modelcontextprotocol/serverInfo in the _meta of every result, and every result must carry resultType ("complete" for a finished one; clients read an absent one as complete). Servers must implement server/discover (server/discover.mdx: supportedVersions, capabilities, instructions, serverInfo in _meta). server/utilities/caching.mdx: results of server/discover and tools/list must carry ttlMs (>= 0) and cacheScope ("public" suits lists of tools that are the same for all users). An unsupported version gets -32022 with data { supported, requested } (basic/versioning.mdx). Self-reported identity must not change behavior.',
    ),
    tools: mcpFacts.verified(
      { list: 'tools/list', call: 'tools/call', capability: 'tools', fieldsSince: { annotations: '2025-03-26', title: '2025-06-18', structuredContent: '2025-06-18' } },
      `${MCP}/docs/specification/2026-07-28/server/tools.mdx`,
      'A server with tools declares the tools capability and answers tools/list (tools in a deterministic order that does not vary per connection) and tools/call ({ name, arguments }; result content, optional structuredContent and isError). Errors of the tool itself, including input values the model can correct, belong in the result with isError: true; an unknown tool or a request that does not fit the schema is a protocol error (-32602). A tool that returns structuredContent should also return the same JSON in a text block. Tool names should be 1 to 128 characters of letters, digits, _, - and . . Annotations (readOnlyHint, openWorldHint and others) are hints that clients must treat as untrusted. Annotations arrived in 2025-03-26 (changelog.mdx), title and structured output in 2025-06-18 (changelog.mdx); in 2025-11-25 and earlier structuredContent is an object.',
    ),
    cancellation: mcpFacts.verified(
      { method: 'notifications/cancelled', requestId: 'requestId' },
      `${MCP}/docs/specification/2026-07-28/basic/patterns/cancellation.mdx`,
      'The client cancels an in-flight request with the notification notifications/cancelled and params { requestId, reason? }; the server should stop the work as soon as practical and must not send any further message for that request, and may ignore an unknown or finished request (also basic/transports/stdio.mdx). The same notification exists in the legacy revisions (2025-11-25/basic/utilities/cancellation.mdx).',
    ),
    errorCodes: mcpFacts.verified(
      { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603, unsupportedProtocolVersion: -32022 },
      `${MCP}/schema/2026-07-28/schema.ts`,
      'PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR and UNSUPPORTED_PROTOCOL_VERSION. -32601 is for a method the server does not implement. basic/index.mdx: request ids are strings or integers and never null; notifications have no id and get no response; an error response has the id of its request except when it could not be read, and the 2025-11-25 and 2026-07-28 schemas make id optional in an error response; codes from -32000 to -32019 are legacy and other codes from -32020 to -32099 that the specification does not define must not be used.',
    ),
    stdio: mcpFacts.verified(
      { delimiter: '\n', batchRevisions: ['2025-03-26'] },
      `${MCP}/docs/specification/2026-07-28/basic/transports/stdio.mdx`,
      'The server reads JSON-RPC messages from stdin and writes them to stdout, delimited by newlines and without embedded newlines; it must not write anything to stdout that is not a valid MCP message, may log UTF-8 to stderr and should exit promptly when stdin is closed. Batches: 2025-03-26 (basic/index.mdx) says implementations must support receiving JSON-RPC batches; 2025-06-18 removed batching (changelog.mdx), and later revisions have no batch message.',
    ),
    clients: {
      claudeCode: mcpFacts.verified(
        {
          addCommand: ['claude', 'mcp', 'add'],
          separator: '--',
          scopeOption: '--scope',
          projectScope: 'project',
          transportOption: '--transport',
          stdioTransport: 'stdio',
          projectFile: '.mcp.json',
          serversKey: 'mcpServers',
          projectDirVariable: 'CLAUDE_PROJECT_DIR',
          projectDirReference: '${CLAUDE_PROJECT_DIR:-.}',
        },
        'https://code.claude.com/docs/en/mcp',
        'claude mcp add [options] <name> -- <command> [args...]: everything after -- goes to the server untouched. Scopes: local (the default, ~/.claude.json), project (.mcp.json in the project root, shared through the repository; Claude Code asks before using its servers) and user. .mcp.json has a top-level mcpServers object of entries with command, args and env; an entry without type is a stdio server. Claude Code sets CLAUDE_PROJECT_DIR to the project root in the environment of the server, not in its own, so ${VAR} expansion in command or args of .mcp.json needs a default such as ${CLAUDE_PROJECT_DIR:-.}. To stop a stdio server it sends SIGINT, then SIGTERM after 100 ms and SIGKILL after a further 400 ms (macOS, Linux); on Windows it closes stdin and ends the process tree after 300 ms.',
      ),
      claudeDesktop: mcpFacts.verified(
        {
          configFiles: {
            darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
            win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
            linux: '~/.config/Claude/claude_desktop_config.json',
          },
          serversKey: 'mcpServers',
        },
        `${MCP}/docs/docs/2026-07-28/develop/connect-local-servers.mdx`,
        'The page "Connect to local MCP servers" of modelcontextprotocol.io: Claude Desktop reads mcpServers (entries with command, args and env) from claude_desktop_config.json. It documents no working directory and no variables, and its troubleshooting asks for absolute paths. The stderr of a server goes to mcp-server-<name>.log in ~/Library/Logs/Claude (macOS) or %APPDATA%\\Claude\\logs (Windows).',
      ),
      vscode: mcpFacts.verified(
        {
          file: '.vscode/mcp.json',
          serversKey: 'servers',
          typeField: 'type',
          stdioType: 'stdio',
          cwdField: 'cwd',
          workspaceFolder: '${workspaceFolder}',
          addOption: '--add-mcp',
        },
        VSCODE_MCP,
        'The source of code.visualstudio.com/docs/agents/reference/mcp-configuration. .vscode/mcp.json (in the workspace or the user profile) has a top-level servers object; a stdio server needs type "stdio" and command, and takes args, cwd (defaults to the workspace folder when run in a workspace), env and envFile; predefined variables such as ${workspaceFolder} work in the configuration. VS Code also reads the portable .mcp.json with mcpServers at the workspace root, without cwd. code --add-mcp with a JSON object of a name and the server configuration adds the server to the user profile.',
      ),
    },
  },
  git: {
    ignore: gitFacts.verified(
      { file: '.gitignore', excludeFile: '.git/info/exclude', indexFile: '.git/index', trackedFilesIgnored: false },
      'https://github.com/git/git/blob/v2.56.0/Documentation/gitignore.adoc',
      'git status and git add skip untracked files that match a pattern from a .gitignore in the same directory or a parent (deeper files override higher ones, and within one file the last matching pattern decides), then from $GIT_COMMON_DIR/info/exclude (.git/info/exclude outside linked worktrees), then from core.excludesFile. Files already tracked are not affected. Patterns: # comments, ! negation, a leading or middle / anchors the pattern to the directory of its .gitignore, a trailing / matches directories only, * and ? do not match /, **/, /** and /**/ match any number of directories; a file below an ignored directory cannot be re-included. The tracked files are the entries of $GIT_DIR/index (Documentation/gitformat-index.adoc at v2.56.0: versions 2, 3 and 4).',
    ),
    ignoreCase: audited.verified(
      { configFile: '.git/config', section: 'core', key: 'ignorecase', trueValues: ['yes', 'on', 'true', '1'] },
      'https://github.com/git/git/blob/v2.56.0/Documentation/config/core.adoc',
      'core.ignoreCase turns on workarounds for file systems that are not case sensitive (APFS, HFS+, FAT, NTFS); it defaults to false, but git clone and git init probe the file system and set it to true when appropriate, so a repository cloned on Windows or macOS has it. With it, git matches .gitignore patterns and looks up the index without regard to case: match_basename and match_pathname in dir.c compare with fspathncmp and fnmatch_icase_mem, which fold case (strncasecmp, WM_CASEFOLD) when repo_ignore_case is set, and environment.c reads core.ignorecase (both at v2.56.0). Section and variable names are case-insensitive, true is yes, on, true or 1 in any case, and a variable without = <value> is true (Documentation/config.adoc at v2.56.0).',
    ),
  },
  windows: {
    commandShims: audited.verified(
      { extensions: ['.cmd', '.ps1'], batchExtension: '.cmd', argumentsVariable: '%*' },
      'https://github.com/npm/cmd-shim/blob/v9.0.2/lib/index.js',
      'cmd-shim is "the cmd-shim used in npm to create executable scripts on Windows" (README): for each program of a package it writes <name>.cmd, which runs the program with %* (so cmd.exe reads the arguments again), <name>.ps1 for PowerShell and a sh script. npm ships the same files for itself: bin/npm.cmd, bin/npm.ps1, bin/npx.cmd and bin/npx.ps1 in github.com/npm/cli at v12.2.1, the .cmd files ending in "%NODE_EXE%" "%NPM_CLI_JS%" %*.',
    ),
    batchArguments: audited.verified(
      { extensions: ['.bat', '.cmd'] },
      'https://github.com/MicrosoftDocs/PowerShell-Docs/blob/0061dc7f35abfa6bb5ffabaada1650163761f2e1/reference/7.5/Microsoft.PowerShell.Core/About/about_Parsing.md',
      'about_Parsing (the source of https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing): on Windows, arguments for batch files are passed as raw command-line strings to cmd.exe, and untrusted input should be passed another way. In the Windows mode of $PSNativeCommandArgumentPassing, the default on Windows since PowerShell 7.3, files ending in .bat or .cmd (also cmd.exe, cscript.exe, wscript.exe, .js, .vbs and .wsf) keep the legacy argument passing of Windows PowerShell 5.1.',
    ),
  },
  python: {
    nameNormalization: python.verified(
      { separators: '[-_.]+', replacement: '-' },
      'https://packaging.python.org/en/latest/specifications/name-normalization/',
      'Names are lowercased and every run of ., - or _ becomes a single -, before lookups and comparisons (PEP 503): Friendly.Bard and friendly_bard are the same package. Read from the page source in pypa/packaging.python.org.',
    ),
    namePattern: python.verified(
      '^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$',
      'https://packaging.python.org/en/latest/specifications/name-normalization/',
      'The specification gives ^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])\\Z run with re.IGNORECASE (PEP 508).',
    ),
    projectFile: python.verified(
      'pyproject.toml',
      'https://packaging.python.org/en/latest/specifications/pyproject-toml/',
      'The configuration file of a Python project, in the project root; tools keep their own settings in its [tool.<name>] tables.',
    ),
    wheelExtension: python.verified(
      '.whl',
      'https://packaging.python.org/en/latest/specifications/binary-distribution-format/',
      'A wheel is a ZIP archive with the .whl extension; installing it unpacks files and runs no build code. Read from the page source in pypa/packaging.python.org.',
    ),
    sourceDistributionExtensions: python.verified(
      ['.tar.gz', '.zip', '.tar.bz2', '.tbz', '.tgz', '.tar', '.tar.xz', '.txz', '.tlz', '.tar.lz', '.tar.lzma'],
      'https://github.com/pypa/pip/blob/26.2.2/src/pip/_internal/utils/filetypes.py',
      'ARCHIVE_EXTENSIONS of pip without .whl: the archives pip accepts from an index besides wheels (index/package_finder.py rejects any other extension), all of them built when installed. A standard sdist is named {name}-{version}.tar.gz with the name normalized (PEP 625, source-distribution-format.rst); older uploads use the other extensions and names that are not normalized.',
    ),
    hatch: python.verified(
      { pyprojectTable: 'tool.hatch', configFile: 'hatch.toml' },
      'https://github.com/pypa/hatch/blob/hatch-v1.18.2/docs/intro.md',
      'Hatch reads its project configuration from [tool.hatch] of pyproject.toml or from hatch.toml. It has no setting of its own for a release-age delay, building from source or dependency sources; its environments install with uv (installer = "uv", the default of its internal environments) or pip (docs/how-to/environment/select-installer.md), and uv reads [tool.uv] of the project under Hatch too (tested on 2026-10-30 with Hatch 1.18.2 and uv 0.13.6).',
    ),
    interpreter: audited.verified(
      { executables: ['python', 'python3', 'py'], moduleOption: '-m', commandOption: '-c', valueOptions: ['-W', '-X', '--check-hash-based-pycs'], groupedShortOptions: true },
      'https://github.com/python/cpython/blob/v3.14.0/Doc/using/cmdline.rst',
      'python [-bBdEhiIOPqRsSuvVWx?] [-c command | -m module-name | script | - ] [args]: -m and -c end the interpreter options, and what follows goes to the module or the command; -W arg, -X option and --check-hash-based-pycs mode take a value, the other options are flags. One-letter options may be grouped after one dash: _PyOS_GetOpt in Python/getopt.c (v3.14.0, SHORT_OPTS "bBc:dEhiIm:OPqRsStuvVW:xX:?") reads them one by one, and c, m, W and X take the rest of the word or the next word, so python3 -Im pip runs pip. pip documents running itself as python -m pip, and as py -m pip with the Windows launcher (github.com/pypa/pip/blob/26.2.2/docs/html/cli/pip_install.rst).',
    ),
  },
};
