// What depcurfew init says besides the file it writes (decision D-122): warnings and notes, each with a stable code for
// init --json and the README, a level, where it is, the message and what to do. One source for the text on stdout and
// the JSON document; the errors that keep init from writing are those of apply (src/apply/warnings.ts).

export const INIT_WARNINGS = {
  'project-left-out': 'A direct subdirectory with a manifest or lockfile is left out of projects, because depcurfew apply would refuse it (it has a depcurfew.json of its own, or it is a separate git repository).',
} as const satisfies Record<string, string>;

export const INIT_NOTES = {
  'projects-listed': 'The repository root has no manifest or lockfile, but direct subdirectories do, so init lists them under projects in depcurfew.json.',
  'cooldown-kept': 'The repository (with --user, the user file of an installed tool) already sets a longer release-age delay, so cooldown.minimum keeps it instead of the default.',
  'python-builds-denied': 'installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for the platform stops installing until it is allowed.',
  'tool-only-in-ci': 'A tool appears only in a CI setup step, so depcurfew apply does not configure it under targets "auto".',
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
