import path from 'node:path';
import * as vscode from 'vscode';
import type { PackageIssue, PackageReport, WorkspaceReport } from './types';

export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private report: WorkspaceReport;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    initialReport: WorkspaceReport
  ) {
    this.report = initialReport;
  }

  public update(report: WorkspaceReport): void {
    this.report = report;
    if (this.panel) {
      this.panel.webview.html = renderDashboard(this.panel.webview, this.report);
    }
  }

  public show(packageRoot?: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'zedCursor.dashboard',
        'Zed Package Insights',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri]
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        void handleMessage(message);
      });
    }
    this.panel.webview.html = renderDashboard(this.panel.webview, this.report, packageRoot);
    this.panel.reveal(vscode.ViewColumn.Active, true);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

async function handleMessage(message: unknown): Promise<void> {
  if (!isDashboardMessage(message)) {
    return;
  }
  const commandMap: Readonly<Record<string, string>> = {
    refresh: 'zedCursor.refresh',
    install: 'zedCursor.install',
    frozen: 'zedCursor.installFrozen',
    build: 'zedCursor.build',
    verify: 'zedCursor.envVerify',
    open: 'zedCursor.openManifest',
    prompt: 'zedCursor.copyResolutionPrompt'
  };
  const command = commandMap[message.command];
  if (command) {
    await vscode.commands.executeCommand(command, message.root);
  }
}

function renderDashboard(
  webview: vscode.Webview,
  report: WorkspaceReport,
  selectedRoot?: string
): string {
  const nonce = randomNonce();
  const packages = selectedRoot
    ? report.packages.filter((entry) => path.normalize(entry.root) === path.normalize(selectedRoot))
    : report.packages;
  const packageCards = packages.length > 0
    ? packages.map(renderPackage).join('\n')
    : '<section class="empty"><h2>No Zed packages found</h2><p>Add a <code>.zpkg.toml</code> manifest to the workspace, then refresh.</p></section>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Zed Package Insights</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 24px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin: 16px 0 24px; }
    .metric, .package, .empty { border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
    .metric { padding: 12px; }
    .metric strong { display: block; font-size: 22px; }
    .package { padding: 18px; margin-bottom: 16px; }
    .package-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .package h2 { margin: 0 0 4px; font-size: 18px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 6px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    ul { padding-left: 20px; }
    li { margin: 7px 0; }
    .error { color: var(--vscode-errorForeground); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    .info { color: var(--vscode-editorInfo-foreground); }
    code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
    .empty { padding: 24px; }
  </style>
</head>
<body>
  <header>
    <div><h1>Zed Package Insights</h1><div class="muted">Analyzed with ${escapeHtml(report.analyzer)} at ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</div></div>
    <button data-command="refresh">Refresh</button>
  </header>
  <section class="summary">
    ${metric('Packages', report.counts.packages)}
    ${metric('Dependencies', report.counts.dependencies)}
    ${metric('Errors', report.counts.errors, 'error')}
    ${metric('Warnings', report.counts.warnings, 'warning')}
  </section>
  ${packageCards}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target.closest('button[data-command]');
      if (!target) return;
      vscode.postMessage({ command: target.dataset.command, root: target.dataset.root });
    });
  </script>
</body>
</html>`;
}

function renderPackage(packageReport: PackageReport): string {
  const canonical = packageReport.identity.org && packageReport.identity.name
    ? `${packageReport.identity.org}/${packageReport.identity.name}`
    : packageReport.identity.name ?? path.basename(packageReport.root);
  const issues = packageReport.issues.length > 0
    ? `<ul>${packageReport.issues.map(renderIssue).join('')}</ul>`
    : '<p>✓ No package problems detected.</p>';
  const root = escapeAttribute(packageReport.root);

  return `<section class="package">
    <div class="package-head">
      <div>
        <h2>${escapeHtml(canonical)}</h2>
        <div class="muted">${escapeHtml(packageReport.identity.version ?? 'version unknown')} · ${packageReport.dependencies.length} dependencies</div>
      </div>
      <span>${healthBadge(packageReport)}</span>
    </div>
    <div class="actions">
      <button data-command="open" data-root="${root}" class="secondary">Open manifest</button>
      <button data-command="install" data-root="${root}">zed install</button>
      <button data-command="frozen" data-root="${root}" class="secondary">Frozen install</button>
      <button data-command="verify" data-root="${root}" class="secondary">Verify environment</button>
      <button data-command="prompt" data-root="${root}" class="secondary">Copy resolution prompt</button>
    </div>
    <h3>Issues and recommendations</h3>
    ${issues}
  </section>`;
}

function renderIssue(issue: PackageIssue): string {
  const commands = issue.recommendations
    .map((entry) => entry.command?.join(' ') ?? entry.title)
    .filter(Boolean)
    .join(' · ');
  return `<li class="${escapeAttribute(issue.severity)}"><strong>${escapeHtml(issue.message)}</strong>${commands ? `<div class="muted">${escapeHtml(commands)}</div>` : ''}</li>`;
}

function healthBadge(packageReport: PackageReport): string {
  if (packageReport.issues.some((entry) => entry.severity === 'error')) {
    return '<span class="error">● errors</span>';
  }
  if (packageReport.issues.some((entry) => entry.severity === 'warning')) {
    return '<span class="warning">● warnings</span>';
  }
  return '<span>● healthy</span>';
}

function metric(label: string, value: number, className = ''): string {
  return `<div class="metric ${className}"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function isDashboardMessage(value: unknown): value is { command: string; root?: string } {
  return typeof value === 'object'
    && value !== null
    && 'command' in value
    && typeof (value as { command?: unknown }).command === 'string';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}
