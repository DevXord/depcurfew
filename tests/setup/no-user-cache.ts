// Tests must not read the user's own cache: check, the hook, depcurfew mcp and doctor read the local OSV.dev data of
// depcurfew osv update from depcurfew's user cache directory (decision D-150), and a copy the developer downloaded
// would change their answers. The cache directory is pointed at one that does not exist; a test that needs local data
// passes its own directory (the osvData dependency).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nowhere = join(tmpdir(), 'depcurfew-tests-no-user-cache');
process.env['XDG_CACHE_HOME'] = nowhere;
process.env['LOCALAPPDATA'] = nowhere;
