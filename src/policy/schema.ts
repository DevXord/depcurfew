// The policy file, defined once. The validator, the TypeScript types and schema.json all come from this definition.
// A section that is absent means depcurfew does not manage that area.
import { TOOL_IDS } from '../knowledge/schema.ts';
import { DURATION_PATTERN, parseDuration } from './duration.ts';
import { PACKAGE_PATTERN, validatePackagePattern } from './package-pattern.ts';
import { PROJECT_DIRECTORY_PATTERN, validateProjectDirectory } from './project-directory.ts';
import {
  anyOf,
  anyString,
  list,
  literal,
  object,
  oneOfStrings,
  optional,
  required,
  text,
  withDefault,
  type Input,
  type Output,
} from './shape.ts';

const duration = text({
  label: 'a duration such as "3d"',
  kind: 'invalid duration',
  pattern: DURATION_PATTERN,
  examples: ['3d', '36h', '1w'],
  description:
    'Minimum age of a release before it is installed or proposed: a whole number followed by m (minutes), h (hours), d (days) or w (weeks). Converted to each tool\'s unit, always rounding up.',
  parse: (input) => {
    const result = parseDuration(input);
    return result.ok ? { ok: true, value: result.duration } : result;
  },
});

const packagePatterns = (description: string) =>
  list(
    text({
      label: 'a package name or pattern',
      kind: 'invalid package pattern',
      pattern: PACKAGE_PATTERN,
      description:
        'An npm package name such as "esbuild" or "@scope/name", or a pattern with *, such as "@scope/*". Python packages take the prefix pypi:, e.g. "pypi:requests" or "pypi:acme-*". No versions.',
      parse: (input) => {
        const message = validatePackagePattern(input);
        return message === undefined ? { ok: true, value: input } : { ok: false, message };
      },
    }),
    { unique: true, description },
  );

const access = (description: string) => oneOfStrings(['allow', 'deny'], { description });

export const cooldownShape = object(
  {
    minimum: required(duration),
    exclude: withDefault(packagePatterns('Packages that skip the release-age delay, e.g. your own scope.'), []),
    securityUpdates: withDefault(
      oneOfStrings(['bypass', 'delay'], {
        description: 'Whether security updates skip the delay ("bypass") or wait like other updates ("delay"), where the tool can tell them apart.',
      }),
      'bypass',
    ),
  },
  { description: 'Release-age delay (cooldown): freshly published versions wait before they are used.' },
);

export const installScriptsShape = object(
  {
    default: required(
      access('Whether dependency lifecycle scripts (preinstall, install, postinstall) run by default; for Python, whether packages may be built from source.'),
    ),
    allow: withDefault(
      packagePatterns('Packages whose lifecycle scripts may run when the default is "deny"; Python packages listed here are always built from source.'),
      [],
    ),
    deny: withDefault(
      packagePatterns(
        'Packages you reviewed that work without their lifecycle scripts, so the scripts stay blocked on purpose and doctor does not report them, for example "fsevents", which ships a prebuilt binary. A package cannot be in both lists, also not through two patterns that match the same name. Python packages listed here must not be built from source: doctor reports a tool that would still build one.',
      ),
      [],
    ),
  },
  { description: 'Code that dependencies run when they are installed: lifecycle scripts in npm, building from source in Python.' },
);

export const sourcesShape = object(
  {
    git: optional(access('Dependencies installed from git repositories.')),
    remoteTarball: optional(access('Dependencies installed from tarball URLs outside the registry.')),
    file: optional(access('Dependencies installed from local tarball files.')),
    directory: optional(access('Dependencies installed from local directories.')),
  },
  { description: 'Where dependencies may come from besides the registry. An absent field is not managed.' },
);

export const targetsShape = anyOf(
  [
    literal('auto', { description: 'Configure the tools detected in the repository.' }),
    list(oneOfStrings(TOOL_IDS, { description: 'A tool depcurfew can configure.' }), {
      label: 'a list of tools',
      unique: true,
      nonEmpty: 'use "auto" to detect tools',
      description: 'Configure exactly these tools.',
    }),
  ],
  { description: 'Tools to configure: "auto" detects them in the repository, or list them explicitly.' },
);

export const projectsShape = list(
  text({
    label: 'a directory path such as "frontend"',
    kind: 'invalid project directory',
    pattern: PROJECT_DIRECTORY_PATTERN,
    examples: ['frontend', 'services/api'],
    description: 'A directory relative to the repository root, with / between directories, e.g. "frontend" or "services/api". No patterns, no "..", no / at either end.',
    parse: (input) => {
      const message = validateProjectDirectory(input);
      return message === undefined ? { ok: true, value: input } : { ok: false, message };
    },
  }),
  {
    unique: true,
    description:
      'Directories of independent projects in this repository, each with its own manifest and lockfile (e.g. frontend and backend). depcurfew configures each one with this policy as a project of its own, and configures Renovate and Dependabot once, from the repository root, for all of them. The repository root is always configured as well. A project must not be inside another one, must not be a workspace package of the root and must not have a depcurfew.json of its own.',
  },
);

/** Which findings make depcurfew doctor exit with 1 (decision D-112). */
export const FAIL_ON_LEVELS = ['error', 'warning'] as const;

export const doctorShape = object(
  {
    // No default here: a section without failOn leaves the choice to doctor, which then fails on errors only and says
    // that the default decided (decision D-116).
    failOn: optional(
      oneOfStrings(FAIL_ON_LEVELS, {
        description:
          'Which findings make depcurfew doctor exit with 1 and fail the GitHub Action: "error" (only errors, also when left out) or "warning" (warnings too). Notes never fail. doctor --fail-on and the input fail-on of the Action override it.',
      }),
    ),
  },
  {
    description:
      'How depcurfew doctor and the GitHub Action treat findings. Without this section only errors fail, as before; depcurfew init writes "failOn": "warning".',
  },
);

export const policyShape = object(
  {
    $schema: optional(anyString({ description: 'JSON Schema of this file, for editor support.' })),
    version: required(literal(1, { description: 'Version of the policy format.' })),
    cooldown: optional(cooldownShape),
    installScripts: optional(installScriptsShape),
    sources: optional(sourcesShape),
    targets: withDefault(targetsShape, 'auto'),
    projects: withDefault(projectsShape, []),
    doctor: optional(doctorShape),
  },
  { description: 'One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate and Dependabot.' },
);

/** The policy as written in depcurfew.json. */
export type Policy = Input<typeof policyShape>;
/** The policy after validation: defaults filled in, durations parsed. */
export type ResolvedPolicy = Output<typeof policyShape>;
