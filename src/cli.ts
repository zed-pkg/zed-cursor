import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface CliAvailability {
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}

export class ZedCliRunner {
  private terminal: vscode.Terminal | undefined;

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async checkAvailability(): Promise<CliAvailability> {
    const cliPath = this.cliPath();
    try {
      const { stdout, stderr } = await execFileAsync(cliPath, ['--version'], {
        timeout: 5_000,
        windowsHide: true
      });
      const version = (stdout || stderr).trim();
      return { available: true, ...(version ? { version } : {}) };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  public async run(
    args: readonly string[],
    cwd: string,
    options: { readonly mutating: boolean; readonly title: string }
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        'Zed CLI commands are disabled until this workspace is trusted. Read-only package diagnostics remain available.'
      );
      return;
    }

    const configuration = vscode.workspace.getConfiguration('zedCursor');
    const shouldConfirm = configuration.get<boolean>('confirmMutatingCommands', true);
    if (options.mutating && shouldConfirm) {
      const commandPreview = [this.cliPath(), ...args].join(' ');
      const selection = await vscode.window.showWarningMessage(
        `${options.title} will run “${commandPreview}” in ${cwd}.`,
        { modal: true },
        'Run command'
      );
      if (selection !== 'Run command') {
        return;
      }
    }

    this.terminal ??= vscode.window.createTerminal({
      name: 'Zed Package',
      cwd,
      iconPath: new vscode.ThemeIcon('package')
    });
    const command = [this.cliPath(), ...args].map(shellQuote).join(' ');
    this.output.appendLine(`Running in ${cwd}: ${command}`);
    this.terminal.show(true);
    this.terminal.sendText(command, true);
  }

  public dispose(): void {
    this.terminal?.dispose();
    this.terminal = undefined;
  }

  private cliPath(): string {
    return vscode.workspace.getConfiguration('zedCursor').get<string>('cliPath', 'zed').trim() || 'zed';
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
