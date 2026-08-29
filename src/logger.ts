import * as vscode from 'vscode';

/**
 * Output channel logger。
 *
 * 絕不寫入任何 token / credential：呼叫端只傳入已經整理過的摘要文字。
 * 為了防呆，這裡再做一次遮蔽。
 */
class Logger {
  private channel: vscode.OutputChannel | undefined;

  init(): vscode.OutputChannel {
    this.channel ??= vscode.window.createOutputChannel('AI Usage Panel');
    return this.channel;
  }

  private get debugEnabled(): boolean {
    return vscode.workspace.getConfiguration('aiUsage').get<boolean>('debug', false);
  }

  private write(level: string, message: string): void {
    const ch = this.channel;
    if (!ch) {
      return;
    }
    const stamp = new Date().toISOString();
    ch.appendLine(`[${stamp}] [${level}] ${redact(message)}`);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : err ? String(err) : '';
    this.write('error', detail ? `${message} — ${detail}` : message);
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      this.write('debug', message);
    }
  }

  show(): void {
    this.channel?.show(true);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g,
  /("?(?:access|refresh|id)_token"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
  /("?(?:csrfToken|csrf_token|apiKey|api_key|authorization)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
];

/** 把看起來像秘密的字串換成 <redacted>，避免任何形式的外洩。 */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}<redacted>` : '<redacted>'
    );
  }
  return out;
}

export const logger = new Logger();
