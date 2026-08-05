import path from 'node:path';
import * as vscode from 'vscode';
import { ZedCodeActionProvider } from './codeActions';
import { ZedCliRunner } from './cli';
import { DashboardPanel } from './dashboard';
import { PackageState } from './state';
import { PackageTreeProvider } from './tree';
import type { PackageIssue, PackageReport, WorkspaceReport } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Zed Package Insights', { log: true });
  const diagnostics = vscode.languages.createDiagnosticCollection('zed-cursor');
  const state = new PackageState(context, diagnostics, output);
  const tree = new PackageTreeProvider(state.current());
  const dashboard = new DashboardPanel(context.extensionUri, state.current());
  const cli = new ZedCliRunner(output);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'zedCursor.showDashboard';
  status.name = 'Zed package health';
  status.show();

  const treeView = vscode.window.createTreeView('zedCursor.packagesView', {
    treeDataProvider: tree,
    showCollapseAll: true
  });

  const updateUi = (report: WorkspaceReport): void => {
    tree.update(report);
    dashboard.update(report);
    updateStatus(status, report);
  };
  context.subscriptions.push(state.onDidChange(updateUi));

  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register('zedCursor.refresh', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Analyzing Zed packages…' },
      () => state.refresh()
    );
  });
  register('zedCursor.showDashboard', async (root?: unknown) => {
    if (state.current().packages.length === 0) {
      await state.refresh();
    }
    dashboard.show(asRoot(root));
  });
  register('zedCursor.init', async (root?: unknown) => {
    await cli.run(['init'], resolveRoot(state.current(), asRoot(root)), {
      mutating: true,
      title: 'Initialize Zed package'
    });
  });
  register('zedCursor.openManifest', async (root?: unknown) => openManifest(state.current(), asRoot(root)));
  register('zedCursor.openIssue', async (issue?: unknown) => openIssue(issue));
  register('zedCursor.install', async (root?: unknown) => {
    await cli.run(['install'], resolveRoot(state.current(), asRoot(root)), {
      mutating: true,
      title: 'Install Zed dependencies'
    });
  });
  register('zedCursor.installFrozen', async (root?: unknown) => {
    await cli.run(['install', '--frozen'], resolveRoot(state.current(), asRoot(root)), {
      mutating: true,
      title: 'Install frozen Zed dependencies'
    });
  });
  register('zedCursor.build', async (root?: unknown) => {
    await cli.run(['build'], resolveRoot(state.current(), asRoot(root)), {
      mutating: true,
      title: 'Build Zed package'
    });
  });
  register('zedCursor.envVerify', async (root?: unknown) => {
    await cli.run(['env', 'verify'], resolveRoot(state.current(), asRoot(root)), {
      mutating: false,
      title: 'Verify Zed developer environment'
    });
  });
  register('zedCursor.selfUpdateCheck', async (root?: unknown) => {
    await cli.run(['self-update', '--check'], resolveRoot(state.current(), asRoot(root)), {
      mutating: false,
      title: 'Check Zed CLI update'
    });
  });
  register('zedCursor.copyResolutionPrompt', async (root?: unknown) => {
    const packageReport = resolvePackage(state.current(), asRoot(root));
    if (!packageReport) {
      await vscode.window.showInformationMessage('No Zed package is selected.');
      return;
    }
    await vscode.env.clipboard.writeText(resolutionPrompt(packageReport));
    await vscode.window.showInformationMessage('Copied a Zed package resolution prompt to the clipboard.');
  });

  const selector: vscode.DocumentSelector = [
    { scheme: 'file', pattern: '**/.zpkg.toml' },
    { scheme: 'file', pattern: '**/.zpkg.lock' }
  ];
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    selector,
    new ZedCodeActionProvider(() => state.current().issues),
    ZedCodeActionProvider.metadata
  ));

  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    const delay = vscode.workspace.getConfiguration('zedCursor').get<number>('refreshDebounceMs', 350);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void state.refresh();
    }, delay);
  };

  const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/.zpkg.toml');
  const lockWatcher = vscode.workspace.createFileSystemWatcher('**/.zpkg.lock');
  for (const watcher of [manifestWatcher, lockWatcher]) {
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
  }
  context.subscriptions.push(
    manifestWatcher,
    lockWatcher,
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('zedCursor')) {
        scheduleRefresh();
      }
    }),
    treeView,
    status,
    dashboard,
    cli,
    state,
    diagnostics,
    output,
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) }
  );

  updateStatus(status, state.current());
  await state.refresh();
  void reportCliAvailability(cli, output);
}

export function deactivate(): void {
  // All extension resources are registered in the extension context.
}

async function reportCliAvailability(cli: ZedCliRunner, output: vscode.OutputChannel): Promise<void> {
  const availability = await cli.checkAvailability();
  if (availability.available) {
    output.appendLine(`Zed CLI detected${availability.version ? `: ${availability.version}` : '.'}`);
  } else {
    output.appendLine(`Zed CLI was not detected. Analysis remains available; command actions require the CLI. ${availability.error ?? ''}`);
  }
}

function updateStatus(status: vscode.StatusBarItem, report: WorkspaceReport): void {
  if (report.counts.packages === 0) {
    status.text = '$(package) Zed: no packages';
    status.tooltip = 'No .zpkg.toml manifests found in the current workspace.';
    return;
  }
  if (report.counts.errors > 0) {
    status.text = `$(error) Zed: ${report.counts.errors} error${report.counts.errors === 1 ? '' : 's'}`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (report.counts.warnings > 0) {
    status.text = `$(warning) Zed: ${report.counts.warnings} warning${report.counts.warnings === 1 ? '' : 's'}`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    status.text = `$(pass-filled) Zed: ${report.counts.packages} healthy`;
    status.backgroundColor = undefined;
  }
  status.tooltip = `${report.counts.packages} package(s), ${report.counts.dependencies} dependencies, analyzed with ${report.analyzer}.`;
}

async function openManifest(report: WorkspaceReport, root?: string): Promise<void> {
  const packageReport = resolvePackage(report, root);
  if (!packageReport) {
    await vscode.window.showInformationMessage('No Zed package manifest is available.');
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(packageReport.manifestPath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function openIssue(value: unknown): Promise<void> {
  if (!isPackageIssue(value) || !path.isAbsolute(value.file)) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(value.file));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(Math.max(0, value.line - 1), Math.max(0, value.column));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function resolveRoot(report: WorkspaceReport, requested?: string): string {
  return resolvePackage(report, requested)?.root
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? process.cwd();
}

function resolvePackage(report: WorkspaceReport, requested?: string): PackageReport | undefined {
  if (requested) {
    const normalized = path.normalize(requested);
    const direct = report.packages.find((entry) => path.normalize(entry.root) === normalized);
    if (direct) {
      return direct;
    }
  }

  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    const containing = report.packages
      .filter((entry) => isWithin(entry.root, activePath))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (containing) {
      return containing;
    }
  }
  return report.packages[0];
}

function resolutionPrompt(packageReport: PackageReport): string {
  const canonical = packageReport.identity.org && packageReport.identity.name
    ? `${packageReport.identity.org}/${packageReport.identity.name}`
    : packageReport.identity.name ?? path.basename(packageReport.root);
  const issues = packageReport.issues.length > 0
    ? packageReport.issues.map((entry, index) => `${index + 1}. [${entry.severity}] ${entry.code}: ${entry.message}`).join('\n')
    : 'No analyzer issues were found.';
  const dependencies = packageReport.dependencies.length > 0
    ? packageReport.dependencies.map((entry) => `- ${entry.name}: ${entry.requirement ?? entry.path ?? entry.git ?? 'unresolved'}`).join('\n')
    : '- none';

  return `Resolve the Zed package problems below semantically. Preserve intended dependency boundaries, do not blindly delete lockfile entries, and validate with a frozen install after applying fixes.\n\nPackage: ${canonical}\nRoot: ${packageReport.root}\nManifest: ${packageReport.manifestPath}\n\nIssues:\n${issues}\n\nDependencies:\n${dependencies}\n\nRecommended validation:\n1. zed install\n2. zed install --frozen\n3. zed env verify\n4. Run the package's declared tests and build scripts.`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asRoot(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isPackageIssue(value: unknown): value is PackageIssue {
  return typeof value === 'object'
    && value !== null
    && 'file' in value
    && 'line' in value
    && typeof (value as { file?: unknown }).file === 'string'
    && typeof (value as { line?: unknown }).line === 'number';
}
