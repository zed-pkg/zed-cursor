import path from 'node:path';
import * as vscode from 'vscode';
import { analyzeWorkspace } from './analyzer';
import type { PackageIssue, WorkspaceReport } from './types';

export class PackageState implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WorkspaceReport>();
  private report: WorkspaceReport = emptyReport();
  private running: Promise<WorkspaceReport> | undefined;
  private queued = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel
  ) {}

  public current(): WorkspaceReport {
    return this.report;
  }

  public async refresh(): Promise<WorkspaceReport> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }

    this.running = this.performRefresh();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async performRefresh(): Promise<WorkspaceReport> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder) => folder.uri.fsPath);
    const configuration = vscode.workspace.getConfiguration('zedCursor');
    const exclude = configuration.get<string>(
      'scanExclude',
      '**/{node_modules,target,.git,.zed,.zed-pack,.vendor}/**'
    );
    const maxManifests = configuration.get<number>('maxManifests', 250);
    const manifestUris: vscode.Uri[] = [];

    for (const folder of folders) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/.zpkg.toml'),
        exclude,
        maxManifests + 1
      );
      manifestUris.push(...found);
      if (manifestUris.length > maxManifests) {
        break;
      }
    }

    const uniqueManifests = [...new Set(manifestUris.map((uri) => path.normalize(uri.fsPath)))].sort();
    this.output.appendLine(`Refreshing Zed package state for ${uniqueManifests.length} manifest(s).`);

    const analyzerPath = configuration.get<string>('analyzerPath', '').trim();
    const report = await analyzeWorkspace({
      extensionPath: this.context.extensionPath,
      workspaceRoots: roots,
      manifestPaths: uniqueManifests,
      ...(analyzerPath ? { analyzerPath } : {}),
      preferRustAnalyzer: configuration.get<boolean>('preferRustAnalyzer', true),
      maxManifests,
      log: (message) => this.output.appendLine(message)
    });

    this.report = report;
    this.publishDiagnostics(report.issues);
    await vscode.commands.executeCommand('setContext', 'zedCursor.hasPackages', report.packages.length > 0);
    this.changeEmitter.fire(report);
    return report;
  }

  private publishDiagnostics(issues: readonly PackageIssue[]): void {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const issue of issues) {
      if (!path.isAbsolute(issue.file)) {
        continue;
      }
      const line = Math.max(0, issue.line - 1);
      const column = Math.max(0, issue.column);
      const range = new vscode.Range(line, column, line, column + Math.max(1, issue.length ?? 1));
      const diagnostic = new vscode.Diagnostic(range, issue.message, toDiagnosticSeverity(issue.severity));
      diagnostic.source = 'zed-cursor';
      diagnostic.code = issue.code;
      const existing = byFile.get(issue.file) ?? [];
      existing.push(diagnostic);
      byFile.set(issue.file, existing);
    }

    for (const [file, entries] of byFile) {
      this.diagnostics.set(vscode.Uri.file(file), entries);
    }
  }
}

function toDiagnosticSeverity(severity: PackageIssue['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
  }
}

function emptyReport(): WorkspaceReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    workspaceRoots: [],
    packages: [],
    issues: [],
    counts: { packages: 0, dependencies: 0, errors: 0, warnings: 0, infos: 0 },
    analyzer: 'typescript'
  };
}
