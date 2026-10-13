import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { markStaleness, STALE_AFTER_MS, type UsageProvider, type UsageSnapshot, type UsageWindow } from '../types';
import { jsonRpcStdio, run } from '../util/exec';
import { resolveCli } from '../util/cliResolver';
import { capitalize, formatAge, formatLocal, readTail } from '../util/format';
import { EXTENSION_VERSION } from '../version';

/**
 * OpenAI Codex provider。
 *
 * 偵察結論（codex-cli 0.151.0-alpha.7.1）：
 * - `codex --help` 沒有 usage 子指令；/status 與 /usage 只存在於 TUI 內
 * - `codex app-server` 的 account/rateLimits/read 回傳官方即時值，且不消耗配額
 * - `codex login status` 可判斷登入狀態，但沒有 --json
 * - 官方百分比也會被寫進本機 rollout log：
 *   CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 的 token_count 事件
 *   帶有 rate_limits.{primary,secondary,credits,plan_type}，
 *   primary = 5 小時窗（window_minutes 300），secondary = 每週窗（10080）。
 *
 * 因此降級鏈為：
 *   1. `codex app-server` account/rateLimits/read（官方、即時）
 *   2. `codex login status` 判定登入
 *   3. 讀最新 rollout jsonl 的 rate_limits（官方數字，純本機，不發網路請求）
 *   4. 本地 token 加總估算
 */
export class CodexProvider implements UsageProvider {
  readonly id = 'codex' as const;

  loginCommand(): string {
    return 'codex login';
  }

  async fetch(): Promise<UsageSnapshot> {
    const cfg = readConfig();
    const now = new Date();
    const cli = await resolveCli('codex', cfg.codexCliPath, ['--version'], cfg.commandTimeoutMs);

    if (!cli) {
      return {
        provider: 'codex',
        status: 'cli_not_found',
        windows: [],
        fetchedAt: now,
        source: 'cli-resolver',
        message: t(
          '找不到 codex CLI。可在設定 quotaDeck.codex.cliPath 指定完整路徑。',
          'Could not find the codex CLI. Set quotaDeck.codex.cliPath to its full path.'
        ),
      };
    }

    // 1) app-server 的 account/rateLimits/read —— 官方、即時、不消耗配額
    const live = await this.tryAppServer(cli, Math.max(cfg.commandTimeoutMs, 20000), now);
    if (live) {
      return live;
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
        message: t('尚未登入 Codex。', 'Not signed in to Codex.'),
      };
    }
    if (login.timedOut || login.failure) {
      return {
        provider: 'codex',
        status: 'error',
        windows: [],
        fetchedAt: now,
        source: 'cli:login-status',
        message: login.timedOut
          ? t('codex login status 逾時。', 'codex login status timed out.')
          : t('無法執行 codex login status。', 'Could not run codex login status.'),
      };
    }

    const account = /logged in using (.+)/i.exec(loginText)?.[1]?.trim();

    // 3) 本機 rollout log 內的官方 rate_limits
    try {
      const local = await readLatestRateLimits();
      if (local) {
        const windows = limitsToWindows(local);
        const ageMs = now.getTime() - local.observedAt.getTime();
        const planName = local.planType ? capitalize(local.planType) : undefined;
        const snapshot: UsageSnapshot = {
          provider: 'codex',
          status: 'ok',
          windows: markStaleness(windows, local.observedAt, now),
          fetchedAt: now,
          source: 'local-logs:rollout-rate-limits',
          message:
            ageMs > STALE_AFTER_MS
              ? t(
                  `⚠️ 這些百分比是 ${formatLocal(local.observedAt)}（${formatAge(ageMs)}前）Codex 寫下的快照，不是當下的值。` +
                    'Codex 只有在你實際使用它的時候才會把新的 rate_limits 寫進本機紀錄。' +
                    '在 Codex 內送出一則訊息後再回來按重新整理，數字就會跟上。',
                  `⚠️ These percentages are a snapshot Codex wrote at ${formatLocal(local.observedAt)} (${formatAge(ageMs)} ago), not current values. ` +
                    'Codex only writes new rate_limits to its local logs while you use it. ' +
                    'Send a message in Codex, then refresh here to catch up.'
                )
              : t(
                  `官方數字，取自 Codex 本機工作階段紀錄（寫入於 ${formatLocal(local.observedAt)}）。`,
                  `Official numbers from Codex local session logs (written ${formatLocal(local.observedAt)}).`
                ),
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
        message: t(
          'quotaDeck.codex.allowDirectApi 已開啟，但目前沒有經過驗證的公開 rate limit endpoint，' +
            '本套件不會去猜測未公開的 API。請先在 Codex 內互動一次，讓它把官方數字寫進本機紀錄。',
          'quotaDeck.codex.allowDirectApi is on, but there is no verified public rate limit endpoint, ' +
            'and this extension will not guess at undocumented APIs. Use Codex once so it writes official numbers to its local logs.'
        ),
      };
    }

    // 4) 本地估算
    const estimate = await estimateFromRollouts();
    return {
      provider: 'codex',
      status: 'ok',
      ...(account !== undefined ? { account } : {}),
      windows: estimate
        ? [
            {
              label: t('本地估算', 'Local estimate'),
              usedPercent: null,
              resetsAt: null,
              raw: t(
                `近 5 小時約 ${estimate.totalTokens.toLocaleString()} tokens（${estimate.sessions} 個工作階段）`,
                `~${estimate.totalTokens.toLocaleString()} tokens in the last 5 hours (${estimate.sessions} sessions)`
              ),
            },
          ]
        : [],
      fetchedAt: now,
      source: 'local-logs:estimate',
      message: t(
        '本機紀錄中尚未出現官方 rate_limits（通常代表這個版本還沒寫入，或最近沒有使用過）。此處僅為本地 token 估算，非官方百分比。',
        'No official rate_limits in local logs yet (this version may not write them, or Codex has not been used recently). This is only a local token estimate, not an official percentage.'
      ),
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
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'quota-deck', version: EXTENSION_VERSION } } },
      { id: 2, method: 'account/rateLimits/read' },
      2,
      timeoutMs
    );
    if (!result || typeof result !== 'object') {
      return null;
    }
    const parsed = parseAppServerRateLimits(result as Record<string, unknown>);
    if (!parsed) {
      return null;
    }

    logger.debug('codex: 已由 app-server account/rateLimits/read 取得即時用量');
    return {
      provider: 'codex',
      status: 'ok',
      ...(parsed.planName !== undefined ? { account: parsed.planName, plan: parsed.planName } : {}),
      windows: parsed.windows,
      fetchedAt: now,
      source: 'cli:app-server/account.rateLimits.read',
      message: t(
        '官方即時數字，由 Codex CLI 自己的 app-server 查詢取得，不消耗配額。',
        "Official live numbers from the Codex CLI's own app-server query; does not consume quota."
      ),
    };
  }
}

interface LimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}

export interface RateLimits {
  primary: LimitWindow | null;
  secondary: LimitWindow | null;
  planType: string | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
}

function toWindow(label: string, w: LimitWindow): UsageWindow {
  return {
    label,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    raw: `used ${w.usedPercent}%${w.windowMinutes ? ` / window ${w.windowMinutes}m` : ''}`,
  };
}

function creditsWindow(credits: NonNullable<RateLimits['credits']>): UsageWindow {
  return {
    label: 'Credits',
    usedPercent: null,
    resetsAt: null,
    raw: t(
      `餘額 ${credits.balance}${credits.unlimited ? '（無上限）' : ''}`,
      `balance ${credits.balance}${credits.unlimited ? ' (unlimited)' : ''}`
    ),
  };
}

function limitsToWindows(limits: RateLimits): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (limits.primary) {
    windows.push(toWindow(t('5 小時', '5 hours'), limits.primary));
  }
  if (limits.secondary) {
    windows.push(toWindow(t('每週', 'Weekly'), limits.secondary));
  }
  if (limits.credits?.hasCredits) {
    windows.push(creditsWindow(limits.credits));
  }
  return windows;
}

/** 解析 app-server 的 account/rateLimits/read 結果。 */
export function parseAppServerRateLimits(
  root: Record<string, unknown>
): { windows: UsageWindow[]; planName?: string } | null {
  const limits = parseCamelLimits(root['rateLimits']);
  if (!limits) {
    return null;
  }

  const windows: UsageWindow[] = [];
  if (limits.primary) {
    windows.push(toWindow(t('5 小時', '5 hours'), limits.primary));
  }
  if (limits.secondary) {
    windows.push(toWindow(t('每週', 'Weekly'), limits.secondary));
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
    windows.push(creditsWindow(limits.credits));
  }

  const resetCredits = root['rateLimitResetCredits'];
  if (resetCredits && typeof resetCredits === 'object') {
    const rc = resetCredits as Record<string, unknown>;
    const available = typeof rc['availableCount'] === 'number' ? rc['availableCount'] : 0;
    if (available > 0) {
      windows.push({
        label: t('用量重置點數', 'Usage reset credits'),
        usedPercent: null,
        resetsAt: null,
        raw: t(
          `可用 ${available} 次（可在 ChatGPT 設定的「使用量」頁面使用）`,
          `${available} available (use them on the Usage page in ChatGPT settings)`
        ),
      });
    }
  }

  const planName = limits.planType ? capitalize(limits.planType) : undefined;
  return planName !== undefined ? { windows, planName } : { windows };
}

function codexHome(): string {
  const env = process.env['CODEX_HOME'];
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.codex');
}

async function listRolloutFiles(limit: number): Promise<{ file: string; mtime: number }[]> {
  const sessions = path.join(codexHome(), 'sessions');
  const files: { file: string; mtime: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          files.push({ file: full, mtime: (await fs.promises.stat(full)).mtimeMs });
        } catch {
          /* 忽略讀不到的檔案 */
        }
      }
    }
  };
  await walk(sessions, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

/**
 * rate_limits 與 total_token_usage 都是每一輪都會寫的事件，
 * 最新一筆一定在檔尾，讀最後 1 MB 就足夠，不必把整個 rollout 讀進來。
 */
const ROLLOUT_TAIL_BYTES = 1024 * 1024;

/** 由新到舊掃描 rollout 檔，取出最後一筆 rate_limits。 */
async function readLatestRateLimits(): Promise<(RateLimits & { observedAt: Date }) | null> {
  for (const { file, mtime } of await listRolloutFiles(12)) {
    let text: string;
    try {
      text = await readTail(file, ROLLOUT_TAIL_BYTES);
    } catch {
      continue;
    }
    const found = findLatestRateLimits(text);
    if (found) {
      return { ...found.limits, observedAt: found.timestamp ?? new Date(mtime) };
    }
  }
  return null;
}

/** 從 rollout 文字的最後一行往前找第一筆可解析的 rate_limits。 */
export function findLatestRateLimits(text: string): { limits: RateLimits; timestamp: Date | null } | null {
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
        return { limits, timestamp: findTimestamp(parsed) };
      }
    } catch {
      /* 這一行不是合法 JSON（或是被 readTail 切掉的殘行），換下一行 */
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

/** rollout log 內的 snake_case rate_limits。 */
export function extractRateLimits(root: Record<string, unknown>): RateLimits | null {
  const node = deepFind(root, 'rate_limits');
  if (!node || typeof node !== 'object') {
    return null;
  }
  const rl = node as Record<string, unknown>;
  const primary = parseLimitWindow(rl['primary'], 'used_percent', 'window_minutes', 'resets_at');
  const secondary = parseLimitWindow(rl['secondary'], 'used_percent', 'window_minutes', 'resets_at');
  if (!primary && !secondary) {
    return null;
  }
  return {
    primary,
    secondary,
    planType: typeof rl['plan_type'] === 'string' ? rl['plan_type'] : null,
    credits: parseCredits(rl['credits'], 'has_credits'),
  };
}

/**
 * app-server 回傳的是 camelCase（usedPercent / windowDurationMins / resetsAt），
 * 而 rollout log 內是 snake_case，兩者欄位名稱不同、結構相同。
 */
export function parseCamelLimits(value: unknown): RateLimits | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const rl = value as Record<string, unknown>;
  const primary = parseLimitWindow(rl['primary'], 'usedPercent', 'windowDurationMins', 'resetsAt');
  const secondary = parseLimitWindow(rl['secondary'], 'usedPercent', 'windowDurationMins', 'resetsAt');
  if (!primary && !secondary) {
    return null;
  }
  return {
    primary,
    secondary,
    planType: typeof rl['planType'] === 'string' ? rl['planType'] : null,
    credits: parseCredits(rl['credits'], 'hasCredits'),
  };
}

function parseCredits(value: unknown, hasCreditsKey: string): RateLimits['credits'] {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const c = value as Record<string, unknown>;
  return {
    hasCredits: c[hasCreditsKey] === true,
    unlimited: c['unlimited'] === true,
    balance: typeof c['balance'] === 'string' ? c['balance'] : String(c['balance'] ?? ''),
  };
}

function parseLimitWindow(value: unknown, usedKey: string, minutesKey: string, resetsKey: string): LimitWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  const used = v[usedKey];
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return null;
  }
  const resets = v[resetsKey];
  const windowMinutes = typeof v[minutesKey] === 'number' ? v[minutesKey] : null;
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

async function estimateFromRollouts(): Promise<{ totalTokens: number; sessions: number } | null> {
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  let totalTokens = 0;
  let sessions = 0;
  for (const { file, mtime } of await listRolloutFiles(20)) {
    if (mtime < cutoff) {
      continue;
    }
    let text: string;
    try {
      // total_token_usage 是累計值，最後一筆就是最大值，只需讀檔尾
      text = await readTail(file, ROLLOUT_TAIL_BYTES);
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
