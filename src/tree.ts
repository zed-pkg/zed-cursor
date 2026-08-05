import path from 'node:path';
import * as vscode from 'vscode';
import type {
  PackageDependency,
  PackageIssue,
  PackageReport,
  Recommendation,
  WorkspaceReport
} from './types';

type TreeNode =
  | { readonly kind: 'package'; readonly packageReport: PackageReport }
  | { readonly kind: 'group'; readonly group: 'issues' | 'dependencies' | 'actions'; readonly packageReport: PackageReport }
  | { readonly kind: 'issue'; readonly issue: PackageIssue; readonly packageReport: PackageReport }
  | { readonly kind: 'dependency'; readonly dependency: PackageDependency; readonly packageReport: PackageReport }
  | { readonly kind: 'action'; readonly recommendation: Recommendation; readonly packageReport: PackageReport };

export class PackageTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  private report: WorkspaceReport;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(initialReport: WorkspaceReport) {
    this.report = initialReport;
  }

  public update(report: WorkspaceReport): void {
    this.report = report;
    this.changeEmitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'package':
        return packageItem(element.packageReport);
      case 'group':
        return groupItem(element.group, element.packageReport);
      case 'issue':
        return issueItem(element.issue, element.packageReport);
      case 'dependency':
        return dependencyItem(element.dependency);
      case 'action':
        return actionItem(element.recommendation, element.packageReport);
    }
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.report.packages.map((packageReport) => ({ kind: 'package', packageReport }));
    }

    if (element.kind === 'package') {
      const groups: TreeNode[] = [];
      if (element.packageReport.issues.length > 0) {
        groups.push({ kind: 'group', group: 'issues', packageReport: element.packageReport });
      }
      groups.push({ kind: 'group', group: 'dependencies', packageReport: element.packageReport });
      groups.push({ kind: 'group', group: 'actions', packageReport: element.packageReport });
      return groups;
    }

    if (element.kind === 'group') {
      switch (element.group) {
        case 'issues':
          return element.packageReport.issues.map((issue) => ({
            kind: 'issue',
            issue,
            packageReport: element.packageReport
          }));
        case 'dependencies':
          return element.packageReport.dependencies.map((dependency) => ({
            kind: 'dependency',
            dependency,
            packageReport: element.packageReport
          }));
        case 'actions':
          return recommendationsFor(element.packageReport).map((recommendation) => ({
            kind: 'action',
            recommendation,
            packageReport: element.packageReport
          }));
      }
    }

    return [];
  }
}

function packageItem(packageReport: PackageReport): vscode.TreeItem {
  const label = canonicalName(packageReport) ?? path.basename(packageReport.root);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = packageReport.identity.version;
  item.contextValue = 'zedPackage';
  item.tooltip = new vscode.MarkdownString([
    `**${label}**`,
    '',
    `Manifest: \`${packageReport.manifestPath}\``,
    `Dependencies: ${packageReport.dependencies.length}`,
    `Issues: ${packageReport.issues.length}`
  ].join('\n'));
  item.iconPath = packageReport.issues.some((entry) => entry.severity === 'error')
    ? new vscode.ThemeIcon('error')
    : packageReport.issues.some((entry) => entry.severity === 'warning')
      ? new vscode.ThemeIcon('warning')
      : new vscode.ThemeIcon('pass-filled');
  item.command = {
    command: 'zedCursor.showDashboard',
    title: 'Show package insights',
    arguments: [packageReport.root]
  };
  return item;
}

function groupItem(group: 'issues' | 'dependencies' | 'actions', packageReport: PackageReport): vscode.TreeItem {
  const counts = {
    issues: packageReport.issues.length,
    dependencies: packageReport.dependencies.length,
    actions: recommendationsFor(packageReport).length
  };
  const labels = { issues: 'Issues', dependencies: 'Dependencies', actions: 'Recommended actions' };
  const icons = { issues: 'issues', dependencies: 'references', actions: 'lightbulb' };
  const item = new vscode.TreeItem(
    `${labels[group]} (${counts[group]})`,
    vscode.TreeItemCollapsibleState.Expanded
  );
  item.iconPath = new vscode.ThemeIcon(icons[group]);
  return item;
}

function issueItem(issue: PackageIssue, packageReport: PackageReport): vscode.TreeItem {
  const item = new vscode.TreeItem(issue.message, vscode.TreeItemCollapsibleState.None);
  item.description = issue.code;
  item.iconPath = new vscode.ThemeIcon(
    issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'
  );
  item.tooltip = issue.detail ?? issue.message;
  item.command = {
    command: 'zedCursor.openIssue',
    title: 'Open issue',
    arguments: [issue, packageReport.root]
  };
  return item;
}

function dependencyItem(dependency: PackageDependency): vscode.TreeItem {
  const detail = dependency.path
    ? `path: ${dependency.path}`
    : dependency.git
      ? `git: ${dependency.git}`
      : dependency.requirement ?? 'unresolved';
  const item = new vscode.TreeItem(dependency.name, vscode.TreeItemCollapsibleState.None);
  item.description = detail;
  item.tooltip = `${dependency.section} · ${detail}`;
  item.iconPath = new vscode.ThemeIcon(dependency.path ? 'folder-library' : 'package');
  return item;
}

function actionItem(recommendation: Recommendation, packageReport: PackageReport): vscode.TreeItem {
  const item = new vscode.TreeItem(recommendation.title, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('play-circle');
  item.tooltip = recommendation.detail ?? recommendation.command?.join(' ') ?? recommendation.title;
  item.command = {
    command: commandForRecommendation(recommendation),
    title: recommendation.title,
    arguments: [packageReport.root]
  };
  return item;
}

function recommendationsFor(packageReport: PackageReport): Recommendation[] {
  const recommendations: Recommendation[] = [
    { title: 'Open package manifest', kind: 'open-manifest' },
    { title: 'Install dependencies', kind: 'install', command: ['install'] },
    { title: 'Verify frozen install', kind: 'install-frozen', command: ['install', '--frozen'] },
    { title: 'Show package dashboard', kind: 'refresh' }
  ];
  for (const issue of packageReport.issues) {
    recommendations.push(...issue.recommendations);
  }
  const seen = new Set<string>();
  return recommendations.filter((entry) => {
    const key = `${entry.kind}:${entry.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function commandForRecommendation(recommendation: Recommendation): string {
  switch (recommendation.kind) {
    case 'refresh':
      return recommendation.title.includes('dashboard') ? 'zedCursor.showDashboard' : 'zedCursor.refresh';
    case 'open-manifest':
    case 'edit':
      return 'zedCursor.openManifest';
    case 'install':
      return 'zedCursor.install';
    case 'install-frozen':
      return 'zedCursor.installFrozen';
    case 'build':
      return 'zedCursor.build';
    case 'env-verify':
      return 'zedCursor.envVerify';
    case 'self-update-check':
      return 'zedCursor.selfUpdateCheck';
  }
}

function canonicalName(packageReport: PackageReport): string | undefined {
  const { org, name } = packageReport.identity;
  return org && name ? `${org}/${name}` : name;
}
