/**
 * 單元測試用的最小 vscode 替身（由 esbuild alias 注入）。
 *
 * 只提供被測模組在 import 時或測試路徑上會碰到的 API；
 * 語言固定為英文，讓斷言不受執行環境影響。
 */
export const env = { language: 'en' };

export const workspace = {
  getConfiguration(): { get<T>(key: string, fallback: T): T } {
    return {
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
    };
  },
};

export const window = {
  createOutputChannel(): { appendLine(): void; show(): void; dispose(): void } {
    return { appendLine() {}, show() {}, dispose() {} };
  },
};
