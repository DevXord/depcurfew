// Facts about the environment around the package managers: how repositories pin tool versions (Corepack,
// npm devEngines, Volta, asdf) and how GitHub Actions workflows install them.
import { verifiedOn } from './define.ts';
import type { EnvironmentKnowledge } from './types.ts';

const { verified } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');

const COREPACK_README = 'https://github.com/nodejs/corepack/blob/main/README.md';
const COREPACK_CHANGELOG = 'https://github.com/nodejs/corepack/blob/main/CHANGELOG.md';
const NPM_PACKAGE_JSON = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md';

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
      { nodejs: 'node', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', deno: 'deno' },
      'https://github.com/asdf-vm/asdf-plugins/tree/master/plugins',
      'Short names in the asdf plugin index; there is no plugin named node.',
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
  claudeCode: {
    hooks: checked.verified(
      {
        settingsFile: '.claude/settings.json',
        event: 'PreToolUse',
        shellTool: 'Bash',
        input: { event: 'hook_event_name', tool: 'tool_name', command: 'tool_input.command', cwd: 'cwd' },
        output: { container: 'hookSpecificOutput', event: 'hookEventName', decision: 'permissionDecision', reason: 'permissionDecisionReason' },
        decisions: { deny: 'deny', ask: 'ask' },
        blockingExitCode: 2,
        onFailure: { field: 'onFailure', value: 'block', since: '2.1.295' },
        projectDir: '${CLAUDE_PROJECT_DIR}',
        settings: { hooks: 'hooks', matcher: 'matcher', handlers: 'hooks', type: 'type', commandType: 'command', command: 'command', args: 'args' },
      },
      'https://code.claude.com/docs/en/hooks',
      'A PreToolUse command hook gets the event as JSON on stdin and decides by printing one JSON object and exiting 0: deny prevents the call and shows the reason to Claude, ask prompts the user (also in auto mode), deny wins over ask. With args set, command runs as an executable without a shell, which also works on Windows. Without onFailure, a hook that fails to start, crashes or times out lets the call through. The if filter is best-effort; the docs recommend the permission system for hard allow or deny rules.',
    ),
  },
};
