import * as vscode from 'vscode';

/**
 * 極簡雙語切換。
 *
 * 只有中英兩種語言，不採用 vscode.l10n（原始字串必須是英文、另外維護 bundle），
 * 而是把兩種文字並排寫在呼叫處，改一邊時另一邊就在眼前。
 * VSCode 顯示語言為 zh-* 時顯示中文，其餘一律英文。
 */
export function isZh(): boolean {
  return vscode.env.language.toLowerCase().startsWith('zh');
}

export function t(zh: string, en: string): string {
  return isZh() ? zh : en;
}
