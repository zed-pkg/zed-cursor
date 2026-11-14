import * as path from 'node:path';
import type { WorkspaceReport } from '../types';

/** Admit a Rust analyzer result only for the exact workspace we requested. */
export function validateAnalyzerReport(value: unknown, requestedRoot: string): WorkspaceReport {
  if (!record(value) || value.schemaVersion !== 1 || value.analyzer !== 'rust' ||
      !Array.isArray(value.workspaceRoots) || value.workspaceRoots.length !== 1 ||
      !samePath(value.workspaceRoots[0], requestedRoot) ||
      !Array.isArray(value.packages) || !Array.isArray(value.issues) ||
      !record(value.counts)) {
    throw new Error('Rust analyzer returned an unsupported or foreign workspace report.');
  }

  for (const pkg of value.packages) {
    if (!record(pkg) || !within(requestedRoot, pkg.root) ||
        !samePath(pkg.manifestPath, path.join(pkg.root as string, '.zpkg.toml')) ||
        (pkg.lockPath !== undefined && !samePath(pkg.lockPath, path.join(pkg.root as string, '.zpkg.lock'))) ||
        !Array.isArray(pkg.issues) || !Array.isArray(pkg.dependencies)) {
      throw new Error('Rust analyzer returned an invalid package path or shape.');
    }
    for (const issue of pkg.issues) {
      if (!record(issue) || !within(requestedRoot, issue.file)) {
        throw new Error('Rust analyzer returned an issue outside the requested workspace.');
      }
    }
  }
  for (const issue of value.issues) {
    if (!record(issue) || !within(requestedRoot, issue.file)) {
      throw new Error('Rust analyzer returned a workspace issue outside the requested root.');
    }
  }
  return value as unknown as WorkspaceReport;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function samePath(candidate: unknown, expected: string): boolean {
  return typeof candidate === 'string' && path.isAbsolute(candidate) &&
    path.resolve(candidate) === path.resolve(expected);
}

function within(root: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
