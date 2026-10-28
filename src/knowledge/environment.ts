// Facts about the environment around the package managers: how repositories pin tool versions (Corepack,
// npm devEngines, Volta, asdf) and how GitHub Actions workflows install them.
import { verifiedOn } from './define.ts';
import type { EnvironmentKnowledge } from './types.ts';

const { verified } = verifiedOn('2026-10-28');

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
  },
};
