import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');

const DENO_JSON = 'https://docs.deno.com/runtime/reference/deno_json/#minimum-dependency-age';
const SUPPLY_CHAIN = 'https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age';
const SCHEMA = 'https://github.com/denoland/deno/blob/v2.9.8/cli/schemas/config-file.v1.json';
const INSTALL = 'https://docs.deno.com/runtime/reference/cli/install/';
const NOT_SUPPORTED = 'https://docs.deno.com/examples/local_unpublished_packages_tutorial/#what-is-not-supported';
const release = (version: string) => `https://github.com/denoland/deno/releases/tag/v${version}`;

const unsupported = (note: string): SourceKnowledge => ({ setting: verified(null, NOT_SUPPORTED, note) });

const WORKSPACES = 'https://github.com/denoland/docs/blob/main/runtime/fundamentals/workspaces.md';

export const deno: ToolKnowledge = {
  id: 'deno',
  name: 'Deno',
  kind: 'package-manager',
  cooldown: {
    setting: verified(
      'minimumDependencyAge',
      DENO_JSON,
      'A number or string, or the object form { "age": ..., "exclude": [...] }. Covers npm and JSR packages.',
    ),
    configFiles: verified(
      ['deno.json', '.npmrc'],
      SUPPLY_CHAIN,
      'min-release-age in .npmrc since 2.8; also NPM_CONFIG_MIN_RELEASE_AGE. This page does not state precedence; denoland/deno#35458 gives CLI flag, deno.json, .npmrc, environment, built-in default.',
    ),
    cliFlag: verified(
      '--minimum-dependency-age',
      DENO_JSON,
      'Alias --min-dep-age since 2.9.3. deno install honours it since 2.5.5; deno add, deno remove and deno x since 2.9.4.',
    ),
    unit: verified(
      'minutes',
      SCHEMA,
      'Numbers are minutes; strings may be an ISO-8601 duration (P3D, PT72H), an absolute date or an RFC3339 timestamp; 0 turns it off. The .npmrc format differs (see npmrcFormat).',
    ),
    availableSince: disputed(
      'The 2.5.5 release notes ship the flag, the deno.json key and exclude as unstable; the release blog says the feature was introduced in 2.6.',
      evidence('2.5.5', release('2.5.5')),
      evidence('2.6.0', 'https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default'),
    ),
    default: verified(
      [
        { since: '0.0.0', value: null },
        { since: '2.9.0', value: 1440 },
      ],
      DENO_JSON,
      'Since 2.9 a 24-hour minimum applies when nothing is configured; set 0 to turn it off. Whether the default covers JSR is not stated.',
    ),
    exclude: {
      setting: verified('minimumDependencyAge.exclude', SCHEMA),
      availableSince: verified('2.5.5', release('2.5.5')),
      patternSyntax: verified(
        'Specifiers prefixed npm: or jsr:; a trailing * matches by prefix (npm:@scope/*) since 2.9.2',
        SCHEMA,
        'Before 2.9.2 wildcard entries were stored literally and never matched. No CLI flag or .npmrc key for exclusions.',
      ),
    },
    securityUpdates: uncertain(
      'applies',
      SUPPLY_CHAIN,
      'No security bypass is documented; only per-package exclude or an age of 0.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'deny-except-allowlist' }],
      INSTALL,
      'npm lifecycle scripts run only when approved, and only with a node_modules directory. deno x / dx runs them after its download prompt is accepted.',
    ),
    allowList: {
      setting: verified(
        'allowScripts',
        'https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts',
        'deno approve-scripts writes it. --allow-scripts=npm:pkg on the CLI exists since 1.45.',
      ),
      file: verified(
        'deno.json',
        'https://docs.deno.com/examples/npm_lifecycle_scripts_tutorial/',
        'Must be set at the workspace root.',
      ),
      availableSince: verified('2.6.0', 'https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts'),
      format: verified('true, an array of npm: constraints (semver ranges allowed, tags rejected) or { "allow": ..., "deny": [...] }', SCHEMA),
    },
    disableAll: uncertain(
      'allowScripts: false',
      SCHEMA,
      'Scripts do not run by default. The schema accepts a boolean allowScripts, but no page states that false turns all scripts off. deno x has --ignore-scripts.',
    ),
  },
  sources: {
    git: unsupported('git+https: and git+ssh: dependencies are not supported in package.json.'),
    remoteTarball: unsupported('Tarball URL dependencies are not supported in package.json.'),
    file: unsupported(
      'No setting. Since 2.8 file: and link: entries are silently skipped (scope disputed, see fileLinkSkipped); deno.json "links" overrides dependencies with local packages.',
    ),
    directory: unsupported('No setting; local directories behave like file: and link: entries (see fileLinkSkipped).'),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['deno.lock'] }],
      'https://github.com/denoland/docs/blob/main/runtime/reference/deno_json.md',
      'The default location; lock.path in deno.json can move it and "lock": false turns it off.',
    ),
    manifests: verified(['deno.json', 'deno.jsonc'], 'https://github.com/denoland/docs/blob/main/runtime/fundamentals/configuration.md'),
    workspaces: verified(
      { files: ['deno.json', 'deno.jsonc'], key: 'workspace' },
      WORKSPACES,
      'Paths of members; globs and ! exclusions since Deno 2.1.',
    ),
    workspacesObjectKey: verified('members', WORKSPACES),
  },
  extra: {
    ageObjectKey: verified('age', SCHEMA, 'In the object form of minimumDependencyAge, age holds the delay and exclude the exemptions.'),
    excludeWildcards: verified(
      { since: '2.9.2', trailingOnly: true },
      SCHEMA,
      'A trailing * matches by prefix (npm:@scope/*) since 2.9.2; earlier wildcard entries never matched.',
    ),
    npmSpecifierPrefix: verified('npm:', SCHEMA, 'Exclusions and allowScripts entries name npm packages as npm:<name>.'),
    allowAllScripts: verified({ setting: 'allowScripts', since: '2.6.0', value: true }, SCHEMA, 'allowScripts: true allows every npm lifecycle script.'),
    latestVersion: verified('2.9.8', release('2.9.8')),
    npmrcFormat: disputed(
      'The safe choice is an integer number of days, which also matches npm.',
      evidence('whole days only, e.g. min-release-age=3', SUPPLY_CHAIN),
      evidence('a duration with a unit, e.g. min-release-age=72h', 'https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default'),
    ),
    fileLinkSkipped: disputed(
      'Official pages disagree on whether the project’s own file: and link: dependencies are skipped, or only those in published packages’ metadata.',
      evidence('file: and link: dependencies in the project package.json are silently skipped', NOT_SUPPORTED),
      evidence(
        'file: and link: specifiers in registry metadata of npm packages are skipped',
        'https://deno.com/blog/v2.8#file-and-link-dependencies-in-npm-packages',
      ),
    ),
    denoXCooldown: verified('deno x honours minimumDependencyAge only since 2.9.4', release('2.9.4')),
    dxRunsScripts: verified('dx defaults to --allow-all and runs lifecycle scripts once the download prompt is accepted', 'https://deno.com/blog/v2.6'),
  },
};
