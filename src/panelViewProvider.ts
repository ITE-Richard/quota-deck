import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { readConfig } from './config';
import { logger } from './logger';
import { getProvider } from './providers';
import { readUsageCacheFetchedAt, watchForUsageCacheUpdate } from './providers/claude';
import type { UsageStore } from './store';
import { PROVIDER_IDS, PROVIDER_INSTALL_URLS, PROVIDER_LABELS, type ProviderId } from './types';
import { resolveCli } from './util/cliResolver';

/** 產生一次性的 nonce，供 CSP script-src 使用。 */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * 三個顯示位置共用同一份 HTML。
 *
 * CSP 只允許：來自 localResourceRoots 的樣式/圖片，以及帶有本次 nonce 的 script。
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
  const htmlPath = vscode.Uri.joinPath(mediaUri, 'panel.html');
  const template = fs.readFileSync(htmlPath.fsPath, 'utf8');

  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'panel.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'panel.js'));
  const nonce = makeNonce();

  return template
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{styleUri\}\}/g, styleUri.toString())
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    // 只允許讀取 media/ 底下的資源
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

/**
 * 把一個 webview 接到共用 store 上：
 * 狀態變更就推給前端，前端的動作訊息轉成對應行為。
 */
export function wireWebview(
  webview: vscode.Webview,
  store: UsageStore,
  disposables: vscode.Disposable[]
): void {
  const post = (): void => {
    void webview.postMessage({ type: 'state', state: store.state });
  };

  disposables.push(store.onDidChange(post));

  disposables.push(
    webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: unknown; provider?: unknown } | null;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'ready':
          post();
          return;
        case 'refresh':
          if (isProviderId(msg.provider)) {
            void store.refresh(msg.provider);
          } else {
            void store.refreshAll();
          }
          return;
        case 'login':
          if (isProviderId(msg.provider)) {
            runLoginInTerminal(msg.provider);
          }
          return;
        case 'openInstall':
          if (isProviderId(msg.provider)) {
            void vscode.env.openExternal(vscode.Uri.parse(PROVIDER_INSTALL_URLS[msg.provider]));
          }
          return;
        case 'claudeUsage':
          void refreshClaudeUsageCache(store);
          return;
        case 'showLogs':
          logger.show();
          return;
        default:
          return;
      }
    })
  );
}

/**
 * 在終端機開一個 Claude Code REPL 並送出 `/usage`，藉此讓它刷新本機用量快取。
 *
 * 為什麼要繞這一圈：`/usage` 只存在於互動式 REPL，沒有非互動子指令，
 * 而 `claude auth status` / `doctor` / `mcp list` 實測都不會觸發快取更新。
 * `/usage` 本身是 UI 指令，不會送出訊息，因此不消耗配額。
 *
 * 送出後以事件驅動的方式等待 ~/.claude.json 被改寫，一偵測到就自動重新整理 Claude 卡片。
 * 這完全由使用者點擊觸發，不是背景輪詢。
 */
export async function refreshClaudeUsageCache(store: UsageStore): Promise<void> {
  const cfg = readConfig();
  const cli = await resolveCli('claude', cfg.claudeCliPath, ['--version'], cfg.commandTimeoutMs);
  if (!cli) {
    void vscode.window.showWarningMessage('找不到 claude CLI，無法開啟 /usage。');
    return;
  }

  const before = readUsageCacheFetchedAt();
  // 直接把 CLI 當成終端機程序啟動（shellPath），不經過任何 shell，
  // 這樣路徑含空白也不必處理引號，Windows / macOS / Linux 行為一致。
  const terminal = vscode.window.createTerminal({ name: 'Claude Code /usage', shellPath: cli });
  terminal.show(true);
  terminal.sendText('/usage', true);
  logger.info('已在終端機開啟 Claude Code 並送出 /usage，等待用量快取更新');

  const updated = await watchForUsageCacheUpdate(before, 120000);
  if (updated) {
    await store.refresh('claude');
    void vscode.window.showInformationMessage('Claude 用量已更新。可以關掉那個終端機了。');
  } else {
    void vscode.window.showWarningMessage(
      '沒有偵測到 Claude 用量快取更新。請確認終端機裡的 /usage 面板有出現，然後手動按重新整理。'
    );
  }
}

/** 在 integrated terminal 執行對應的登入指令；本套件不自行實作任何 OAuth 流程。 */
export function runLoginInTerminal(id: ProviderId): void {
  const command = getProvider(id).loginCommand();
  const terminal = vscode.window.createTerminal({ name: `${PROVIDER_LABELS[id]} 登入` });
  terminal.show(true);
  terminal.sendText(command, true);
  logger.info(`已在終端機執行 ${id} 的登入指令`);
}

/**
 * WebviewView provider。
 *
 * 同一個 class 會被註冊到 Activity Bar 與底部 Panel 兩個 view id；
 * 使用者也可以用 VSCode 內建的拖曳把 view 搬到右側 Secondary Side Bar。
 * 三個位置共用同一個 store，不會各自重複抓取。
 */
export class UsagePanelViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: UsageStore
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = buildWebviewHtml(view.webview, this.extensionUri);

    const disposables: vscode.Disposable[] = [];
    wireWebview(view.webview, this.store, disposables);
    view.onDidDispose(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
}
