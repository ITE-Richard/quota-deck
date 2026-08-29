import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { logger } from '../logger';
import {
  markStaleness,
  SNAPSHOT_STALE_AFTER_MS,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow,
} from '../types';
import { run } from '../util/exec';
import { resolveCli } from '../util/cliResolver';

/**
 * Claude Code provider。
 *
 * 偵察結論（Claude Code 2.1.251）：
 * - `claude auth status --json` 可用，回 loggedIn / email / orgName / subscriptionType
 * - `claude --help` 的子指令清單中沒有 usage；/usage 只存在於互動式 REPL
 * - ~/.claude.json 內有 cachedUsageUtilization，是 Claude Code 自己寫下的
 *   官方百分比快取（five_hour / seven_day / limits[]），此檔不含任何 token
 *
 * 降級鏈：
 *   1. claude auth status --json          → 登入狀態、帳號、方案
 *   2. ~/.claude.json cachedUsageUtilization → 官方百分比（但是快取，須標示資料時間）
 *   3. ~/.claude/projects 內的 jsonl      → 本地 token 估算
 *
 * 明確不做：讀取 ~/.claude/.credentials.json 的 accessToken 去呼叫
 * Anthropic 的非公開 OAuth usage endpoint。該 token 依 Anthropic Consumer ToS
 * 僅限 Claude Code 與 Claude.ai 使用，第三方工具使用可能導致帳號停權。
 * 本 provider 全程唯讀，也絕不觸發 token refresh。
 */
export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude' as const;

  private async cliPath(): Promise<string | null> {
    const cfg = readConfig();
    return resolveCli('claude', cfg.claudeCliPath, ['--version'], cfg.commandTimeoutMs);
  }

  async detect(): Promise<boolean> {
    return (await this.cliPath()) !== null;
  }

  loginCommand(): string {
    return 'claude auth login';
  }

  async fetch(): Promise<UsageSnapshot> {
    const cfg = readConfig();
    const now = new Date();
    const cli = await this.cliPath();

    if (!cli) {
      return {
        provider: 'claude',
        status: 'cli_not_found',
        windows: [],
        fetchedAt: now,
        source: 'cli-resolver',
        message: '找不到 claude CLI。可在設定 aiUsage.claude.cliPath 指定完整路徑。',
      };
    }

    // 1) 認證狀態
    const auth = await this.readAuthStatus(cli, cfg.commandTimeoutMs);
    if (auth.kind === 'error') {
      return {
        provider: 'claude',
        status: 'error',
        windows: [],
        fetchedAt: now,
        source: 'cli:auth-status',
        message: auth.message,
      };
    }
    if (auth.kind === 'logged_out') {
      return {
        provider: 'claude',
        status: 'not_logged_in',
        windows: [],
        fetchedAt: now,
        source: 'cli:auth-status',
        message: '尚未登入 Claude Code。',
      };
    }

    const account = auth.email ?? auth.orgName;
    const plan = auth.subscriptionType ? formatPlan(auth.subscriptionType) : undefined;

    // 2) Claude Code 自己的官方用量快取
    try {
      const util = readCachedUtilization();
      if (util && util.windows.length > 0) {
        const ageMs = now.getTime() - util.dataAt.getTime();
        return {
          provider: 'claude',
          status: 'ok',
          ...(account !== undefined ? { account } : {}),
          ...(plan !== undefined ? { plan } : {}),
          windows: markStaleness(util.windows, util.dataAt, now, SNAPSHOT_STALE_AFTER_MS),
          fetchedAt: now,
          source: 'cli:auth-status + local-cache:claude.json',
          message:
            `⚠️ 這是 ${formatLocal(util.dataAt)}（${formatAge(ageMs)}前）的快照，不是當下的值。` +
            'Claude Code 沒有任何會自我更新的本機用量來源：這份數字只有在你於 REPL 內執行 /usage 時' +
            '才會被改寫一次，之後就固定在那裡。密集使用時幾分鐘就能差好幾個百分點。' +
            '要更新：在 Claude Code 內執行 /usage，再回來按重新整理。' +
            '（本套件不會呼叫 Anthropic 的非公開 API 取得即時值，見 README 的 ToS 說明。）',
        };
      }
    } catch (err) {
      logger.error('claude: 讀取 ~/.claude.json 用量快取失敗', err);
    }

    // 3) 本地紀錄估算
    let estimateWindow: UsageWindow | null = null;
    try {
      const est = estimateFromTranscripts();
      if (est) {
        estimateWindow = {
          label: '近 5 小時（本地紀錄估算）',
          usedPercent: null,
          resetsAt: null,
          raw: `約 ${est.totalTokens.toLocaleString()} tokens / ${est.messages} 則訊息（${est.files} 個對話檔）`,
        };
      }
    } catch (err) {
      logger.error('claude: 掃描本機對話紀錄失敗', err);
    }

    return {
      provider: 'claude',
      status: 'ok',
      ...(account !== undefined ? { account } : {}),
      ...(plan !== undefined ? { plan } : {}),
      windows: estimateWindow ? [estimateWindow] : [],
      fetchedAt: now,
      source: 'cli:auth-status + local-logs:estimate',
      message:
        'Claude Code 沒有非互動式的用量查詢指令，本機也還沒有官方用量快取可讀，' +
        '因此無法取得官方百分比；此處僅為本地紀錄估算。',
    };
  }

  private async readAuthStatus(
    cli: string,
    timeoutMs: number
  ): Promise<
    | { kind: 'ok'; email?: string; orgName?: string; subscriptionType?: string }
    | { kind: 'logged_out' }
    | { kind: 'error'; message: string }
  > {
    const r = await run(cli, ['auth', 'status', '--json'], { timeoutMs });
    if (r.timedOut) {
      return { kind: 'error', message: 'claude auth status 逾時。' };
    }
    const text = r.stdout.trim();
    if (!text.startsWith('{')) {
      // 舊版沒有 --json 時會印出 help 或純文字
      if (/not logged in|logged out/i.test(`${r.stdout}${r.stderr}`)) {
        return { kind: 'logged_out' };
      }
      return { kind: 'error', message: 'claude auth status --json 沒有回傳 JSON，可能是 CLI 版本過舊。' };
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed['loggedIn'] !== true) {
        return { kind: 'logged_out' };
      }
      const out: { kind: 'ok'; email?: string; orgName?: string; subscriptionType?: string } = { kind: 'ok' };
      if (typeof parsed['email'] === 'string') {
        out.email = parsed['email'];
      }
      if (typeof parsed['orgName'] === 'string') {
        out.orgName = parsed['orgName'];
      }
      if (typeof parsed['subscriptionType'] === 'string') {
        out.subscriptionType = parsed['subscriptionType'];
      }
      return out;
    } catch {
      return { kind: 'error', message: '無法解析 claude auth status --json 的輸出。' };
    }
  }
}

/** 用詞刻意對齊 Claude Code /usage 面板的 Session (5hr) / Weekly (7 day)。 */
/** 目前快取的觀測時間（毫秒）。用來判斷 /usage 之後有沒有真的被改寫。 */
export function readUsageCacheFetchedAt(): number | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cached = parsed['cachedUsageUtilization'];
    if (!cached || typeof cached !== 'object') {
      return null;
    }
    const ms = (cached as Record<string, unknown>)['fetchedAtMs'];
    return typeof ms === 'number' ? ms : null;
  } catch {
    return null;
  }
}

/**
 * 等待 Claude Code 把新的用量寫進 ~/.claude.json。
 *
 * 這是**事件驅動**的一次性等待，不是輪詢：只在使用者按下「執行 /usage」之後啟動，
 * 拿到訊號或逾時就結束。同時監看檔案本身與 backups 目錄，
 * 因為 Claude Code 有時是寫備份再置換主檔，只監看單一檔案可能收不到事件。
 */
export function watchForUsageCacheUpdate(previousFetchedAt: number | null, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const home = os.homedir();
    const targets = [path.join(home, '.claude.json'), path.join(home, '.claude', 'backups')];
    const watchers: fs.FSWatcher[] = [];
    let settled = false;

    const finish = (changed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* 已關閉 */
        }
      }
      resolve(changed);
    };

    const check = (): void => {
      const now = readUsageCacheFetchedAt();
      if (now !== null && now !== previousFetchedAt) {
        logger.debug('claude: 偵測到用量快取已更新');
        finish(true);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    for (const target of targets) {
      try {
        watchers.push(fs.watch(target, { persistent: false }, () => check()));
      } catch {
        /* 該路徑不存在或不支援監看，靠另一個 */
      }
    }

    if (watchers.length === 0) {
      finish(false);
    }
  });
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '工作階段（5 小時）',
  seven_day: '每週（7 天）',
  seven_day_opus: '每週（Opus）',
  seven_day_sonnet: '每週（Sonnet）',
  seven_day_oauth_apps: '每週（OAuth apps）',
};

interface CachedUtilization {
  dataAt: Date;
  windows: UsageWindow[];
}

/**
 * 讀 ~/.claude.json 的 cachedUsageUtilization。
 *
 * 注意是這個檔，不是 .claude/ 資料夾內的檔案；此檔不含 token。
 * 我們只讀不寫，也不會去碰 .credentials.json 或 oauth refresh lock。
 */
function readCachedUtilization(): CachedUtilization | null {
  const file = path.join(os.homedir(), '.claude.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const cached = parsed['cachedUsageUtilization'];
  if (!cached || typeof cached !== 'object') {
    return null;
  }
  const c = cached as Record<string, unknown>;
  const fetchedAtMs = typeof c['fetchedAtMs'] === 'number' ? c['fetchedAtMs'] : null;
  const util = c['utilization'];
  if (!util || typeof util !== 'object') {
    return null;
  }
  const u = util as Record<string, unknown>;

  const windows: UsageWindow[] = [];
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const node = u[key];
    if (!node || typeof node !== 'object') {
      continue;
    }
    const n = node as Record<string, unknown>;
    const percent = n['utilization'];
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      continue;
    }
    const resets = typeof n['resets_at'] === 'string' ? new Date(n['resets_at']) : null;
    windows.push({
      label,
      usedPercent: percent,
      resetsAt: resets && !Number.isNaN(resets.getTime()) ? resets : null,
      raw: `${key}: ${percent}%`,
    });
  }

  if (windows.length === 0) {
    return null;
  }
  return {
    dataAt: fetchedAtMs ? new Date(fetchedAtMs) : new Date(0),
    windows,
  };
}

/**
 * 掃 ~/.claude/projects 底下近 5 小時的對話紀錄做 token 估算。
 *
 * 只讀 usage 欄位，不解析訊息內容，也不輸出任何內容到 log。
 */
function estimateFromTranscripts(): { totalTokens: number; messages: number; files: number } | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  const files: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length >= 40) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(full).mtimeMs >= cutoff) {
            files.push(full);
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(root, 0);

  if (files.length === 0) {
    return null;
  }

  let totalTokens = 0;
  let messages = 0;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) {
        continue;
      }
      const inTok = /"input_tokens":\s*(\d+)/.exec(line);
      const outTok = /"output_tokens":\s*(\d+)/.exec(line);
      const cacheRead = /"cache_read_input_tokens":\s*(\d+)/.exec(line);
      const cacheWrite = /"cache_creation_input_tokens":\s*(\d+)/.exec(line);
      const sum =
        toInt(inTok?.[1]) + toInt(outTok?.[1]) + toInt(cacheRead?.[1]) + toInt(cacheWrite?.[1]);
      if (sum > 0) {
        totalTokens += sum;
        messages += 1;
      }
    }
  }

  return messages > 0 ? { totalTokens, messages, files: files.length } : null;
}

function toInt(v: string | undefined): number {
  if (v === undefined) {
    return 0;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function formatPlan(subscriptionType: string): string {
  const map: Record<string, string> = {
    pro: 'Pro',
    max: 'Max',
    max_5x: 'Max 5x',
    max_20x: 'Max 20x',
    team: 'Team',
    enterprise: 'Enterprise',
    free: 'Free',
  };
  return map[subscriptionType] ?? subscriptionType;
}

function formatLocal(d: Date): string {
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) {
    return `${minutes} 分鐘`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} 小時 ${rest} 分` : `${hours} 小時`;
  }
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`;
}
