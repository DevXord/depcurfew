// The policy file, defined once. The validator, the TypeScript types and schema.json all come from this definition.
// A section that is absent means depgate does not manage that area.
import { TOOL_IDS } from '../knowledge/schema.ts';
import { DURATION_PATTERN, parseDuration } from './duration.ts';
import { PACKAGE_PATTERN, validatePackagePattern } from './package-pattern.ts';
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
      description: 'A package name such as "esbuild" or "@scope/name", or a pattern with *, such as "@scope/*". No versions.',
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
    default: required(access('Whether dependency lifecycle scripts (preinstall, install, postinstall) run by default.')),
    allow: withDefault(packagePatterns('Packages whose lifecycle scripts may run when the default is "deny".'), []),
  },
  { description: 'Dependency lifecycle scripts.' },
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
    list(oneOfStrings(TOOL_IDS, { description: 'A tool depgate can configure.' }), {
      label: 'a list of tools',
      unique: true,
      nonEmpty: 'use "auto" to detect tools',
      description: 'Configure exactly these tools.',
    }),
  ],
  { description: 'Tools to configure: "auto" detects them in the repository, or list them explicitly.' },
);

export const policyShape = object(
  {
    $schema: optional(anyString({ description: 'JSON Schema of this file, for editor support.' })),
    version: required(literal(1, { description: 'Version of the policy format.' })),
    cooldown: optional(cooldownShape),
    installScripts: optional(installScriptsShape),
    sources: optional(sourcesShape),
    targets: withDefault(targetsShape, 'auto'),
  },
  { description: 'One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, Renovate and Dependabot.' },
);

/** The policy as written in depgate.json. */
export type Policy = Input<typeof policyShape>;
/** The policy after validation: defaults filled in, durations parsed. */
export type ResolvedPolicy = Output<typeof policyShape>;
