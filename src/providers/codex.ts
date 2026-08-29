import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { logger } from '../logger';
import { markStaleness, STALE_AFTER_MS, type UsageProvider, type UsageSnapshot, type UsageWindow } from '../types';
import { jsonRpcStdio, run } from '../util/exec';
import { resolveCli } from '../util/cliResolver';

/**
 * OpenAI Codex provider。
 *
 * 偵察結論（codex-cli 0.151.0-alpha.7.1）：
 * - `codex --help` 沒有 usage 子指令；/status 與 /usage 只存在於 TUI 內
 * - `codex login status` 可判斷登入狀態，但沒有 --json
 * - 官方百分比其實已經被寫進本機 rollout log：
 *   CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 的 token_count 事件
 *   帶有 rate_limits.{primary,secondary,credits,plan_type}，
 *   primary = 5 小時窗（window_minutes 300），secondary = 每週窗（10080）。
 *
 * 因此降級鏈為：
 *   1. 探測 `codex usage --json`（未來若真的出現就優先用）
 *   2. `codex login status` 判定登入
 *   3. 讀最新 rollout jsonl 的 rate_limits（官方數字，純本機，不發網路請求）
 *   4. 本地 token 加總估算
 */
export class CodexProvider implements UsageProvider {
  readonly id = 'codex' as const;

  private async cliPath(): Promise<string | null> {
    const cfg = readConfig();
    return resolveCli('codex', cfg.codexCliPath, ['--version'], cfg.commandTimeoutMs);
  }

  async detect(): Promise<boolean> {
    return (await this.cliPath()) !== null;
  }

  loginCommand(): string {
    return 'codex login';
  }

  async fetch(): Promise<UsageSnapshot> {
    const cfg = readConfig();
    const now = new Date();
    const cli = await this.cliPath();

    if (!cli) {
      return {
        provider: 'codex',
        status: 'cli_not_found',
        windows: [],
        fetchedAt: now,
        source: 'cli-resolver',
        message: '找不到 codex CLI。可在設定 aiUsage.codex.cliPath 指定完整路徑。',
      };
    }

    // 1) app-server 的 account/rateLimits/read —— 官方、即時、不消耗配額
    const live = await this.tryAppServer(cli, Math.max(cfg.commandTimeoutMs, 20000), now);
    if (live) {
      return live;
    }

    // 2) 未來若出現原生的 usage 子指令，次優先
    const native = await this.tryNativeUsage(cli, cfg.commandTimeoutMs);
    if (native) {
      return native;
    }

    // 2) 登入狀態
    const login = await run(cli, ['login', 'status'], { timeoutMs: cfg.commandTimeoutMs });
    const loginText = `${login.stdout}\n${login.stderr}`.trim();
    if (/not logged in/i.test(loginText)) {
      return {
        provider: 'codex',
        status: 'not_logged_in',
        windows: [],
        fetchedAt: now,
        source: 'cli:login-status',
        message: '尚未登入 Codex。',
      };
    }
    if (login.timedOut || login.failure) {
      return {
        provider: 'codex',
        status: 'error',
        windows: [],
        fetchedAt: now,
        source: 'cli:login-status',
        message: login.timedOut ? 'codex login status 逾時。' : '無法執行 codex login status。',
      };
    }

    const account = /logged in using (.+)/i.exec(loginText)?.[1]?.trim();

    // 3) 本機 rollout log 內的官方 rate_limits
    try {
      const local = readLatestRateLimits();
      if (local) {
        const windows: UsageWindow[] = [];
        if (local.primary) {
          windows.push(toWindow('5 小時', local.primary));
        }
        if (local.secondary) {
          windows.push(toWindow('每週', local.secondary));
        }
        if (local.credits && local.credits.hasCredits) {
          windows.push({
            label: 'Credits',
            usedPercent: null,
            resetsAt: null,
            raw: `餘額 ${local.credits.balance}${local.credits.unlimited ? '（無上限）' : ''}`,
          });
        }
        const ageMs = now.getTime() - local.observedAt.getTime();
        const isStale = ageMs > STALE_AFTER_MS;
        const planName = local.planType ? capitalize(local.planType) : undefined;
        const snapshot: UsageSnapshot = {
          provider: 'codex',
          status: 'ok',
          windows: markStaleness(windows, local.observedAt, now),
          fetchedAt: now,
          source: 'local-logs:rollout-rate-limits',
          message: isStale
            ? `⚠️ 這些百分比是 ${formatLocal(local.observedAt)}（${formatAge(ageMs)}前）Codex 寫下的快照，不是當下的值。` +
              'Codex 只有在你實際使用它的時候才會把新的 rate_limits 寫進本機紀錄。' +
              '在 Codex 內送出一則訊息後再回來按重新整理，數字就會跟上。'
            : `官方數字，取自 Codex 本機工作階段紀錄（寫入於 ${formatLocal(local.observedAt)}）。`,
        };
        // 拿不到 email 時，依規格 fallback 顯示 plan 名稱
        if (account !== undefined) {
          snapshot.account = account;
        } else if (planName !== undefined) {
          snapshot.account = planName;
        }
        if (planName !== undefined) {
          snapshot.plan = planName;
        }
        return snapshot;
      }
    } catch (err) {
      logger.error('codex: 讀取本機 rollout 紀錄失敗', err);
    }

    // 3b) 使用者明確允許時，才會走讀 auth.json 直接查 API 的路徑
    if (cfg.codexAllowDirectApi) {
      return {
        provider: 'codex',
        status: 'unsupported',
        windows: [],
        fetchedAt: now,
        ...(account !== undefined ? { account } : {}),
        source: 'direct-api',
        message:
          'aiUsage.codex.allowDirectApi 已開啟，但目前沒有經過驗證的公開 rate limit endpoint，' +
          '本套件不會去猜測未公開的 API。請先在 Codex 內互動一次，讓它把官方數字寫進本機紀錄。',
      };
    }

    // 4) 本地估算
    const estimate = estimateFromRollouts();
    return {
      provider: 'codex',
      status: 'ok',
      ...(account !== undefined ? { account } : {}),
      windows: estimate
        ? [
            {
              label: '本地估算',
              usedPercent: null,
              resetsAt: null,
              raw: `近 5 小時約 ${estimate.totalTokens.toLocaleString()} tokens（${estimate.sessions} 個工作階段）`,
            },
          ]
        : [],
      fetchedAt: now,
      source: 'local-logs:estimate',
      message:
        '本機紀錄中尚未出現官方 rate_limits（通常代表這個版本還沒寫入，或最近沒有使用過）。' +
        '此處僅為本地 token 估算，非官方百分比。',
    };
  }

  /**
   * `codex app-server` 的 stdio JSON-RPC：initialize → account/rateLimits/read。
   *
   * 這是官方 CLI 自己的查詢管道（就像 `claude auth status --json` 一樣），
   * 我們沒有讀 auth.json、也沒有自己去打任何 OpenAI endpoint。
   * 實測回傳的是當下即時值，且不消耗配額——已與 ChatGPT 網頁版的
   * 「使用量」頁面逐項核對過（網頁顯示剩餘，這裡顯示已使用，兩者互補為 100%）。
   */
  private async tryAppServer(cli: string, timeoutMs: number, now: Date): Promise<UsageSnapshot | null> {
    const result = await jsonRpcStdio(
      cli,
      ['app-server'],
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-usage-panel', version: '0.1.0' } } },
      { id: 2, method: 'account/rateLimits/read' },
      2,
      timeoutMs
    );
    if (!result || typeof result !== 'object') {
      return null;
    }
    const root = result as Record<string, unknown>;
    const limits = parseCamelLimits(root['rateLimits']);
    if (!limits) {
      return null;
    }

    const windows: UsageWindow[] = [];
    if (limits.primary) {
      windows.push(toWindow('5 小時', limits.primary));
    }
    if (limits.secondary) {
      windows.push(toWindow('每週', limits.secondary));
    }

    // codex 之外的其他限額池（例如 base_model_inference / gpt-reserve）
    const byId = root['rateLimitsByLimitId'];
    if (byId && typeof byId === 'object') {
      for (const [id, value] of Object.entries(byId as Record<string, unknown>)) {
        if (id === 'codex') {
          continue;
        }
        const extra = parseCamelLimits(value);
        if (extra?.primary) {
          const rec = value as Record<string, unknown>;
          const name = typeof rec['limitName'] === 'string' ? rec['limitName'] : id;
          windows.push(toWindow(name, extra.primary));
        }
      }
    }

    if (limits.credits?.hasCredits) {
      windows.push({
        label: 'Credits',
        usedPercent: null,
        resetsAt: null,
        raw: `餘額 ${limits.credits.balance}${limits.credits.unlimited ? '（無上限）' : ''}`,
      });
    }

    const resetCredits = root['rateLimitResetCredits'];
    if (resetCredits && typeof resetCredits === 'object') {
      const rc = resetCredits as Record<string, unknown>;
      const available = typeof rc['availableCount'] === 'number' ? rc['availableCount'] : 0;
      if (available > 0) {
        windows.push({
          label: '用量重置點數',
          usedPercent: null,
          resetsAt: null,
          raw: `可用 ${available} 次（可在 ChatGPT 設定的「使用量」頁面使用）`,
        });
      }
    }

    const planName = limits.planType ? capitalize(limits.planType) : undefined;
    logger.debug('codex: 已由 app-server account/rateLimits/read 取得即時用量');
    return {
      provider: 'codex',
      status: 'ok',
      ...(planName !== undefined ? { account: planName, plan: planName } : {}),
      windows,
      fetchedAt: now,
      source: 'cli:app-server/account.rateLimits.read',
      message: '官方即時數字，由 Codex CLI 自己的 app-server 查詢取得，不消耗配額。',
    };
  }

  /** 探測未來可能出現的 `codex usage --json`。目前版本會回非 0 或印出 help。 */
  private async tryNativeUsage(cli: string, timeoutMs: number): Promise<UsageSnapshot | null> {
    const r = await run(cli, ['usage', '--json'], { timeoutMs });
    if (r.timedOut || r.failure || r.code !== 0) {
      return null;
    }
    const text = r.stdout.trim();
    if (!text.startsWith('{')) {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const limits = extractRateLimits(parsed);
      if (!limits) {
        return null;
      }
      const windows: UsageWindow[] = [];
      if (limits.primary) {
        windows.push(toWindow('5 小時', limits.primary));
      }
      if (limits.secondary) {
        windows.push(toWindow('每週', limits.secondary));
      }
      logger.info('codex: 偵測到原生的 usage --json 子指令，已優先使用');
      return {
        provider: 'codex',
        status: 'ok',
        windows,
        fetchedAt: new Date(),
        source: 'cli:usage-json',
        ...(limits.planType ? { plan: capitalize(limits.planType) } : {}),
      };
    } catch {
      return null;
    }
  }
}

interface LimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}

interface RateLimits {
  primary: LimitWindow | null;
  secondary: LimitWindow | null;
  planType: string | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  observedAt: Date;
}

function toWindow(label: string, w: LimitWindow): UsageWindow {
  return {
    label,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    raw: `used ${w.usedPercent}%${w.windowMinutes ? ` / window ${w.windowMinutes}m` : ''}`,
  };
}

function codexHome(): string {
  const env = process.env['CODEX_HOME'];
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.codex');
}

function listRolloutFiles(limit: number): string[] {
  const sessions = path.join(codexHome(), 'sessions');
  const files: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) {
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
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* 忽略讀不到的檔案 */
        }
      }
    }
  };
  walk(sessions, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => f.file);
}

/** 由新到舊掃描 rollout 檔，取出最後一筆 rate_limits。 */
function readLatestRateLimits(): RateLimits | null {
  for (const file of listRolloutFiles(12)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || !line.includes('"rate_limits"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const limits = extractRateLimits(parsed);
        if (limits) {
          const ts = findTimestamp(parsed);
          return { ...limits, observedAt: ts ?? new Date(fs.statSync(file).mtimeMs) };
        }
      } catch {
        /* 這一行不是合法 JSON，換下一行 */
      }
    }
  }
  return null;
}

function findTimestamp(obj: Record<string, unknown>): Date | null {
  const raw = obj['timestamp'];
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return null;
}

function extractRateLimits(root: Record<string, unknown>): Omit<RateLimits, 'observedAt'> | null {
  const node = deepFind(root, 'rate_limits');
  if (!node || typeof node !== 'object') {
    return null;
  }
  const rl = node as Record<string, unknown>;
  const primary = parseLimitWindow(rl['primary']);
  const secondary = parseLimitWindow(rl['secondary']);
  if (!primary && !secondary) {
    return null;
  }
  const creditsRaw = rl['credits'];
  let credits: RateLimits['credits'] = null;
  if (creditsRaw && typeof creditsRaw === 'object') {
    const c = creditsRaw as Record<string, unknown>;
    credits = {
      hasCredits: c['has_credits'] === true,
      unlimited: c['unlimited'] === true,
      balance: typeof c['balance'] === 'string' ? c['balance'] : String(c['balance'] ?? ''),
    };
  }
  return {
    primary,
    secondary,
    planType: typeof rl['plan_type'] === 'string' ? rl['plan_type'] : null,
    credits,
  };
}

/**
 * app-server 回傳的是 camelCase（usedPercent / windowDurationMins / resetsAt），
 * 而 rollout log 內是 snake_case，兩者要分開解析。
 */
function parseCamelLimits(value: unknown): Omit<RateLimits, 'observedAt'> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const rl = value as Record<string, unknown>;
  const primary = parseCamelWindow(rl['primary']);
  const secondary = parseCamelWindow(rl['secondary']);
  if (!primary && !secondary) {
    return null;
  }
  const creditsRaw = rl['credits'];
  let credits: RateLimits['credits'] = null;
  if (creditsRaw && typeof creditsRaw === 'object') {
    const c = creditsRaw as Record<string, unknown>;
    credits = {
      hasCredits: c['hasCredits'] === true,
      unlimited: c['unlimited'] === true,
      balance: typeof c['balance'] === 'string' ? c['balance'] : String(c['balance'] ?? ''),
    };
  }
  return {
    primary,
    secondary,
    planType: typeof rl['planType'] === 'string' ? rl['planType'] : null,
    credits,
  };
}

function parseCamelWindow(value: unknown): LimitWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  const used = v['usedPercent'];
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return null;
  }
  const resets = v['resetsAt'];
  const windowMinutes = typeof v['windowDurationMins'] === 'number' ? v['windowDurationMins'] : null;
  return {
    usedPercent: used,
    windowMinutes,
    resetsAt: typeof resets === 'number' && resets > 0 ? new Date(resets * 1000) : null,
  };
}

function parseLimitWindow(value: unknown): LimitWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  const used = v['used_percent'];
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return null;
  }
  const resets = v['resets_at'];
  const windowMinutes = typeof v['window_minutes'] === 'number' ? v['window_minutes'] : null;
  return {
    usedPercent: used,
    windowMinutes,
    resetsAt: typeof resets === 'number' && resets > 0 ? new Date(resets * 1000) : null,
  };
}

/** 在巢狀物件中找出第一個指定 key 的值。 */
function deepFind(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || !obj || typeof obj !== 'object') {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (key in rec) {
    return rec[key];
  }
  for (const value of Object.values(rec)) {
    const found = deepFind(value, key, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function estimateFromRollouts(): { totalTokens: number; sessions: number } | null {
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  let totalTokens = 0;
  let sessions = 0;
  for (const file of listRolloutFiles(20)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let best = 0;
    for (const line of text.split('\n')) {
      if (!line.includes('total_token_usage')) {
        continue;
      }
      const m = /"total_token_usage":\{[^}]*"total_tokens":(\d+)/.exec(line);
      const n = m?.[1] ? Number.parseInt(m[1], 10) : 0;
      if (n > best) {
        best = n;
      }
    }
    if (best > 0) {
      totalTokens += best;
      sessions += 1;
    }
  }
  return sessions > 0 ? { totalTokens, sessions } : null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
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
