// What depcurfew init says besides the file it writes (decision D-122): warnings and notes, each with a stable code for
// init --json and the README, a level, where it is, the message and what to do. One source for the text on stdout and
// the JSON document; the errors that keep init from writing are those of apply (src/apply/warnings.ts).

export const INIT_WARNINGS = {
  'project-left-out': 'A direct subdirectory with a manifest or lockfile is left out of projects, because depcurfew apply would refuse it (it has a depcurfew.json of its own, it is a separate git repository, or its name differs from that of a listed directory only in case).',
} as const satisfies Record<string, string>;

export const INIT_NOTES = {
  'projects-listed': 'The repository root has no manifest or lockfile, but direct subdirectories do, so init lists them under projects in depcurfew.json.',
  'cooldown-kept': 'The repository (with --user, the user file of an installed tool) already sets a longer release-age delay, so cooldown.minimum keeps it instead of the default; a fixed date of uv, PDM or Deno counts as the whole days since it.',
  'sources-kept': 'An .npmrc of the repository already denies a dependency source the default policy allows (allow-file=none, allow-directory=none), so init writes "deny" for it in sources.',
  'security-delay-kept': 'Renovate already delays security updates (vulnerabilityAlerts.minimumReleaseAge), so init writes cooldown.securityUpdates "delay" instead of "bypass", which would make depcurfew apply remove the delay.',
  'exclusions-kept': "The tools' own exception lists already exempt packages from the release-age delay (npm's min-release-age-exclude, pnpm's minimumReleaseAgeExclude, Dependabot's cooldown.exclude...), so init lists them in cooldown.exclude, where depcurfew apply keeps them; review each before depcurfew apply.",
  'install-scripts-kept': "The package managers' own allow-lists already let packages run install scripts (pnpm's allowBuilds or onlyBuiltDependencies, Bun's trustedDependencies, Yarn's dependenciesMeta, npm's or Deno's allowScripts), so init lists them in installScripts.allow; review each before depcurfew apply.",
  'python-builds-denied': 'installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for the platform stops installing until it is allowed.',
  'tool-only-in-ci': 'A tool appears only in a CI setup step, so depcurfew apply does not configure it under targets "auto".',
  'install-script-denied': 'A lockfile has a package whose install script depcurfew knows it does not need (esbuild, fsevents), so init adds it to installScripts.deny; the note says what changes without the script.',
  'install-script-project-task': 'A lockfile has a package whose install script only does a task of the project (lefthook installs the git hooks), so init adds it to installScripts.deny; the fix says how the project runs that task itself.',
  'install-scripts-to-review':
    'A lockfile has other packages with install scripts, or composer.lock has Composer plugins (the note says which ones config.allow-plugins in composer.json already allows), which installScripts.default "deny" blocks; review each before depcurfew apply.',
  'composer-source-checkouts':
    'config.preferred-install in composer.json makes Composer install packages of composer.lock from their VCS repositories, which sources.git "deny" does not allow, so depcurfew doctor reports them; the note says which entry and which packages.',
  'bot-config-unreadable':
    'The Dependabot configuration uses a YAML alias, which Dependabot does not accept, so it reads no configuration from the file, and init does not read the delays it sets when it chooses cooldown.minimum.',
  'install-scripts-not-recorded': 'A lockfile does not record which packages have install scripts (pnpm-lock.yaml, yarn.lock, a bun.lock that marks none, which Bun before 1.4.4 writes), or is in a format depcurfew does not read, so init can name only the packages depcurfew knows.',
} as const satisfies Record<string, string>;

export const INIT_CODES = { ...INIT_WARNINGS, ...INIT_NOTES } as const;

interface Message {
  /** Relative to the directory init works on; under ~/ with --user. */
  location: { file: string; line?: number };
  /** Without a final period: the text puts the code after it. */
  message: string;
  fix: string;
}

/** A warning or note of init, in the shape of the warnings of apply --json; the code decides the level. */
export type InitMessage = (Message & { code: keyof typeof INIT_WARNINGS; level: 'warning' }) | (Message & { code: keyof typeof INIT_NOTES; level: 'note' });
