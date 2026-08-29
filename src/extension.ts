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
  logger.info('Quota Deck 啟動');

  const cache = new SnapshotCache(context.globalState);
  const store = new UsageStore(cache);
  context.subscriptions.push(store);

  const statusBar = new UsageStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(store.onDidChange((state) => statusBar.update(state)));
  // 啟動時只呈現快取結果，不主動抓取（見 README「為什麼不做自動更新」）
  statusBar.update(store.state);

  const viewProvider = new UsagePanelViewProvider(context.extensionUri, store);
  for (const viewId of ['quotaDeck.viewSidebar', 'quotaDeck.viewPanel']) {
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
    vscode.commands.registerCommand('quotaDeck.refreshAll', () => {
      void store.refreshAll();
    }),
    vscode.commands.registerCommand('quotaDeck.refreshClaude', refresh('claude')),
    vscode.commands.registerCommand('quotaDeck.refreshCodex', refresh('codex')),
    vscode.commands.registerCommand('quotaDeck.refreshAntigravity', refresh('antigravity')),
    vscode.commands.registerCommand('quotaDeck.openInEditor', () => {
      EditorPanel.show(context.extensionUri, store);
    }),
    vscode.commands.registerCommand('quotaDeck.claudeUsage', () => {
      void refreshClaudeUsageCache(store);
    }),
    vscode.commands.registerCommand('quotaDeck.showLogs', () => {
      logger.show();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('quotaDeck')) {
        return;
      }
      if (e.affectsConfiguration('quotaDeck.claude.cliPath') || e.affectsConfiguration('quotaDeck.codex.cliPath')) {
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
