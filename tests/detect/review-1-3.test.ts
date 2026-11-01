// Fixes after the 1.3.0 review (decision D-105): installs by pnpm, Yarn and Bun, npm install -g of another package,
// here-document markers inside quotes, ARG values that grow without bound, matrix values and working directories,
// and linear time on pathological input.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findToolCommands, isCommandOption, matchesExecutable } from '../../src/detect/commands.ts';
import { readDockerfile } from '../../src/detect/dockerfile.ts';
import { readDockerStages } from '../../src/detect/dockerfiles.ts';
import { detectProject } from '../../src/detect/index.ts';
import { detectionFacts } from '../../src/detect/knowledge.ts';
import { environment, knowledgeBase } from '../../src/knowledge/index.ts';

const facts = detectionFacts(knowledgeBase, environment);
const MIB = 1024 * 1024;

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-review-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

const commands = (script: string) => findToolCommands(script, facts.commands).commands.map(({ offset: _offset, ...command }) => command);

describe('install commands', () => {
  it.each([
    ['npm install -g @vercel/ncc', []],
    ['npm i --global typescript', []],
    ['npm install --location=global pnpm', []],
    ['npm install --global npm@11.19.1', [{ kind: 'upgrade', tool: 'npm', version: '11.19.1' }]],
    ['npm ci', [{ kind: 'install', tool: 'npm' }]],
    ['pnpm install --frozen-lockfile', [{ kind: 'install', tool: 'pnpm' }]],
    ['pnpm i', [{ kind: 'install', tool: 'pnpm' }]],
    ['pnpm add -D esbuild', [{ kind: 'install', tool: 'pnpm' }]],
    ['pnpm run build', []],
    ['pnpm', []],
    ['yarn', [{ kind: 'install', tool: 'yarn' }]],
    ['yarn --immutable', [{ kind: 'install', tool: 'yarn' }]],
    ['yarn install', [{ kind: 'install', tool: 'yarn' }]],
    ['yarn add left-pad', [{ kind: 'install', tool: 'yarn' }]],
    ['yarn build', []],
    ['bun install', [{ kind: 'install', tool: 'bun' }]],
    ['bun add zod', [{ kind: 'install', tool: 'bun' }]],
    ['bun run test', []],
  ])('%s', (script, expected) => {
    expect(commands(script)).toEqual(expected);
  });

  it('reads -c and a version suffix without a regular expression that backtracks', () => {
    expect(['-c', '-ec', '-xc', '-cx'].map(isCommandOption)).toEqual([true, true, true, true]);
    expect(['-e', '--c', 'c', '-c!', `-${'c'.repeat(100)}`].map(isCommandOption)).toEqual([false, false, false, false, false]);
    expect(matchesExecutable('python3.12', ['python'])).toBe(true);
    expect(matchesExecutable('pip3', ['pip'])).toBe(true);
    expect(matchesExecutable('python.12', ['python'])).toBe(false);
    expect(matchesExecutable('3.12', ['python'])).toBe(false);
    expect(matchesExecutable(`python${'1'.repeat(100)}`, ['python'])).toBe(false);
  });

  it('treats npm install -g of another package as no install in a Dockerfile either', () => {
    const result = readDockerStages('Dockerfile', ['FROM node:22', 'RUN npm install -g pnpm@10 && pnpm install', 'RUN npm ci'].join('\n'), facts.docker);
    expect(result.info.stages[0]?.commands).toEqual([
      { kind: 'install', tool: 'pnpm', line: 2 },
      { kind: 'install', tool: 'npm', line: 3 },
    ]);
  });
});

describe('here-documents', () => {
  it('does not start one at a marker inside quotes, as BuildKit splits words with quotes kept', () => {
    const lines = ['FROM node:22', 'RUN echo "a <<b" && npm ci', "RUN echo 'x <<EOF' > file", 'RUN npm test', 'FROM node:24'];
    expect(readDockerfile(lines.join('\n'), facts.docker.syntax).map((instruction) => [instruction.keyword, instruction.heredocs.length])).toEqual([
      ['FROM', 0],
      ['RUN', 0],
      ['RUN', 0],
      ['RUN', 0],
      ['FROM', 0],
    ]);
    expect(readDockerStages('Dockerfile', lines.join('\n'), facts.docker).info.stages.map((stage) => stage.commands)).toEqual([[{ kind: 'install', tool: 'npm', line: 2 }], []]);
  });

  it('starts one at a whole word, also with a file descriptor or a quoted delimiter, and reads scripts fed to a shell', () => {
    const result = readDockerStages('Dockerfile', ['FROM node:22', 'RUN 0<<"EOF" bash -e', 'npm ci', 'EOF', 'RUN <<A cat > a && <<B sh', 'npm install', 'A', 'pnpm install', 'B'].join('\n'), facts.docker);
    expect(result.info.stages[0]?.commands).toEqual([
      { kind: 'install', tool: 'npm', line: 3 },
      { kind: 'install', tool: 'pnpm', line: 8 },
    ]);
  });
});

describe('ARG substitution limits', () => {
  it('gives up on a value that grows past 4 KiB instead of crashing, and says why', () => {
    const lines = ['ARG A0=xxxxxxxxxxxxxxxx'];
    for (let index = 1; index <= 11; index++) lines.push(`ARG A${index}=${`$A${index - 1}`.repeat(16)}`);
    lines.push('FROM node:$A11', 'RUN npm ci');
    const text = lines.join('\n');
    expect(text.length).toBeLessThan(1024);
    const result = readDockerStages('Dockerfile', text, facts.docker);
    expect(result.info.stages[0]?.runtime).toEqual({ tool: 'node', unknown: 'the ARG A3 is longer than 4096 characters after ARG substitution, which depcurfew does not read' });
  });

  it('gives up on a value with more than 256 substitutions', () => {
    const result = readDockerStages('Dockerfile', ['ARG E=', `FROM node:22${'$E'.repeat(300)}`].join('\n'), facts.docker);
    expect(result.info.stages[0]?.runtime).toEqual({ tool: 'node', unknown: 'the image reference uses more than 256 ARG substitutions, which depcurfew does not read' });
  });
});

describe('workflows', () => {
  it('lists each matrix value once, leaves out simple excludes, and notes a matrix too large to check', () => {
    const workflow = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        node: [22, 24, 22, 20]',
      '        os: [ubuntu-latest]',
      '        include:',
      '          - node: 24',
      '          - node: 26',
      '        exclude:',
      '          - node: 20',
      '          - node: 24',
      '            os: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      '      - run: npm ci',
      '  big:',
      '    strategy:',
      '      matrix:',
      `        node: [${Array.from({ length: 300 }, (_, index) => index).join(', ')}]`,
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      '      - run: npm ci',
    ].join('\n');
    const detection = detectProject(repository({ 'package.json': '{}', 'package-lock.json': '{}', '.github/workflows/ci.yml': workflow }));
    expect(detection.node.versions.map((entry) => ('version' in entry ? [entry.job, entry.version, entry.line, entry.unknown] : []))).toEqual([
      ['test', '22', 5, undefined],
      ['test', '24', 5, undefined],
      ['test', '26', 9, undefined],
      ['big', '${{ matrix.node }}', 26, 'the matrix lists more than 256 values for node, which depcurfew does not check'],
    ]);
  });

  it('records the working directory of each install: the step, the job default, the workflow default', () => {
    const workflow = [
      'defaults:',
      '  run:',
      '    working-directory: ./web/',
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: npm ci',
      '      - run: npm ci',
      '        working-directory: .',
      '  b:',
      '    defaults:',
      '      run:',
      '        working-directory: frontend',
      '    steps:',
      '      - run: npm ci',
      '      - run: yarn',
      '        working-directory: frontend/app',
    ].join('\n');
    const detection = detectProject(repository({ '.github/workflows/ci.yml': workflow }));
    expect(detection.jobs.map((job) => job.commands)).toEqual([
      [
        { kind: 'install', tool: 'npm', line: 7, directory: 'web' },
        { kind: 'install', tool: 'npm', line: 8 },
      ],
      [
        { kind: 'install', tool: 'npm', line: 15, directory: 'frontend' },
        { kind: 'install', tool: 'yarn', line: 16, directory: 'frontend/app' },
      ],
    ]);
  });
});

describe('linear time on pathological input', () => {
  // Each input is about 1 MiB; each took seconds to minutes before (pentest of 1.3.0). The budget is generous for slow CI.
  const huge = (unit: string) => unit.repeat(Math.floor(MIB / unit.length));
  const dockerfiles: [string, string][] = [
    ['a word of digits', `FROM python:3.12\nRUN ${huge('1')}`],
    ['grouped shell options', `FROM node:22\nRUN sh ${huge('-cccc ')}x`],
    ['here-document markers', `FROM node:22\nRUN ${huge('<<A ')}\nA\nRUN npm ci`],
    ['45 000 stages', `FROM node:22 AS s0\n${Array.from({ length: 45_000 }, (_, index) => `FROM s${index} AS s${index + 1}\nRUN npm ci`).join('\n')}`],
    ['many continuation lines with installs', `FROM node:22\nRUN ${huge('npm ci \\\n')}true`],
  ];

  it.each(dockerfiles)('reads a Dockerfile with %s in linear time', (_name, text) => {
    const start = performance.now();
    const result = readDockerStages('Dockerfile', text, facts.docker);
    expect(result.info.stages.length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it('reads a workflow run step of 1 MiB of digits in linear time', () => {
    const run = '1'.repeat(MIB - 1024);
    const directory = repository({ '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - run: ${run}\n` });
    const start = performance.now();
    expect(detectProject(directory).jobs).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
