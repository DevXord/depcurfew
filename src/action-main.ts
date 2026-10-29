// Bundled into action/depcurfew.mjs. Unexpected errors fail the step; doctor findings never do here (see action.yml).
import { main } from './action.ts';

try {
  main();
} catch (error) {
  process.stderr.write(`depcurfew: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
