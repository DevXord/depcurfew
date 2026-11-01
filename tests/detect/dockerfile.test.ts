// The Dockerfile reader (src/detect/dockerfile.ts), the stages detection builds from it (src/detect/dockerfiles.ts) and
// the command reader for RUN lines and CI run steps (src/detect/commands.ts).
import { describe, expect, it } from 'vitest';
import { findToolCommands, splitCommands } from '../../src/detect/commands.ts';
import { argDeclarations, readDockerfile, substitute } from '../../src/detect/dockerfile.ts';
import { readDockerStages } from '../../src/detect/dockerfiles.ts';
import { detectionFacts } from '../../src/detect/knowledge.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';

const facts = detectionFacts(knowledgeBase, environment);
const syntax = facts.docker.syntax;

function read(lines: readonly string[]) {
  return readDockerfile(lines.join('\n'), syntax).map(({ keyword, text, line, heredocs }) => ({ keyword, text, line, ...(heredocs.length === 0 ? {} : { heredocs }) }));
}

function stages(lines: readonly string[]) {
  return readDockerStages('Dockerfile', lines.join('\n'), facts.docker);
}

describe('readDockerfile', () => {
  it('reads instructions in any case and skips comments and empty lines', () => {
    expect(read(['# a comment', '', 'from node:22', '  run npm ci', 'Copy . .'])).toEqual([
      { keyword: 'FROM', text: 'node:22', line: 3 },
      { keyword: 'RUN', text: 'npm ci', line: 4 },
      { keyword: 'COPY', text: '. .', line: 5 },
    ]);
  });

  it('joins continuation lines and drops comment and empty lines inside them', () => {
    expect(read(['RUN apt-get update && \\', '  # install the packages', '', '  npm ci --omit=dev \\  ', '  && npm test', 'FROM x'])).toEqual([
      { keyword: 'RUN', text: 'apt-get update &&   npm ci --omit=dev   && npm test', line: 1 },
      { keyword: 'FROM', text: 'x', line: 6 },
    ]);
  });

  it('reads the escape directive, and no directive after a comment or an instruction', () => {
    expect(read(['# escape=`', 'RUN npm `', '  ci', 'FROM x \\', 'AS y'])).toEqual([
      { keyword: 'RUN', text: 'npm   ci', line: 2 },
      { keyword: 'FROM', text: 'x \\', line: 4 },
      { keyword: 'AS', text: 'y', line: 5 },
    ]);
    // After a comment the line is a comment, so the backslash still continues lines.
    expect(read(['# hello', '# escape=`', 'RUN npm \\', '  ci'])).toEqual([{ keyword: 'RUN', text: 'npm   ci', line: 3 }]);
    // Parser directive keys are not case-sensitive; an unknown directive ends the directives.
    expect(read(['# ESCAPE = `', 'RUN a `', 'b'])).toEqual([{ keyword: 'RUN', text: 'a b', line: 2 }]);
    expect(read(['# unknown=1', '# escape=`', 'RUN a `', 'b'])).toEqual([
      { keyword: 'RUN', text: 'a `', line: 3 },
      { keyword: 'B', text: '', line: 4 },
    ]);
  });

  it('reads here-documents as part of their instruction, whatever their lines look like', () => {
    expect(read(['RUN <<EOF', 'FROM node:20', '# not a comment', 'npm ci', 'EOF', 'RUN <<-"END" bash', '\tnpm test', '\tEND', 'FROM after'])).toEqual([
      { keyword: 'RUN', text: '<<EOF', line: 1, heredocs: [{ body: 'FROM node:20\n# not a comment\nnpm ci', line: 2, command: '' }] },
      { keyword: 'RUN', text: '<<-"END" bash', line: 6, heredocs: [{ body: 'npm test', line: 7, command: 'bash' }] },
      { keyword: 'FROM', text: 'after', line: 9 },
    ]);
  });

  it('stays linear on deep nesting and very long lines', () => {
    const long = `RUN ${'npm ci && '.repeat(50_000)}true`;
    const continued = Array.from({ length: 50_000 }, () => 'RUN \\').join('\n');
    const spaces = `# escape=${' '.repeat(200_000)}x`;
    const brackets = `FROM node:\${${'{'.repeat(100_000)}`;
    const quotes = `RUN ${'"'.repeat(200_001)}`;
    const start = performance.now();
    for (const text of [long, continued, spaces, brackets, quotes, `${'\\\n'.repeat(100_000)}`]) {
      readDockerStages('Dockerfile', text, facts.docker);
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe('ARG substitution', () => {
  const args = new Map<string, string | undefined>([
    ['NODE', '22'],
    ['EMPTY', ''],
    ['UNSET', undefined],
  ]);

  it.each([
    ['node:${NODE}-alpine', 'node:22-alpine'],
    ['node:$NODE', 'node:22'],
    ['node:${UNSET:-24}', 'node:24'],
    ['node:${EMPTY:-24}', 'node:24'],
    ['node:${EMPTY-24}', 'node:'],
    ['node:${NODE:+lts}', 'node:lts'],
    ['node:22${UNSET+-x}', 'node:22'],
    ['node:\\$NODE', 'node:$NODE'],
  ])('%s is %s', (text, value) => {
    expect(substitute(text, args, '\\')).toEqual({ ok: true, value });
  });

  it('cannot tell a variable without a value', () => {
    expect(substitute('node:${UNSET}', args, '\\')).toEqual({ ok: false, variable: 'UNSET' });
    expect(substitute('node:$OTHER', args, '\\')).toEqual({ ok: false, variable: 'OTHER' });
  });

  it('reads several ARGs on one line, with quotes', () => {
    expect(argDeclarations('A=1 B="two words" C')).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', undefined],
    ]);
  });
});

describe('readDockerStages', () => {
  it('recognizes the official node and python images under every name and tag form', () => {
    const images = [
      'node:22',
      'library/node:22.11',
      'docker.io/library/node:22.11.0-bookworm-slim',
      'index.docker.io/library/node:lts-alpine',
      'docker.io/node:jod',
      'node:lts-jod',
      'node:current',
      'node',
      'node:alpine',
      'node@sha256:0123',
      'node:22@sha256:0123',
      'ghcr.io/library/node:22',
      'mycompany/node:22',
      'python:3.12-slim',
      'python:3.13.14-alpine3.24',
      'python:slim-trixie',
      'python:3',
      'python:3.16-rc',
    ];
    const result = stages(images.map((image) => `FROM ${image}`));
    expect(result.info.stages.map((stage) => stage.runtime)).toEqual([
      { tool: 'node', tag: '22', version: '22' },
      { tool: 'node', tag: '22.11', version: '22.11' },
      { tool: 'node', tag: '22.11.0-bookworm-slim', version: '22.11.0' },
      { tool: 'node', tag: 'lts-alpine', version: 'lts' },
      { tool: 'node', tag: 'jod', version: 'jod' },
      { tool: 'node', tag: 'lts-jod', version: 'jod' },
      { tool: 'node', tag: 'current', version: 'current' },
      { tool: 'node', version: 'latest' },
      { tool: 'node', tag: 'alpine', version: 'current' },
      { tool: 'node', unknown: 'the image is pinned by digest only (node@sha256:0123)' },
      { tool: 'node', tag: '22', version: '22' },
      undefined,
      undefined,
      { tool: 'python', tag: '3.12-slim', version: '3.12' },
      { tool: 'python', tag: '3.13.14-alpine3.24', version: '3.13.14' },
      { tool: 'python', tag: 'slim-trixie', version: 'latest' },
      { tool: 'python', tag: '3', version: '3' },
      { tool: 'python', tag: '3.16-rc', unknown: 'depcurfew does not know the tag 3.16-rc' },
    ]);
  });

  it('substitutes ARGs before the first FROM, and stages inherit the image of the stage they start from', () => {
    const result = stages([
      'ARG NODE=22',
      'ARG VARIANT',
      'FROM --platform=$BUILDPLATFORM node:${NODE}-alpine AS Base',
      'RUN npm install -g npm@11.17.0',
      'FROM base AS build',
      'RUN npm ci',
      'FROM node:${VARIANT}',
      'RUN ["npm", "install"]',
      'FROM ${IMAGE}',
    ]);
    expect(result.info.stages).toEqual([
      { line: 3, name: 'base', image: 'node:22-alpine', runtime: { tool: 'node', tag: '22-alpine', version: '22' }, commands: [{ kind: 'upgrade', tool: 'npm', version: '11.17.0', line: 4 }] },
      { line: 5, name: 'build', image: 'base', from: 0, runtime: { tool: 'node', tag: '22-alpine', version: '22' }, commands: [{ kind: 'install', tool: 'npm', lockfile: true, line: 6 }] },
      { line: 7, runtime: { tool: 'node', unknown: 'the ARG VARIANT it uses has no value in the Dockerfile' }, commands: [{ kind: 'install', tool: 'npm', line: 8 }] },
      { line: 9, commands: [] },
    ]);
    expect(result.versions.map(({ tool, declaration }) => [tool, declaration])).toEqual([
      ['node', { version: '22', source: 'dockerfile', file: 'Dockerfile', line: 3, stage: 'base' }],
      ['npm', { version: '11.17.0', source: 'dockerfile', file: 'Dockerfile', line: 4, stage: 'base' }],
    ]);
  });

  it('reads RUN in shell form, exec form and here-documents fed to a shell', () => {
    const result = stages([
      'FROM python:3.12',
      'RUN --mount=type=cache,target=/root/.cache pip install -r requirements.txt',
      'RUN ["sh", "-c", "python -m pip install --upgrade pip==26.1"]',
      'RUN <<EOF',
      'set -e',
      'python3.12 -Im pip install --upgrade pip',
      'EOF',
      'RUN cat <<EOF > /tmp/script',
      'pip install not-run-here',
      'EOF',
    ]);
    expect(result.info.stages[0]?.commands).toEqual([
      { kind: 'install', tool: 'pip', line: 2 },
      { kind: 'upgrade', tool: 'pip', version: '26.1.0', line: 3 },
      { kind: 'upgrade', tool: 'pip', version: 'latest', line: 6 },
    ]);
  });
});

describe('findToolCommands', () => {
  const commands = (script: string) => findToolCommands(script, facts.commands).commands.map(({ offset: _offset, ...command }) => command);

  it.each([
    ['npm ci', [{ kind: 'install', tool: 'npm', lockfile: true }]],
    ['npm clean-install --omit=dev', [{ kind: 'install', tool: 'npm', lockfile: true }]],
    ['NODE_ENV=production npm i', [{ kind: 'install', tool: 'npm' }]],
    ['sudo -E npm install --global npm@11.19.1', [{ kind: 'upgrade', tool: 'npm', version: '11.19.1' }]],
    ['npm i -g npm', [{ kind: 'upgrade', tool: 'npm', version: 'latest' }]],
    ['npm install --location=global npm@latest', [{ kind: 'upgrade', tool: 'npm', version: 'latest' }]],
    ['npm --prefix web install', [{ kind: 'install', tool: 'npm' }]],
    ['npm run build && npm test', []],
    ['echo "npm i -g npm@1"', []],
    ['corepack enable', []],
    ['corepack enable npm', [{ kind: 'upgrade', tool: 'npm' }]],
    ['corepack install -g npm@11.17.0', [{ kind: 'upgrade', tool: 'npm', version: '11.17.0' }]],
    ['if true; then npm ci; fi', [{ kind: 'install', tool: 'npm', lockfile: true }]],
    ['pip install --no-cache-dir -r requirements.txt', [{ kind: 'install', tool: 'pip' }]],
    ['pip3 install -U pip setuptools', [{ kind: 'upgrade', tool: 'pip', version: 'latest' }]],
    ["python -m pip install 'pip>=26.1'", [{ kind: 'upgrade', tool: 'pip', version: '>=26.1' }]],
    ['/venv/bin/pip install .', [{ kind: 'install', tool: 'pip' }]],
    ['uv pip install flask', []],
    ['python -c "import pip"', []],
  ])('%s', (script, expected) => {
    expect(commands(script)).toEqual(expected);
  });

  it('splits on operators and keeps ${VAR} in its word', () => {
    expect(splitCommands('a ${B} c; d && e | f').map((words) => words.map((word) => word.text))).toEqual([['a', '${B}', 'c'], ['d'], ['e'], ['f']]);
  });

  it('stays linear on long and unbalanced input', () => {
    const start = performance.now();
    for (const script of ['npm ci;'.repeat(100_000), '"'.repeat(300_001), '$('.repeat(100_000), '\\\n'.repeat(100_000), 'a '.repeat(200_000)]) {
      findToolCommands(script, facts.commands);
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
