import path from 'node:path';
import * as vscode from 'vscode';
import type { PackageIssue, Recommendation } from './types';
import { commandForRecommendation } from './tree';

export class ZedCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  };

  public constructor(private readonly issueLookup: () => readonly PackageIssue[]) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const zedDiagnostics = context.diagnostics.filter((entry) => entry.source === 'zed-cursor');
    if (zedDiagnostics.length === 0) {
      return [];
    }

    const issues = this.issueLookup().filter((entry) => path.normalize(entry.file) === path.normalize(document.uri.fsPath));
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();

    for (const diagnostic of zedDiagnostics) {
      const issue = issues.find((entry) => entry.code === diagnostic.code && Math.max(0, entry.line - 1) === diagnostic.range.start.line)
        ?? issues.find((entry) => entry.code === diagnostic.code);
      if (!issue) {
        continue;
      }
      for (const recommendation of issue.recommendations) {
        const key = `${issue.code}:${recommendation.kind}:${recommendation.title}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        actions.push(toCodeAction(recommendation, issue, diagnostic));
      }
    }
    return actions;
  }
}

function toCodeAction(
  recommendation: Recommendation,
  issue: PackageIssue,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction {
  const action = new vscode.CodeAction(recommendation.title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = recommendation.kind === 'install' || recommendation.kind === 'open-manifest';
  action.command = {
    command: commandForRecommendation(recommendation),
    title: recommendation.title,
    arguments: [path.dirname(issue.file)]
  };
  return action;
}
