import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { isZh, t } from './i18n';
import { logger } from './logger';
import { getProvider } from './providers';
import { probeClaude, resolveClaudeCli } from './providers/claude';
import type { UsageStore } from './store';
import { PROVIDER_IDS, PROVIDER_INSTALL_URLS, PROVIDER_LABELS, type ProviderId } from './types';
import { EXTENSION_VERSION } from './version';

/** 產生一次性的 nonce，供 CSP script-src 使用（密碼學亂數，hex 屬於 base64-value 的子集）。 */
function makeNonce(): string {
  return randomBytes(16).toString('hex');
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
    .replace(/\{\{lang\}\}/g, isZh() ? 'zh-Hant' : 'en')
    .replace(/\{\{version\}\}/g, EXTENSION_VERSION)
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
 * 在背景以 Haiku 執行一次極短的 probe 請求，攔截 rate_limit_event 取得即時額度。
 *
 * 不開終端機，但這是一次真正的 API 請求，會計入 Claude 用量；只在使用者按下按鈕時執行。
 * 成功後寫入 ~/.claude/usage_snapshot.json 並刷新 Claude 卡片。
 */
export async function refreshClaudeUsageCache(store: UsageStore): Promise<void> {
  const cli = await resolveClaudeCli();
  if (!cli) {
    void vscode.window.showWarningMessage(
      t('找不到 claude CLI，無法進行背景探測。', 'Could not find the claude CLI; cannot run the background probe.')
    );
    return;
  }

  logger.info('正在背景以 Haiku 探測 Claude 即時用量...');
  const res = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t(
        'Quota Deck：正在背景探測 Claude 即時用量 (Haiku probe)...',
        'Quota Deck: probing live Claude usage (Haiku probe)...'
      ),
      cancellable: false,
    },
    () => probeClaude(cli)
  );

  if (res.success) {
    await store.refresh('claude');
    void vscode.window.showInformationMessage(t('Claude 即時用量已更新成功。', 'Claude live usage updated.'));
  } else {
    logger.warn(`Claude 背景探測失敗：${res.message ?? '未知原因'}`);
    void vscode.window.showWarningMessage(
      t(
        `無法從 Claude 背景探測取得用量：${res.message ?? '未能解析 rate_limit_event'}。`,
        `Could not get usage from the Claude background probe: ${res.message ?? 'no rate_limit_event parsed'}.`
      )
    );
  }
}

/** 在 integrated terminal 執行對應的登入指令；本套件不自行實作任何 OAuth 流程。 */
export function runLoginInTerminal(id: ProviderId): void {
  const command = getProvider(id).loginCommand();
  const terminal = vscode.window.createTerminal({ name: t(`${PROVIDER_LABELS[id]} 登入`, `${PROVIDER_LABELS[id]} sign-in`) });
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
