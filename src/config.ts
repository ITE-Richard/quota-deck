import * as vscode from 'vscode';
import type { ProviderId } from './types';

export interface AiUsageConfig {
  enabled: Record<ProviderId, boolean>;
  claudeCliPath: string;
  codexCliPath: string;
  codexAllowDirectApi: boolean;
  commandTimeoutMs: number;
  showStatusBarItem: boolean;
  statusBarProvider: 'lowest' | ProviderId;
  debug: boolean;
}

export function readConfig(): AiUsageConfig {
  const c = vscode.workspace.getConfiguration('aiUsage');
  const timeout = c.get<number>('commandTimeoutMs', 10000);
  return {
    enabled: {
      claude: c.get<boolean>('providers.claude.enabled', true),
      codex: c.get<boolean>('providers.codex.enabled', true),
      antigravity: c.get<boolean>('providers.antigravity.enabled', true),
    },
    claudeCliPath: c.get<string>('claude.cliPath', 'claude'),
    codexCliPath: c.get<string>('codex.cliPath', 'codex'),
    codexAllowDirectApi: c.get<boolean>('codex.allowDirectApi', false),
    commandTimeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(120000, timeout)) : 10000,
    showStatusBarItem: c.get<boolean>('showStatusBarItem', true),
    statusBarProvider: c.get<'lowest' | ProviderId>('statusBar.provider', 'lowest'),
    debug: c.get<boolean>('debug', false),
  };
}
