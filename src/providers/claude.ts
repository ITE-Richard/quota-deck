import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { logger } from '../logger';
import {
  markStaleness,
  STALE_AFTER_MS,
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
        message: '找不到 claude CLI。可在設定 quotaDeck.claude.cliPath 指定完整路徑。',
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

    // 2) Claude Code 官方用量快取（優先讀取 ~/.claude/usage_snapshot.json 與 ~/.claude.json，取較新者）
    try {
      const utilJson = readCachedUtilization();
      const utilSnap = readUsageSnapshotFile();
      let chosenUtil: CachedUtilization | null = null;
      let chosenSource = 'local-cache:claude.json';

      if (utilJson && utilSnap) {
        if (utilSnap.dataAt.getTime() >= utilJson.dataAt.getTime()) {
          chosenUtil = utilSnap;
          chosenSource = 'local-snapshot:usage_snapshot.json';
        } else {
          chosenUtil = utilJson;
          chosenSource = 'local-cache:claude.json';
        }
      } else if (utilSnap) {
        chosenUtil = utilSnap;
        chosenSource = 'local-snapshot:usage_snapshot.json';
      } else if (utilJson) {
        chosenUtil = utilJson;
        chosenSource = 'local-cache:claude.json';
      }

      // 若快取不存在或已過期（超過 15 分鐘），且開啟了自動探測，則在背景自動執行一次 Haiku probe
      const isStale = chosenUtil ? now.getTime() - chosenUtil.dataAt.getTime() > STALE_AFTER_MS : true;
      if ((!chosenUtil || isStale) && cfg.claudeAutoProbeOnStale) {
        logger.info('claude: 用量快取不存在或已過期，自動於背景執行 Haiku probe...');
        const probeRes = await probeClaude(cli, 60000);
        if (probeRes.success) {
          const freshSnap = readUsageSnapshotFile();
          if (freshSnap) {
            chosenUtil = freshSnap;
            chosenSource = 'local-snapshot:usage_snapshot.json (auto-probe)';
          }
        }
      }

      if (chosenUtil && chosenUtil.windows.length > 0) {
        const ageMs = now.getTime() - chosenUtil.dataAt.getTime();
        const currentStale = ageMs > STALE_AFTER_MS;
        const isSnap = chosenSource.includes('snapshot') || chosenSource.includes('probe');
        return {
          provider: 'claude',
          status: 'ok',
          ...(account !== undefined ? { account } : {}),
          ...(plan !== undefined ? { plan } : {}),
          windows: markStaleness(chosenUtil.windows, chosenUtil.dataAt, now, STALE_AFTER_MS),
          fetchedAt: now,
          source: `cli:auth-status + ${chosenSource}`,
          message: currentStale
            ? `⚠️ 這是 ${formatLocal(chosenUtil.dataAt)}（${formatAge(ageMs)}前）的快照，已超過 15 分鐘。可點擊「背景探測即時額度」取得最新官方數值。`
            : isSnap
            ? `官方即時數字，取自 Claude 背景探測 / statusline 快照（更新於 ${formatLocal(chosenUtil.dataAt)}）。`
            : `官方數字，取自 ~/.claude.json（寫入於 ${formatLocal(chosenUtil.dataAt)}）。`,
        };
      }
    } catch (err) {
      logger.error('claude: 讀取用量快取失敗', err);
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
        'Claude Code 本機尚未有官方用量快取可讀，此處僅為本地紀錄估算。' +
        '可點擊「背景探測即時額度」由背景直接取得官方即時百分比。',
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
      clearInterval(fallbackPoller);
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
    // fs.watch 在 Claude 以暫存檔取代 .claude.json 時，可能只送出 rename，
    // 而且事件有機會發生在檔案完全寫好之前。這個短期輪詢只會在使用者明確
    // 按下 /usage 後、等待結果的這段時間存在，用來補掉遺失或過早的事件。
    const fallbackPoller = setInterval(check, 500);

    for (const target of targets) {
      try {
        watchers.push(fs.watch(target, { persistent: false }, () => check()));
      } catch {
        /* 該路徑不存在或不支援監看，靠另一個 */
      }
    }

    if (watchers.length === 0) {
      logger.debug('claude: 無法監看用量快取，改用短期輪詢等待 /usage 結果');
    }

    // 補掉 sendText('/usage') 與 watcher 建立之間快取已經更新的競態。
    check();
  });
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '工作階段（5 小時）',
  seven_day: '每週（7 天）',
  seven_day_opus: '每週（Opus）',
  seven_day_sonnet: '每週（Sonnet）',
  seven_day_oauth_apps: '每週（OAuth apps）',
  seven_day_cowork: '每週（Cowork）',
};

const LIMIT_KIND_LABELS: Record<string, string> = {
  session: WINDOW_LABELS['five_hour'] ?? '工作階段（5 小時）',
  weekly_all: WINDOW_LABELS['seven_day'] ?? '每週（7 天）',
  weekly_opus: WINDOW_LABELS['seven_day_opus'] ?? '每週（Opus）',
  weekly_sonnet: WINDOW_LABELS['seven_day_sonnet'] ?? '每週（Sonnet）',
  weekly_oauth_apps: WINDOW_LABELS['seven_day_oauth_apps'] ?? '每週（OAuth apps）',
  weekly_cowork: WINDOW_LABELS['seven_day_cowork'] ?? '每週（Cowork）',
};

const LIMIT_KIND_LEGACY_KEYS: Record<string, string> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly_opus: 'seven_day_opus',
  weekly_sonnet: 'seven_day_sonnet',
  weekly_oauth_apps: 'seven_day_oauth_apps',
  weekly_cowork: 'seven_day_cowork',
};

export interface CachedUtilization {
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

  return parseCachedUsageUtilization(parsed['cachedUsageUtilization']);
}

/** 讀取 ~/.claude/usage_snapshot.json（由 Agora、Claude statusline 或背景 probe 寫入）。 */
export function readUsageSnapshotFile(): CachedUtilization | null {
  const snapshotPath = path.join(os.homedir(), '.claude', 'usage_snapshot.json');
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const updatedAt = typeof parsed['updated_at'] === 'number' ? parsed['updated_at'] : null;
    const dataAt = updatedAt ? new Date(updatedAt * 1000) : new Date(0);
    const windows: UsageWindow[] = [];

    const fiveHour = parsed['five_hour'] as Record<string, unknown> | undefined;
    if (fiveHour && typeof fiveHour === 'object') {
      const used = finiteNumber(fiveHour['used_percentage']);
      if (used !== null) {
        const resetsAt = parseResetTime(fiveHour['resets_at']);
        windows.push({
          label: WINDOW_LABELS['five_hour'] ?? '工作階段（5 小時）',
          usedPercent: clampPercent(used),
          resetsAt,
          raw: `five_hour: ${used}% 已使用`,
        });
      }
    }

    const sevenDay = parsed['seven_day'] as Record<string, unknown> | undefined;
    if (sevenDay && typeof sevenDay === 'object') {
      const used = finiteNumber(sevenDay['used_percentage']);
      if (used !== null) {
        const resetsAt = parseResetTime(sevenDay['resets_at']);
        windows.push({
          label: WINDOW_LABELS['seven_day'] ?? '每週（7 天）',
          usedPercent: clampPercent(used),
          resetsAt,
          raw: `seven_day: ${used}% 已使用`,
        });
      }
    }

    if (windows.length === 0) {
      return null;
    }
    return {
      dataAt,
      windows,
    };
  } catch {
    return null;
  }
}

/** 寫入 ~/.claude/usage_snapshot.json（格式與 Agora、Claude statusline 完全相容）。 */
export function saveUsageSnapshotFile(
  windows: { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null }[],
  source: string
): void {
  const snapshotPath = path.join(os.homedir(), '.claude', 'usage_snapshot.json');
  const obj: Record<string, unknown> = {
    updated_at: Math.floor(Date.now() / 1000),
    source,
  };
  for (const w of windows) {
    obj[w.key] = {
      used_percentage: w.usedPercentage,
      resets_at: w.resetsAt ? Math.floor(w.resetsAt.getTime() / 1000) : null,
    };
  }
  try {
    const dir = path.dirname(snapshotPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${snapshotPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, snapshotPath);
  } catch (err) {
    logger.warn(`claude: 寫入 ~/.claude/usage_snapshot.json 失敗 — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ProbeResult {
  success: boolean;
  message?: string;
  windows?: { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null }[];
}

/** stream-json 的 rate_limit_info → 解析成 5 小時 / 7 天視窗（utilization 是 0~1 的比例）。 */
export function parseRateLimitInfo(
  info: Record<string, unknown>
): { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null }[] {
  const results: { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null }[] = [];
  const unified = info['unifiedWindows'] as Record<string, unknown> | undefined;
  if (unified && typeof unified === 'object') {
    for (const key of ['five_hour', 'seven_day'] as const) {
      const w = unified[key] as Record<string, unknown> | undefined;
      if (w && typeof w === 'object' && typeof w['utilization'] === 'number') {
        const resetsAt = parseResetTime(w['resetsAt'] ?? w['resets_at']);
        results.push({
          key,
          usedPercentage: Math.round(w['utilization'] * 1000) / 10,
          resetsAt,
        });
      }
    }
  }
  if (results.length === 0) {
    const type = info['rateLimitType'];
    const util = info['utilization'];
    if ((type === 'five_hour' || type === 'seven_day') && typeof util === 'number') {
      const resetsAt = parseResetTime(info['resetsAt'] ?? info['resets_at']);
      results.push({
        key: type,
        usedPercentage: Math.round(util * 1000) / 10,
        resetsAt,
      });
    }
  }
  return results;
}

/**
 * 以 Haiku 執行極短的 stream-json 請求探測即時額度，攔截 rate_limit_event。
 *
 * 不開啟終端機、不打擾使用者，僅消耗約 2 個 Haiku tokens。
 */
export async function probeClaude(cli: string, timeoutMs: number = 60000): Promise<ProbeResult> {
  const args = [
    '-p',
    'ok',
    '--model',
    'haiku',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--no-session-persistence',
    '--settings',
    '{"disableAllHooks": true}',
  ];

  const claudeDir = path.join(os.homedir(), '.claude');
  const cwd = fs.existsSync(claudeDir) ? claudeDir : os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGORA_PROBE: '1',
    CLAUDE_PROBE: '1',
  };

  logger.info(`正在執行 Claude 背景探測 (Haiku probe): ${cli}`);
  const r = await run(cli, args, { timeoutMs, cwd, env });

  if (r.timedOut) {
    return { success: false, message: '背景探測請求逾時。' };
  }

  let foundWindows: { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null }[] | null = null;

  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event['type'] === 'rate_limit_event') {
        const info = event['rate_limit_info'] as Record<string, unknown> | undefined;
        if (info) {
          const windows = parseRateLimitInfo(info);
          if (windows.length > 0) {
            foundWindows = windows;
            break;
          }
        }
      }
    } catch {
      // 忽略單行 JSON 解析錯誤
    }
  }

  if (foundWindows && foundWindows.length > 0) {
    saveUsageSnapshotFile(foundWindows, 'probe');
    logger.info('Claude 背景探測成功，已更新 ~/.claude/usage_snapshot.json');
    return { success: true, windows: foundWindows };
  }

  const errText = r.stderr.trim() || r.stdout.trim().slice(-200);
  return {
    success: false,
    message: errText || '未在輸出中收到 rate_limit_event。',
  };
}

/** 將 Claude Code 寫入的 cachedUsageUtilization 轉成共用的用量視窗。 */
export function parseCachedUsageUtilization(cached: unknown): CachedUtilization | null {
  if (!cached || typeof cached !== 'object') {
    return null;
  }
  const c = cached as Record<string, unknown>;
  const fetchedAtMs = finiteNumber(c['fetchedAtMs']);
  const util = c['utilization'];
  if (!util || typeof util !== 'object') {
    return null;
  }
  const u = util as Record<string, unknown>;

  // Claude Code 2.1.263 起 /usage 的主要顯示資料放在 limits[]；舊的
  // five_hour / seven_day 節點目前仍可能存在，但只是相容欄位。優先解析
  // limits[]，再用舊欄位補齊缺少的視窗，避免同一額度顯示兩次。
  const windows: UsageWindow[] = [];
  const coveredLegacyKeys = new Set<string>();
  const limits = u['limits'];
  if (Array.isArray(limits)) {
    for (const value of limits) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const limit = value as Record<string, unknown>;
      const percent = finiteNumber(limit['percent']);
      if (percent === null) {
        continue;
      }
      const kind = typeof limit['kind'] === 'string' ? limit['kind'] : '';
      const group = typeof limit['group'] === 'string' ? limit['group'] : '';
      const legacyKey = LIMIT_KIND_LEGACY_KEYS[kind];
      if (legacyKey !== undefined) {
        coveredLegacyKeys.add(legacyKey);
      }
      windows.push({
        label: LIMIT_KIND_LABELS[kind] ?? formatLimitLabel(kind || group),
        usedPercent: clampPercent(percent),
        resetsAt: parseResetTime(limit['resets_at'] ?? limit['resetsAt']),
        raw: `${kind || group || 'limit'}: ${percent}% 已使用`,
      });
    }
  }

  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    if (coveredLegacyKeys.has(key)) {
      continue;
    }
    const node = u[key];
    if (!node || typeof node !== 'object') {
      continue;
    }
    const n = node as Record<string, unknown>;
    const percent = finiteNumber(n['utilization']);
    if (percent === null) {
      continue;
    }
    windows.push({
      label,
      usedPercent: clampPercent(percent),
      resetsAt: parseResetTime(n['resets_at'] ?? n['resetsAt']),
      raw: `${key}: ${percent}% 已使用`,
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

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseResetTime(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const num = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : value;
  const parsed = new Date(num);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLimitLabel(kind: string): string {
  if (kind === '') {
    return 'Claude 用量';
  }
  return kind
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
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
