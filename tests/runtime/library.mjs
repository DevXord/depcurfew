// The library on the Node.js that runs this file, without network (E02): CI runs it on the same old Node.js versions as
// tests/runtime/smoke.mjs (decision D-103), down to the lowest that engines in package.json allows, and
// tests/runtime/library.test.ts on the current one. It imports dist/index.js and calls what agentcurfew calls offline:
// getVersion, loadPolicy, checkSpecs with a fetch that refuses every request and PopularNames, then defaultPopularNames
// and LocalOsvData. Plain JavaScript and only APIs Node.js 18.3.0 has. Usage: node tests/runtime/library.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];

function step(name, problems) {
  if (problems.length === 0) {
    console.log(`ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`FAIL ${name}`);
  for (const problem of problems) console.log(`     ${problem}`);
}

async function main() {
  const library = await import('../../dist/index.js');
  const scratch = mkdtempSync(join(tmpdir(), 'depcurfew-library-'));
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    step('getVersion', library.getVersion() === pkg.version ? [] : [`getVersion() is ${library.getVersion()}, package.json has ${pkg.version}`]);

    writeFileSync(join(scratch, 'depcurfew.json'), library.renderPolicy(library.DEFAULT_POLICY));
    const policy = library.loadPolicy(scratch);
    step('loadPolicy', typeof policy === 'object' && policy !== null && 'cooldown' in policy ? [] : [`loadPolicy gave ${JSON.stringify(policy).slice(0, 200)}`]);

    let requests = 0;
    const refuse = async () => {
      requests += 1;
      throw new Error('no network');
    };
    const now = new Date('2026-11-12T00:00:00Z');
    const registry = 'https://registry.npmjs.org/';
    const wanted = [
      ['left-pad@1.3.0', 'registry', 'error:unverified'],
      ['git+https://github.com/a/b', 'git', 'error:forbidden-source'],
      ['pypi:requests==2.32.3', 'registry', 'error:unverified'],
      ['nuget:Newtonsoft.Json', 'other', 'error:unverified'],
      ['cargo:serde', 'other', 'error:unverified'],
      ['Foo Bar', 'invalid', 'error:invalid-spec'],
    ];
    const reports = await library.checkSpecs(wanted.map(([spec]) => spec), { policy, fetch: refuse, now, registry, popular: new library.PopularNames([]) });
    const problems = [];
    wanted.forEach(([spec, kind, finding], index) => {
      const report = reports[index];
      const findings = (report?.findings ?? []).map((item) => `${item.level}:${item.code}`).join(',');
      if (report?.spec !== spec || report.kind !== kind || findings !== finding) problems.push(`${spec}: kind ${report?.kind}, findings ${findings}; expected ${kind}, ${finding}`);
    });
    if (requests !== 2) problems.push(`checkSpecs tried ${requests} requests, expected 2 (left-pad and requests)`);
    step('checkSpecs offline', problems);

    const [lookAlike] = await library.checkSpecs(['lodahs'], { ...library.defaultPopularNames(), policy, fetch: refuse, now, registry });
    const codes = (lookAlike?.findings ?? []).map((item) => item.code).join(',');
    step('checkSpecs with defaultPopularNames', codes === 'similar-name,unverified' ? [] : [`lodahs gave ${codes}`]);

    const local = new library.LocalOsvData(join(scratch, 'osv'));
    const states = ['npm', 'crates', '../npm'].map((ecosystem) => local.state(ecosystem).status);
    step('LocalOsvData', states.every((status) => status === 'missing') && local.lookup({ ecosystem: 'crates', name: 'serde', version: '1.0.0' }) === undefined ? [] : [`states ${states.join(', ')}`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? `Node.js ${process.versions.node}: every step passed` : `Node.js ${process.versions.node}: ${failures.length} failed`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`FAIL the library test itself: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
