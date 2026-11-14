import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { validateAnalyzerReport } from '../.tmp-test/core/reportAdmission.js';

const root = path.resolve('workspace');
const pkgRoot = path.join(root, 'nested');
function validReport() {
  const issue = { code: 'lock.stale', severity: 'warning', message: 'Review lock', file: path.join(pkgRoot, '.zpkg.lock'), line: 1, column: 0, recommendations: [] };
  return { schemaVersion: 1, generatedAt: '', workspaceRoots: [root], analyzer: 'rust',
    packages: [{root: pkgRoot, manifestPath: path.join(pkgRoot, '.zpkg.toml'), lockPath: path.join(pkgRoot, '.zpkg.lock'), identity: {}, dependencies: [], issues: [issue]}],
    issues: [issue], counts: {packages: 1, dependencies: 0, errors: 0, warnings: 1, infos: 0} };
}

test('admits a nested workspace report and normalized root aliases', () => {
  const report = validReport();
  report.workspaceRoots = [path.join(root, 'nested', '..')];
  assert.equal(validateAnalyzerReport(report, root), report);
});

test('rejects forged, relative, and sibling-prefix workspace roots', () => {
  for (const forged of [path.resolve('other'), 'workspace', root + '-external']) {
    const report = validReport();
    report.workspaceRoots = [forged];
    assert.throws(() => validateAnalyzerReport(report, root), /foreign workspace/);
  }
});

test('rejects foreign package, manifest, and lock paths', () => {
  for (const change of [
    report => { report.packages[0].root = root + '-external'; },
    report => { report.packages[0].manifestPath = path.join(root, 'other', '.zpkg.toml'); },
    report => { report.packages[0].lockPath = path.resolve('outside', '.zpkg.lock'); },
    report => { report.packages[0].root = 'relative'; },
  ]) {
    const report = validReport();
    change(report);
    assert.throws(() => validateAnalyzerReport(report, root), /invalid package/);
  }
});

test('rejects diagnostics outside workspace in both report layers', () => {
  for (const layer of ['issues', 'packages']) {
    const report = validReport();
    const issue = layer === 'issues' ? report.issues[0] : report.packages[0].issues[0];
    issue.file = path.join(root, '..', 'outside-secret');
    assert.throws(() => validateAnalyzerReport(report, root), /outside/);
  }
});

test('rejects malformed subprocess response', () => {
  for (const malformed of [null, [], {}, { ...validReport(), packages: 'invalid' }]) {
    assert.throws(() => validateAnalyzerReport(malformed, root));
  }
});
