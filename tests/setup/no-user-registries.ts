// Tests must not read the registry and index settings of the machine they run on: check, the hook and depcurfew mcp
// read the registries that the environment, the user files and the global npmrc set (decision D-168), and npm run
// exports npm_config_* (npm_config_userconfig among them) to the test process. Those variables are removed, the user
// configuration directory is the one below the home directory each test passes, and npm's global npmrc is looked for
// below a prefix that does not exist. A test that needs such a setting sets it itself and restores it.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETTINGS = /^(?:npm_config_|pnpm_config_|yarn_|bun_config_|pip_|uv_|pdm_|pipenv_)/iu;
for (const name of Object.keys(process.env)) if (SETTINGS.test(name)) delete process.env[name];
delete process.env['XDG_CONFIG_HOME'];
delete process.env['DESTDIR'];
process.env['PREFIX'] = join(tmpdir(), 'depcurfew-tests-no-npm-prefix');
