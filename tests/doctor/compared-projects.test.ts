// doctor without depcurfew.json compares at most MAX_COMPARED_PROJECTS of the projects depcurfew init would list with
// the default policy (decision D-157), the first ones in the order init writes them; the notice projects-not-compared
// names the others, after policy-missing, in text, JSON and SARIF. depcurfew init still lists every project, and a
// depcurfew.json that lists more projects is checked in full.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { comparedPolicy, initialPolicy, MAX_COMPARED_PROJECTS } from '../../src/cli/init-policy.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import type { DoctorReport } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A repository without a root manifest and `count` projects p01, p02 … with a package.json each. */
function projects(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-compared-projects-'));
  temporary.push(root);
  for (let index = 1; index <= count; index++) {
    const name = `p${String(index).padStart(2, '0')}`;
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'package.json'), `{"name": "${name}", "version": "1.0.0"}\n`);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} });
  return { code, stdout };
}

const names = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `p${String(index + from).padStart(2, '0')}`);

describe('the projects doctor compares with the default policy (decision D-157)', () => {
  it('are at most 20', () => {
    expect(MAX_COMPARED_PROJECTS).toBe(20);
  });

  it('are the first ones init lists; the others are named, and init still lists them all', () => {
    const root = projects(MAX_COMPARED_PROJECTS + 7);
    const compared = comparedPolicy(root);
    expect(compared.policy.projects).toEqual(names(MAX_COMPARED_PROJECTS));
    expect(compared.notCompared).toEqual(names(7, MAX_COMPARED_PROJECTS + 1));
    const all = initialPolicy(root);
    expect(all.projects.map((entry) => entry.project)).toEqual(names(MAX_COMPARED_PROJECTS + 7));
    expect(all.notCompared).toEqual([]);
  });

  it('all of them, without the notice, when there are no more than 20', async () => {
    const root = projects(MAX_COMPARED_PROJECTS);
    expect(comparedPolicy(root).notCompared).toEqual([]);
    const report = JSON.parse((await exec('doctor', '--json', root)).stdout) as DoctorReport;
    expect(report.notices.map((notice) => notice.code)).not.toContain('projects-not-compared');
    expect(report.findings.filter((finding) => finding.rule === 'config-drift')).toHaveLength(MAX_COMPARED_PROJECTS);
  });

  it('says what it left out after policy-missing, in JSON, text and SARIF, and never fails doctor for it', async () => {
    const root = projects(MAX_COMPARED_PROJECTS + 7);
    const message =
      'depcurfew init would list 27 directories under projects; doctor compared the first 20 with the default policy of depcurfew init and did not check the other 7: "p21", "p22", "p23", "p24", "p25" and 2 more';
    const fix = 'Run depcurfew init to write depcurfew.json with every project, then run depcurfew doctor again to check them all';
    const result = await exec('doctor', '--json', root);
    expect(result.code).toBe(EXIT_OK);
    const report = JSON.parse(result.stdout) as DoctorReport;
    const codes = report.notices.map((notice) => notice.code);
    expect(codes.indexOf('projects-not-compared')).toBe(codes.indexOf('policy-missing') + 1);
    expect(report.notices.find((notice) => notice.code === 'projects-not-compared')).toEqual({ level: 'note', code: 'projects-not-compared', message, fix });
    expect(report.notices.find((notice) => notice.code === 'policy-missing')?.message).toContain(`(with projects ${names(19).map((name) => `"${name}"`).join(', ')} and "p20")`);
    // Only the compared projects are checked: one config-drift note for the .npmrc of each.
    const drift = report.findings.filter((finding) => finding.rule === 'config-drift').map((finding) => finding.location.file);
    expect(drift).toEqual(names(MAX_COMPARED_PROJECTS).map((name) => `${name}/.npmrc`));

    const text = (await exec('doctor', root)).stdout;
    expect(text).toContain(`  note ${message} (projects-not-compared)\n    fix: ${fix}\n`);

    const sarif = JSON.parse((await exec('doctor', '--sarif', root)).stdout) as { runs: { invocations: { toolExecutionNotifications: { message: { text: string } }[] }[] }[] };
    const notifications = sarif.runs[0]?.invocations[0]?.toolExecutionNotifications.map((notification) => notification.message.text) ?? [];
    expect(notifications.some((text) => text.includes(message))).toBe(true);
  });

  it('names every left-out project when there are no more than 5', async () => {
    const root = projects(MAX_COMPARED_PROJECTS + 2);
    const report = JSON.parse((await exec('doctor', '--json', root)).stdout) as DoctorReport;
    expect(report.notices.find((notice) => notice.code === 'projects-not-compared')?.message).toMatch(/did not check the other 2: "p21" and "p22"$/u);
  });

  it('does not limit the projects of a depcurfew.json', async () => {
    const root = projects(MAX_COMPARED_PROJECTS + 2);
    writeFileSync(join(root, 'depcurfew.json'), `${JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, projects: names(MAX_COMPARED_PROJECTS + 2) })}\n`);
    const report = JSON.parse((await exec('doctor', '--json', root)).stdout) as DoctorReport;
    expect(report.notices.map((notice) => notice.code)).not.toContain('projects-not-compared');
    expect(report.checked?.tools.map((tool) => tool.project)).toEqual(names(MAX_COMPARED_PROJECTS + 2));
  });
});
