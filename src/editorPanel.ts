import * as vscode from 'vscode';
import { buildWebviewHtml, webviewOptions, wireWebview } from './panelViewProvider';
import type { UsageStore } from './store';

const VIEW_TYPE = 'aiUsage.editorPanel';

/**
 * 把同一份面板開在中間編輯器區（分頁）。
 *
 * 只保留單一實例：再次執行指令時把既有分頁帶到前景，
 * 而且和側邊/底部的 view 共用同一個 store，不會重複抓取。
 */
export class EditorPanel {
  private static current: EditorPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    store: UsageStore
  ) {
    this.panel.webview.options = webviewOptions(extensionUri);
    this.panel.webview.html = buildWebviewHtml(this.panel.webview, extensionUri);
    wireWebview(this.panel.webview, store, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(extensionUri: vscode.Uri, store: UsageStore): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (EditorPanel.current) {
      EditorPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'AI 用量', column, webviewOptions(extensionUri));
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    EditorPanel.current = new EditorPanel(panel, extensionUri, store);
  }

  private dispose(): void {
    EditorPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
