export type ProviderId = 'claude' | 'codex' | 'antigravity';

export type UsageStatus =
  | 'ok'
  | 'not_logged_in'
  | 'cli_not_found'
  | 'unsupported'
  | 'error';

export interface UsageWindow {
  /** '5 小時' | '每週' | 模型名稱 */
  label: string;
  usedPercent: number | null;
  resetsAt: Date | null;
  /** 原始文字，供 debug 與 tooltip */
  raw?: string;
  /**
   * 這個數字實際被觀測到的時間。
   *
   * 來自本機快取 / log 的數字可能遠早於我們讀取的時間，
   * 沒有這個欄位就無法誠實呈現它有多舊。
   */
  observedAt?: Date;
  /** observedAt 已經舊到不該當成當下值來看。 */
  stale?: boolean;
}

export interface UsageSnapshot {
  provider: ProviderId;
  status: UsageStatus;
  account?: string;
  plan?: string;
  windows: UsageWindow[];
  credits?: { used: number; total: number };
  fetchedAt: Date;
  /** 說明資料是從哪條路徑拿到的，例如 'cli:auth-status' | 'local-logs' */
  source: string;
  message?: string;
}

export interface UsageProvider {
  readonly id: ProviderId;
  /** CLI 是否存在 */
  detect(): Promise<boolean>;
  fetch(): Promise<UsageSnapshot>;
  /** 給「登入」按鈕用的 shell 指令 */
  loginCommand(): string;
}

/** 送進 Webview / 存進 globalState 的形狀（Date 一律轉 ISO 字串）。 */
export interface SerializedWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  raw?: string;
  observedAt?: string;
  stale?: boolean;
}

/**
 * 過期門檻。
 *
 * 兩個來源的性質不同，門檻也不同：
 * - Codex 每次你使用它就會把新的 rate_limits 寫進本機紀錄，會自我更新，
 *   所以放寬到 15 分鐘。
 * - Claude 的 `cachedUsageUtilization` **只有**在 REPL 內開啟 /usage 時才會被改寫，
 *   完全不會自我更新，因此它永遠是一張快照。實測在密集使用時，
 *   4 分鐘就能讓 5 小時窗差 6 個百分點，所以門檻壓到 2 分鐘——
 *   結果就是它幾乎總是被標為快照，這正是事實。
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;
export const SNAPSHOT_STALE_AFTER_MS = 2 * 60 * 1000;

export function markStaleness(
  windows: UsageWindow[],
  observedAt: Date,
  now: Date,
  thresholdMs: number = STALE_AFTER_MS
): UsageWindow[] {
  const stale = now.getTime() - observedAt.getTime() > thresholdMs;
  return windows.map((w) => ({ ...w, observedAt, ...(stale ? { stale: true } : {}) }));
}

/**
 * 重置時刻已經過去的視窗，其百分比屬於「上一個」視窗，必然失效。
 *
 * 例：Codex 在 13:15 寫下 5 小時窗 57%、resets_at 14:59。到了 21:00 再讀，
 * 那個視窗早就結束、額度已經歸零，畫一條 57% 的進度條是錯的。
 * 我們無從得知新視窗的當下值，所以把百分比降級為未知，只在 raw 保留舊值供參考。
 */
export function expireRolledOverWindows(windows: UsageWindow[], now: Date): UsageWindow[] {
  return windows.map((w) => {
    if (w.usedPercent === null || w.resetsAt === null || w.resetsAt.getTime() > now.getTime()) {
      return w;
    }
    const previous = `上一視窗 ${w.usedPercent.toFixed(1)}%`;
    return {
      ...w,
      usedPercent: null,
      stale: true,
      raw: w.raw === undefined ? previous : `${previous} · ${w.raw}`,
    };
  });
}

export interface SerializedSnapshot {
  provider: ProviderId;
  status: UsageStatus;
  account?: string;
  plan?: string;
  windows: SerializedWindow[];
  credits?: { used: number; total: number };
  fetchedAt: string;
  source: string;
  message?: string;
  /** 由快取還原、尚未在本次工作階段重抓過。 */
  cached?: boolean;
}

export function serializeSnapshot(s: UsageSnapshot): SerializedSnapshot {
  const out: SerializedSnapshot = {
    provider: s.provider,
    status: s.status,
    windows: s.windows.map((w) => {
      const sw: SerializedWindow = {
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
      };
      if (w.raw !== undefined) {
        sw.raw = w.raw;
      }
      if (w.observedAt !== undefined) {
        sw.observedAt = w.observedAt.toISOString();
      }
      if (w.stale !== undefined) {
        sw.stale = w.stale;
      }
      return sw;
    }),
    fetchedAt: s.fetchedAt.toISOString(),
    source: s.source,
  };
  if (s.account !== undefined) {
    out.account = s.account;
  }
  if (s.plan !== undefined) {
    out.plan = s.plan;
  }
  if (s.credits !== undefined) {
    out.credits = s.credits;
  }
  if (s.message !== undefined) {
    out.message = s.message;
  }
  return out;
}

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'antigravity'];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  antigravity: 'Google Antigravity',
};

export const PROVIDER_INSTALL_URLS: Record<ProviderId, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
  antigravity: 'https://antigravity.google/download',
};
