import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseManifest } from './core/manifest';
import type {
  PackageIssue,
  PackageReport,
  Recommendation,
  ReportCounts,
  WorkspaceReport
} from './types';

const execFileAsync = promisify(execFile);

export interface AnalyzerOptions {
  readonly extensionPath: string;
  readonly workspaceRoots: readonly string[];
  readonly manifestPaths: readonly string[];
  readonly analyzerPath?: string;
  readonly preferRustAnalyzer: boolean;
  readonly maxManifests: number;
  readonly log: (message: string) => void;
}

export async function analyzeWorkspace(options: AnalyzerOptions): Promise<WorkspaceReport> {
  if (options.preferRustAnalyzer) {
    const executable = await resolveAnalyzerExecutable(options.extensionPath, options.analyzerPath);
    if (executable) {
      try {
        const reports = await Promise.all(
          options.workspaceRoots.map((root) => runRustAnalyzer(executable, root, options.maxManifests))
        );
        const report = mergeReports(reports, options.workspaceRoots, 'rust');
        options.log(`Rust analyzer completed: ${report.counts.packages} package(s).`);
        return report;
      } catch (error) {
        options.log(`Rust analyzer unavailable or failed; using TypeScript fallback: ${asErrorMessage(error)}`);
      }
    }
  }

  const report = await analyzeWithTypeScript(options);
  options.log(`TypeScript analyzer completed: ${report.counts.packages} package(s).`);
  return report;
}

async function runRustAnalyzer(
  executable: string,
  root: string,
  maxManifests: number
): Promise<WorkspaceReport> {
  const { stdout, stderr } = await execFileAsync(
    executable,
    ['analyze', '--root', root, '--max-manifests', String(maxManifests), '--format', 'json'],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );
  if (stderr.trim().length > 0) {
    throw new Error(stderr.trim());
  }
  const parsed = JSON.parse(stdout) as WorkspaceReport;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.packages)) {
    throw new Error('The analyzer returned an unsupported report schema.');
  }
  return parsed;
}

async function analyzeWithTypeScript(options: AnalyzerOptions): Promise<WorkspaceReport> {
  const selectedManifests = options.manifestPaths.slice(0, options.maxManifests);
  const packages = await Promise.all(selectedManifests.map(analyzeManifest));
  const graphIssues = detectCycles(packages);
  const packagesWithGraphIssues = attachIssues(packages, graphIssues);
  const limitIssues: PackageIssue[] = [];

  if (options.manifestPaths.length > selectedManifests.length) {
    const file = options.workspaceRoots[0] ?? process.cwd();
    limitIssues.push({
      code: 'workspace.limit',
      severity: 'warning',
      message: `Analysis stopped after ${selectedManifests.length} manifests. Increase zedCursor.maxManifests to scan the remaining ${options.manifestPaths.length - selectedManifests.length}.`,
      file,
      line: 1,
      column: 0,
      recommendations: [{ title: 'Open Zed Package Insights settings', kind: 'edit' }]
    });
  }

  const packageIssues = packagesWithGraphIssues.flatMap((entry) => entry.issues);
  const issues = [...packageIssues, ...limitIssues];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoots: options.workspaceRoots,
    packages: packagesWithGraphIssues,
    issues,
    counts: countReport(packagesWithGraphIssues, issues),
    analyzer: 'typescript'
  };
}

async function analyzeManifest(manifestPath: string): Promise<PackageReport> {
  const root = path.dirname(manifestPath);
  const lockPath = path.join(root, '.zpkg.lock');
  let text: string;

  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    const issue: PackageIssue = {
      code: 'manifest.parse',
      severity: 'error',
      message: `Could not read the package manifest: ${asErrorMessage(error)}`,
      file: manifestPath,
      line: 1,
      column: 0,
      recommendations: [{ title: 'Open package manifest', kind: 'open-manifest' }]
    };
    return { root, manifestPath, identity: {}, dependencies: [], issues: [issue] };
  }

  const parsed = parseManifest(text, manifestPath);
  const issues: PackageIssue[] = [...parsed.issues];
  let hasLock = false;

  try {
    const [manifestStats, lockStats, lockText] = await Promise.all([
      stat(manifestPath),
      stat(lockPath),
      readFile(lockPath, 'utf8')
    ]);
    hasLock = true;
    if (lockText.trim().length === 0) {
      issues.push(lockIssue(
        'lock.empty',
        'error',
        'The Zed lockfile is empty.',
        lockPath,
        [{ title: 'Regenerate lockfile with zed install', kind: 'install', command: ['install'] }]
      ));
    } else if (manifestStats.mtimeMs > lockStats.mtimeMs + 1_000) {
      issues.push(lockIssue(
        'lock.stale',
        'warning',
        'The package manifest is newer than the lockfile; dependencies may not be synchronized.',
        lockPath,
        [
          { title: 'Update dependencies with zed install', kind: 'install', command: ['install'] },
          { title: 'Verify frozen install', kind: 'install-frozen', command: ['install', '--frozen'] }
        ]
      ));
    }
  } catch {
    issues.push(lockIssue(
      'lock.missing',
      'warning',
      'No .zpkg.lock file was found next to this package manifest.',
      manifestPath,
      [{ title: 'Create lockfile with zed install', kind: 'install', command: ['install'] }]
    ));
  }

  for (const dependency of parsed.dependencies) {
    if (!dependency.path) {
      continue;
    }
    const dependencyPath = path.resolve(root, dependency.path);
    try {
      await access(dependencyPath);
    } catch {
      issues.push({
        code: 'dependency.path-missing',
        severity: 'error',
        message: `Local dependency “${dependency.name}” points to missing path ${dependency.path}.`,
        file: manifestPath,
        line: dependency.line,
        column: 0,
        recommendations: [
          { title: 'Open package manifest', kind: 'open-manifest' },
          { title: 'Install dependencies', kind: 'install', command: ['install'] }
        ]
      });
    }
  }

  return {
    root,
    manifestPath,
    ...(hasLock ? { lockPath } : {}),
    identity: parsed.identity,
    dependencies: parsed.dependencies,
    issues
  };
}

function detectCycles(packages: readonly PackageReport[]): PackageIssue[] {
  const byCanonicalName = new Map<string, PackageReport>();
  for (const packageReport of packages) {
    const canonical = canonicalName(packageReport);
    if (canonical) {
      byCanonicalName.set(canonical, packageReport);
    }
  }

  const graph = new Map<string, string[]>();
  for (const [canonical, packageReport] of byCanonicalName) {
    graph.set(
      canonical,
      packageReport.dependencies
        .map((dependency) => dependency.name)
        .filter((dependencyName) => byCanonicalName.has(dependencyName))
    );
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const issues: PackageIssue[] = [];

  const visit = (node: string): void => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = normalizeCycle(cycle);
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        const packageReport = byCanonicalName.get(node);
        if (packageReport) {
          issues.push({
            code: 'dependency.cycle',
            severity: 'error',
            message: `Workspace dependency cycle detected: ${cycle.join(' → ')}.`,
            file: packageReport.manifestPath,
            line: 1,
            column: 0,
            recommendations: [
              { title: 'Open package manifest', kind: 'open-manifest' },
              { title: 'Review dependency direction', kind: 'edit' }
            ]
          });
        }
      }
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const neighbor of graph.get(node) ?? []) {
      visit(neighbor);
    }
    stack.pop();
    active.delete(node);
  };

  for (const node of graph.keys()) {
    visit(node);
  }
  return issues;
}

function attachIssues(
  packages: readonly PackageReport[],
  graphIssues: readonly PackageIssue[]
): PackageReport[] {
  const byFile = new Map<string, PackageIssue[]>();
  for (const issue of graphIssues) {
    const entries = byFile.get(issue.file) ?? [];
    entries.push(issue);
    byFile.set(issue.file, entries);
  }
  return packages.map((entry) => ({
    ...entry,
    issues: [...entry.issues, ...(byFile.get(entry.manifestPath) ?? [])]
  }));
}

function mergeReports(
  reports: readonly WorkspaceReport[],
  roots: readonly string[],
  analyzer: WorkspaceReport['analyzer']
): WorkspaceReport {
  const packages = reports.flatMap((entry) => entry.packages);
  const existingIssues = reports.flatMap((entry) => entry.issues);
  const existingKeys = new Set(existingIssues.map(issueKey));
  const crossRootIssues = detectCycles(packages).filter((issue) => !existingKeys.has(issueKey(issue)));
  const packagesWithCrossRootIssues = attachIssues(packages, crossRootIssues);
  const issues = [...existingIssues, ...crossRootIssues];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoots: roots,
    packages: packagesWithCrossRootIssues,
    issues,
    counts: countReport(packagesWithCrossRootIssues, issues),
    analyzer
  };
}

function countReport(packages: readonly PackageReport[], issues: readonly PackageIssue[]): ReportCounts {
  return {
    packages: packages.length,
    dependencies: packages.reduce((total, entry) => total + entry.dependencies.length, 0),
    errors: issues.filter((entry) => entry.severity === 'error').length,
    warnings: issues.filter((entry) => entry.severity === 'warning').length,
    infos: issues.filter((entry) => entry.severity === 'info').length
  };
}

async function resolveAnalyzerExecutable(
  extensionPath: string,
  configuredPath: string | undefined
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (configuredPath && configuredPath.trim().length > 0) {
    candidates.push(configuredPath.trim());
  }

  const platform = process.platform;
  const architecture = normalizeArchitecture(process.arch);
  const executableName = platform === 'win32' ? 'zed-cursor-analyzer.exe' : 'zed-cursor-analyzer';
  candidates.push(path.join(extensionPath, 'bin', `${platform}-${architecture}`, executableName));
  candidates.push(path.join(extensionPath, 'analyzer', 'target', 'release', executableName));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported location.
    }
  }
  return undefined;
}

function normalizeArchitecture(architecture: string): string {
  switch (architecture) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    default:
      return architecture;
  }
}

function canonicalName(packageReport: PackageReport): string | undefined {
  const { org, name } = packageReport.identity;
  return org && name ? `${org}/${name}` : undefined;
}

function normalizeCycle(cycle: readonly string[]): string {
  const body = cycle.slice(0, -1);
  if (body.length === 0) {
    return '';
  }
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)].join('|'));
  return rotations.sort()[0] ?? body.join('|');
}

function lockIssue(
  code: 'lock.missing' | 'lock.empty' | 'lock.stale',
  severity: PackageIssue['severity'],
  message: string,
  file: string,
  recommendations: readonly Recommendation[]
): PackageIssue {
  return { code, severity, message, file, line: 1, column: 0, recommendations };
}

function issueKey(issue: PackageIssue): string {
  return `${issue.code}:${path.normalize(issue.file)}:${issue.message}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
