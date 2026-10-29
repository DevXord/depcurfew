export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether each stream may be colored (see color.ts); absent means plain text. */
  colors?: { stdout: boolean; stderr: boolean };
}
