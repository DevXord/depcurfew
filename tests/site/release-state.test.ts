// The site is built from the main branch (decision D-178): readReleaseState tells from the release tags whether the
// commit being built is the release of its version, and every page of the current version says so in a banner when it
// is not, with links to the documentation of the latest release that resolve. The repository is a temporary one with
// its own tags, so the test needs no network and no tags of this repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite, SITE_PAGES } from '../../scripts/site/build.ts';
import { readReleaseState, type ArchivedVersion, type ReleaseState } from '../../scripts/site/versions.ts';
import { checkLinks, files, readPage } from './pages.ts';

const ROOT = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { version: string };
const current = manifest.version;
const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number);
// A version before the current one, as the latest release while the current one is not released yet.
const previous = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${Math.max(minor - 1, 0)}.0`;

const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('readReleaseState', () => {
  let repository = '';
  // Git without the configuration of the machine, so that signing or hooks of the user never run.
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repository, env: environment, stdio: 'ignore' });
  const commit = (message: string) => {
    writeFileSync(join(repository, 'file.txt'), `${message}\n`);
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
  };

  beforeAll(() => {
    repository = temporary('depcurfew-release-state-');
    const config = join(repository, '..', `${repository.split(/[\\/]/u).at(-1) ?? 'repo'}.gitconfig`);
    writeFileSync(config, '');
    directories.push(config);
    Object.assign(environment, { GIT_CONFIG_GLOBAL: config });
    git('init', '--quiet');
  });

  it('gives nothing without a release tag or outside a git repository', () => {
    commit('first');
    expect(readReleaseState(repository, '1.0.0')).toBeUndefined();
    git('tag', 'nightly');
    git('tag', 'v1.0.0-rc.1');
    expect(readReleaseState(repository, '1.0.0')).toBeUndefined();
    expect(readReleaseState(temporary('depcurfew-not-git-'), '1.0.0')).toBeUndefined();
  });

  it('says that the commit is the release when the tag of its version points at it, lightweight or annotated', () => {
    git('tag', 'v1.0.0');
    expect(readReleaseState(repository, '1.0.0')).toEqual({ latest: '1.0.0', released: true });
    commit('second');
    git('tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
    expect(readReleaseState(repository, '1.1.0')).toEqual({ latest: '1.1.0', released: true });
  });

  it('says that it is not the release after a commit past the tag, or for a version without a tag', () => {
    commit('third');
    expect(readReleaseState(repository, '1.1.0')).toEqual({ latest: '1.1.0', released: false });
    expect(readReleaseState(repository, '1.2.0')).toEqual({ latest: '1.1.0', released: false });
  });

  it('takes the highest release tag as the latest release, never a pre-release or another tag', () => {
    git('tag', 'v1.10.0-rc.1');
    git('tag', 'v1.9.0');
    git('tag', 'v2.0');
    expect(readReleaseState(repository, '1.9.0')).toEqual({ latest: '1.9.0', released: true });
    expect(readReleaseState(repository, '1.10.0')).toEqual({ latest: '1.9.0', released: false });
  });
});

describe('the banner of the current pages (D-178)', () => {
  const archived: ArchivedVersion = { version: previous, tag: `v${previous}`, readme: '# depcurfew\n\nThe documentation of the previous release.\n' };
  const build = (release: ReleaseState | undefined, versions: readonly ArchivedVersion[] = []) => {
    const directory = temporary('depcurfew-site-banner-');
    buildSite(directory, ROOT, { versions, ...(release === undefined ? {} : { release }) });
    return directory;
  };
  const banner = (directory: string, name: string) => /<p class="banner">(.*?)<\/p>/u.exec(readPage(directory, name))?.[1];

  it('has no banner without a release state or when the commit is the release of its version', () => {
    for (const directory of [build(undefined), build({ latest: current, released: true })]) {
      for (const page of SITE_PAGES) expect(banner(directory, page.file), page.file).toBeUndefined();
    }
  });

  it('says that the pages may describe changes after the release of the same version, with its release notes', () => {
    const directory = build({ latest: current, released: false });
    for (const page of SITE_PAGES) {
      expect(banner(directory, page.file), page.file).toBe(
        `This documentation is built from the main branch and may describe changes made after depcurfew ${current}, the latest release on npm; they come with the next release · <a href="https://github.com/DevXord/depcurfew/releases/tag/v${current}">release notes of ${current}</a>`,
      );
    }
  });

  it('names a version that is not released yet and links to the documentation of the latest release, whose links resolve', () => {
    const directory = build({ latest: previous, released: false }, [archived]);
    const all = files(directory);
    for (const page of SITE_PAGES) {
      expect(banner(directory, page.file), page.file).toBe(
        `This documentation is of depcurfew ${current} from the main branch, which is not released yet. The latest release on npm is ${previous}: <a href="${previous}/index.html">its documentation</a> · <a href="versions.html">all versions</a>`,
      );
      checkLinks(directory, page.file, all);
    }
    // The earlier version keeps its own banner, and the 404 page links from the root.
    expect(banner(directory, `${previous}/index.html`)).toContain(`This page documents depcurfew ${previous}, an earlier version.`);
    expect(banner(directory, '404.html')).toContain(`<a href="/${previous}/index.html">its documentation</a> · <a href="/versions.html">all versions</a>`);
  });

  it('links to the page of the latest release on npm when the site has no documentation of it', () => {
    const directory = build({ latest: previous, released: false });
    expect(banner(directory, 'index.html')).toBe(
      `This documentation is of depcurfew ${current} from the main branch, which is not released yet. The latest release on npm is ${previous}: <a href="https://www.npmjs.com/package/depcurfew/v/${previous}">its page on npm</a>`,
    );
  });
});
