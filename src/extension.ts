import * as vscode from 'vscode';
import { SnapshotCache } from './cache';
import { EditorPanel } from './editorPanel';
import { logger } from './logger';
import { refreshClaudeUsageCache, UsagePanelViewProvider } from './panelViewProvider';
import { UsageStatusBar } from './statusBar';
import { UsageStore } from './store';
import type { ProviderId } from './types';
import { clearCliCache } from './util/cliResolver';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(logger.init());
  logger.info('AI Usage Panel 啟動');

  const cache = new SnapshotCache(context.globalState);
  const store = new UsageStore(cache);
  context.subscriptions.push(store);

  const statusBar = new UsageStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(store.onDidChange((state) => statusBar.update(state)));
  // 啟動時只呈現快取結果，不主動抓取（見 README「為什麼不做自動更新」）
  statusBar.update(store.state);

  const viewProvider = new UsagePanelViewProvider(context.extensionUri, store);
  for (const viewId of ['aiUsage.viewSidebar', 'aiUsage.viewPanel']) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(viewId, viewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
  }

  const refresh = (id: ProviderId) => (): void => {
    void store.refresh(id);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('aiUsage.refreshAll', () => {
      void store.refreshAll();
    }),
    vscode.commands.registerCommand('aiUsage.refreshClaude', refresh('claude')),
    vscode.commands.registerCommand('aiUsage.refreshCodex', refresh('codex')),
    vscode.commands.registerCommand('aiUsage.refreshAntigravity', refresh('antigravity')),
    vscode.commands.registerCommand('aiUsage.openInEditor', () => {
      EditorPanel.show(context.extensionUri, store);
    }),
    vscode.commands.registerCommand('aiUsage.claudeUsage', () => {
      void refreshClaudeUsageCache(store);
    }),
    vscode.commands.registerCommand('aiUsage.showLogs', () => {
      logger.show();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('aiUsage')) {
        return;
      }
      if (e.affectsConfiguration('aiUsage.claude.cliPath') || e.affectsConfiguration('aiUsage.codex.cliPath')) {
        clearCliCache();
      }
      store.notifyConfigChanged();
      statusBar.update(store.state);
    })
  );
}

export function deactivate(): void {
  logger.dispose();
}
