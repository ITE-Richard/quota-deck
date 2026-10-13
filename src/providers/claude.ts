import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { t } from '../i18n';
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
import { clampPercent, finiteNumber, formatAge, formatLocal, readTail } from '../util/format';

/**
 * Claude Code provider。
 *
 * 偵察結論（Claude Code 2.1.251）：
 * - `claude auth status --json` 可用，回 loggedIn / email / orgName / subscriptionType
 * - `claude --help` 的子指令清單中沒有 usage；/usage 只存在於互動式 REPL
 * - ~/.claude.json 內有 cachedUsageUtilization，是 Claude Code 自己寫下的
 *   官方百分比快取（five_hour / seven_day / limits[]），此檔不含任何 token
 * - ~/.claude/usage_snapshot.json 由 statusline、Agora 或本套件的 Haiku probe 寫入
 *
 * 降級鏈：
 *   1. claude auth status --json                         → 登入狀態、帳號、方案
 *   2. usage_snapshot.json 與 ~/.claude.json 取較新者，    → 官方百分比（快取，須標示資料時間）
 *      較舊那份只用來補齊較新那份沒有的視窗
 *   3. （選用）快取過期時以 Haiku probe 取得即時值         → 會發出一次 API 請求並計入用量
 *   4. ~/.claude/projects 內的 jsonl                     → 本地 token 估算
 *
 * 明確不做：讀取 ~/.claude/.credentials.json 的 accessToken 去呼叫
 * Anthropic 的非公開 OAuth usage endpoint。該 token 依 Anthropic Consumer ToS
 * 僅限 Claude Code 與 Claude.ai 使用，第三方工具使用可能導致帳號停權。
 * probe 走的是官方 claude CLI 本身，不碰任何 token。
 */
export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude' as const;

  loginCommand(): string {
    return 'claude auth login';
  }

  async fetch(): Promise<UsageSnapshot> {
    const cfg = readConfig();
    const now = new Date();
    const cli = await resolveClaudeCli();

    if (!cli) {
      return {
        provider: 'claude',
        status: 'cli_not_found',
        windows: [],
        fetchedAt: now,
        source: 'cli-resolver',
        message: t(
          '找不到 claude CLI。可在設定 quotaDeck.claude.cliPath 指定完整路徑。',
          'Could not find the claude CLI. Set quotaDeck.claude.cliPath to its full path.'
        ),
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
        message: t('尚未登入 Claude Code。', 'Not signed in to Claude Code.'),
      };
    }

    const account = auth.email ?? auth.orgName;
    const plan = auth.subscriptionType ? formatPlan(auth.subscriptionType) : undefined;
    const identity = {
      ...(account !== undefined ? { account } : {}),
      ...(plan !== undefined ? { plan } : {}),
    };

    // 2) Claude Code 官方用量快取
    let probeFailure: string | null = null;
    try {
      let sources = await readUsageSources();

      // 3) 快取不存在或過期，且使用者明確開啟自動 probe 時，才發出一次 API 請求
      const newest = sources[0];
      const isStale = newest ? now.getTime() - newest.dataAt.getTime() > STALE_AFTER_MS : true;
      if (isStale && cfg.claudeAutoProbeOnStale) {
        logger.info('claude: 用量快取不存在或已過期，依設定於背景執行 Haiku probe');
        const probe = await probeClaude(cli);
        if (probe.success) {
          sources = await readUsageSources();
        } else {
          probeFailure = probe.message ?? t('未知原因', 'unknown reason');
        }
      }

      const primary = sources[0];
      if (primary) {
        const ageMs = now.getTime() - primary.dataAt.getTime();
        const failureNote = probeFailure
          ? t(`自動背景探測失敗：${probeFailure}。`, `Automatic background probe failed: ${probeFailure}. `)
          : '';
        return {
          provider: 'claude',
          status: 'ok',
          ...identity,
          windows: combineUsageSources(sources, now),
          fetchedAt: now,
          source: `cli:auth-status + ${contributingOrigins(sources).join(' + ')}`,
          message:
            failureNote +
            (ageMs > STALE_AFTER_MS
              ? t(
                  `⚠️ 這是 ${formatLocal(primary.dataAt)}（${formatAge(ageMs)}前）的快照，已超過 15 分鐘。可點擊「背景探測即時額度」取得最新官方數值。`,
                  `⚠️ This snapshot is from ${formatLocal(primary.dataAt)} (${formatAge(ageMs)} ago), older than 15 minutes. Click "Probe live quota" to get the latest official numbers.`
                )
              : primary.origin === 'local-snapshot:usage_snapshot.json'
                ? t(
                    `官方數字，取自 Claude 背景探測 / statusline 快照（更新於 ${formatLocal(primary.dataAt)}）。`,
                    `Official numbers from the Claude background probe / statusline snapshot (updated ${formatLocal(primary.dataAt)}).`
                  )
                : t(
                    `官方數字，取自 ~/.claude.json（寫入於 ${formatLocal(primary.dataAt)}）。`,
                    `Official numbers from ~/.claude.json (written ${formatLocal(primary.dataAt)}).`
                  )),
        };
      }
    } catch (err) {
      logger.error('claude: 讀取用量快取失敗', err);
    }

    // 4) 本地紀錄估算
    let estimateWindow: UsageWindow | null = null;
    try {
      const est = await estimateFromTranscripts();
      if (est) {
        estimateWindow = {
          label: t('近 5 小時（本地紀錄估算）', 'Last 5 hours (local estimate)'),
          usedPercent: null,
          resetsAt: null,
          raw: t(
            `約 ${est.totalTokens.toLocaleString()} tokens / ${est.messages} 則訊息（${est.files} 個對話檔）`,
            `~${est.totalTokens.toLocaleString()} tokens / ${est.messages} messages (${est.files} transcript files)`
          ),
        };
      }
    } catch (err) {
      logger.error('claude: 掃描本機對話紀錄失敗', err);
    }

    return {
      provider: 'claude',
      status: 'ok',
      ...identity,
      windows: estimateWindow ? [estimateWindow] : [],
      fetchedAt: now,
      source: 'cli:auth-status + local-logs:estimate',
      message:
        (probeFailure
          ? t(`自動背景探測失敗：${probeFailure}。`, `Automatic background probe failed: ${probeFailure}. `)
          : '') +
        t(
          'Claude Code 本機尚未有官方用量快取可讀，此處僅為本地紀錄估算。可點擊「背景探測即時額度」取得官方即時百分比。',
          'No official usage cache from Claude Code yet; this is only a local estimate. Click "Probe live quota" to get the official live percentage.'
        ),
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
      return { kind: 'error', message: t('claude auth status 逾時。', 'claude auth status timed out.') };
    }
    const text = r.stdout.trim();
    if (!text.startsWith('{')) {
      // 舊版沒有 --json 時會印出 help 或純文字
      if (/not logged in|logged out/i.test(`${r.stdout}${r.stderr}`)) {
        return { kind: 'logged_out' };
      }
      return {
        kind: 'error',
        message: t(
          'claude auth status --json 沒有回傳 JSON，可能是 CLI 版本過舊。',
          'claude auth status --json did not return JSON; the CLI may be too old.'
        ),
      };
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
      return {
        kind: 'error',
        message: t('無法解析 claude auth status --json 的輸出。', 'Could not parse claude auth status --json output.'),
      };
    }
  }
}

export async function resolveClaudeCli(): Promise<string | null> {
  const cfg = readConfig();
  return resolveCli('claude', cfg.claudeCliPath, ['--version'], cfg.commandTimeoutMs);
}

type WindowKey = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_oauth_apps' | 'seven_day_cowork';

/** 用詞刻意對齊 Claude Code /usage 面板的 Session (5hr) / Weekly (7 day)。 */
function windowLabel(key: string): string | undefined {
  switch (key) {
    case 'five_hour':
      return t('工作階段（5 小時）', 'Session (5 hr)');
    case 'seven_day':
      return t('每週（7 天）', 'Weekly (7 day)');
    case 'seven_day_opus':
      return t('每週（Opus）', 'Weekly (Opus)');
    case 'seven_day_sonnet':
      return t('每週（Sonnet）', 'Weekly (Sonnet)');
    case 'seven_day_oauth_apps':
      return t('每週（OAuth apps）', 'Weekly (OAuth apps)');
    case 'seven_day_cowork':
      return t('每週（Cowork）', 'Weekly (Cowork)');
    default:
      return undefined;
  }
}

const LEGACY_KEYS: readonly WindowKey[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
  'seven_day_cowork',
];

/** limits[].kind → 舊版欄位名稱；兩種格式共用同一組顯示名稱與合併鍵。 */
const LIMIT_KIND_LEGACY_KEYS: Record<string, WindowKey> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly_opus: 'seven_day_opus',
  weekly_sonnet: 'seven_day_sonnet',
  weekly_oauth_apps: 'seven_day_oauth_apps',
  weekly_cowork: 'seven_day_cowork',
};

/** 帶有穩定合併鍵的視窗；key 用來判斷兩份來源是否描述同一個額度。 */
export interface KeyedWindow extends UsageWindow {
  key: string;
}

export interface CachedUtilization {
  dataAt: Date;
  windows: KeyedWindow[];
}

export interface UsageSource extends CachedUtilization {
  origin: 'local-snapshot:usage_snapshot.json' | 'local-cache:claude.json';
}

function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function snapshotPath(): string {
  return path.join(os.homedir(), '.claude', 'usage_snapshot.json');
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 兩份官方快取，依資料時間由新到舊排序；讀不到的不列入。 */
async function readUsageSources(): Promise<UsageSource[]> {
  const [claudeJson, snapshotJson] = await Promise.all([readJson(claudeJsonPath()), readJson(snapshotPath())]);
  const out: UsageSource[] = [];
  const snap = snapshotJson ? parseUsageSnapshot(snapshotJson) : null;
  if (snap) {
    out.push({ ...snap, origin: 'local-snapshot:usage_snapshot.json' });
  }
  const cached = claudeJson ? parseCachedUsageUtilization(claudeJson['cachedUsageUtilization']) : null;
  if (cached) {
    out.push({ ...cached, origin: 'local-cache:claude.json' });
  }
  // 同時間時 snapshot 優先（穩定排序 + 先放 snapshot）
  return out.sort((a, b) => b.dataAt.getTime() - a.dataAt.getTime());
}

/**
 * 以最新的來源為主，較舊的來源只補上主來源沒有的視窗。
 *
 * 例：probe 只拿到 five_hour，而 ~/.claude.json 還有每週與 Opus 額度。
 * 直接採用較新的檔案會讓那些額度從卡片上消失；補上時保留各自的資料時間，
 * 舊的數字會照實被標成過期，不會被當成剛取得的值。
 */
export function combineUsageSources(sources: readonly CachedUtilization[], now: Date): UsageWindow[] {
  const seen = new Set<string>();
  const out: UsageWindow[] = [];
  for (const source of sources) {
    const fresh = source.windows.filter((w) => !seen.has(w.key));
    for (const w of fresh) {
      seen.add(w.key);
    }
    const stripped = fresh.map(({ key: _key, ...rest }) => rest);
    out.push(...markStaleness(stripped, source.dataAt, now, STALE_AFTER_MS));
  }
  return out;
}

/** 實際有貢獻視窗的來源（較舊來源的視窗全被較新來源蓋過時就不列出）。 */
function contributingOrigins(sources: readonly UsageSource[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    if (source.windows.some((w) => !seen.has(w.key))) {
      out.push(source.origin);
    }
    for (const w of source.windows) {
      seen.add(w.key);
    }
  }
  return out;
}

/** 解析 ~/.claude/usage_snapshot.json（Agora、Claude statusline 與背景 probe 共用的格式）。 */
export function parseUsageSnapshot(parsed: Record<string, unknown>): CachedUtilization | null {
  const updatedAt = finiteNumber(parsed['updated_at']);
  const dataAt = updatedAt ? new Date(updatedAt * 1000) : new Date(0);
  const windows: KeyedWindow[] = [];

  for (const key of ['five_hour', 'seven_day'] as const) {
    const node = parsed[key];
    if (!node || typeof node !== 'object') {
      continue;
    }
    const n = node as Record<string, unknown>;
    const used = finiteNumber(n['used_percentage']);
    if (used === null) {
      continue;
    }
    windows.push({
      key,
      label: windowLabel(key) ?? key,
      usedPercent: clampPercent(used),
      resetsAt: parseResetTime(n['resets_at']),
      raw: t(`${key}: ${used}% 已使用`, `${key}: ${used}% used`),
    });
  }

  return windows.length > 0 ? { dataAt, windows } : null;
}

export type ProbeWindow = { key: 'five_hour' | 'seven_day'; usedPercentage: number; resetsAt: Date | null };

/**
 * 寫入 ~/.claude/usage_snapshot.json（格式與 Agora、Claude statusline 相容）。
 *
 * 這個檔案是共用的，所以會保留其他工具寫入的欄位；但這次沒拿到的視窗會被移除，
 * 否則它舊的百分比會掛上新的 updated_at，被誤認為剛取得的值。
 */
export async function saveUsageSnapshotFile(windows: readonly ProbeWindow[], source: string): Promise<void> {
  const file = snapshotPath();
  const existing = (await readJson(file)) ?? {};
  const next = mergeSnapshotFile(existing, windows, source, new Date());
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    logger.warn(`claude: 寫入 ~/.claude/usage_snapshot.json 失敗 — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function mergeSnapshotFile(
  existing: Record<string, unknown>,
  windows: readonly ProbeWindow[],
  source: string,
  now: Date
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  delete next['five_hour'];
  delete next['seven_day'];
  next['updated_at'] = Math.floor(now.getTime() / 1000);
  next['source'] = source;
  for (const w of windows) {
    next[w.key] = {
      used_percentage: w.usedPercentage,
      resets_at: w.resetsAt ? Math.floor(w.resetsAt.getTime() / 1000) : null,
    };
  }
  return next;
}

export interface ProbeResult {
  success: boolean;
  message?: string;
  windows?: ProbeWindow[];
}

/** stream-json 的 rate_limit_info → 解析成 5 小時 / 7 天視窗（utilization 是 0~1 的比例）。 */
export function parseRateLimitInfo(info: Record<string, unknown>): ProbeWindow[] {
  const results: ProbeWindow[] = [];
  const unified = info['unifiedWindows'] as Record<string, unknown> | undefined;
  if (unified && typeof unified === 'object') {
    for (const key of ['five_hour', 'seven_day'] as const) {
      const w = unified[key] as Record<string, unknown> | undefined;
      if (w && typeof w === 'object' && typeof w['utilization'] === 'number') {
        results.push({
          key,
          usedPercentage: Math.round(w['utilization'] * 1000) / 10,
          resetsAt: parseResetTime(w['resetsAt'] ?? w['resets_at']),
        });
      }
    }
  }
  if (results.length === 0) {
    const type = info['rateLimitType'];
    const util = info['utilization'];
    if ((type === 'five_hour' || type === 'seven_day') && typeof util === 'number') {
      results.push({
        key: type,
        usedPercentage: Math.round(util * 1000) / 10,
        resetsAt: parseResetTime(info['resetsAt'] ?? info['resets_at']),
      });
    }
  }
  return results;
}

/** 從 stream-json 輸出收集所有 rate_limit_event；同一視窗以最後出現的為準。 */
export function collectProbeWindows(stdout: string): ProbeWindow[] {
  const byKey = new Map<ProbeWindow['key'], ProbeWindow>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const info = event['rate_limit_info'];
      if (event['type'] === 'rate_limit_event' && info && typeof info === 'object') {
        for (const w of parseRateLimitInfo(info as Record<string, unknown>)) {
          byKey.set(w.key, w);
        }
      }
    } catch {
      // 忽略單行 JSON 解析錯誤
    }
  }
  return [...byKey.values()];
}

let probeInFlight: Promise<ProbeResult> | null = null;

/**
 * 以 Haiku 執行一次極短的 stream-json 請求，攔截 rate_limit_event 取得即時額度。
 *
 * 這會透過官方 claude CLI 發出一次真正的 API 請求，並計入 Claude 用量
 * （包含 Claude Code 自帶的 system prompt，不只是 prompt 本身的幾個 token）。
 * 同一時間只會有一個 probe：手動按鈕與自動 probe 重疊時共用同一次結果。
 */
export function probeClaude(cli: string, timeoutMs: number = 60000): Promise<ProbeResult> {
  probeInFlight ??= doProbe(cli, timeoutMs).finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

async function doProbe(cli: string, timeoutMs: number): Promise<ProbeResult> {
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
    return { success: false, message: t('背景探測請求逾時', 'background probe timed out') };
  }

  const windows = collectProbeWindows(r.stdout);
  if (windows.length > 0) {
    await saveUsageSnapshotFile(windows, 'probe');
    logger.info('Claude 背景探測成功，已更新 ~/.claude/usage_snapshot.json');
    return { success: true, windows };
  }

  const errText = r.stderr.trim() || r.stdout.trim().slice(-200);
  return {
    success: false,
    message: errText || t('未在輸出中收到 rate_limit_event', 'no rate_limit_event in output'),
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
  const windows: KeyedWindow[] = [];
  const covered = new Set<string>();
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
      const key = LIMIT_KIND_LEGACY_KEYS[kind] ?? (kind || group || 'limit');
      covered.add(key);
      windows.push({
        key,
        label: windowLabel(key) ?? formatLimitLabel(kind || group),
        usedPercent: clampPercent(percent),
        resetsAt: parseResetTime(limit['resets_at'] ?? limit['resetsAt']),
        raw: t(`${kind || group || 'limit'}: ${percent}% 已使用`, `${kind || group || 'limit'}: ${percent}% used`),
      });
    }
  }

  for (const key of LEGACY_KEYS) {
    if (covered.has(key)) {
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
      key,
      label: windowLabel(key) ?? key,
      usedPercent: clampPercent(percent),
      resetsAt: parseResetTime(n['resets_at'] ?? n['resetsAt']),
      raw: t(`${key}: ${percent}% 已使用`, `${key}: ${percent}% used`),
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
    return t('Claude 用量', 'Claude usage');
  }
  return kind
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

/** 單一對話檔最多讀尾端這麼多；只用來估算，不值得把數十 MB 全讀進記憶體。 */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * 掃 ~/.claude/projects 底下近 5 小時的對話紀錄做 token 估算。
 *
 * 全程非同步，不阻塞 extension host；只讀 usage 欄位，不解析訊息內容，也不輸出任何內容到 log。
 */
async function estimateFromTranscripts(): Promise<{ totalTokens: number; messages: number; files: number } | null> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  const files: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || files.length >= 40) {
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
      } else if (e.isFile() && e.name.endsWith('.jsonl') && files.length < 40) {
        try {
          if ((await fs.promises.stat(full)).mtimeMs >= cutoff) {
            files.push(full);
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  await walk(root, 0);

  if (files.length === 0) {
    return null;
  }

  let totalTokens = 0;
  let messages = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readTail(file, TRANSCRIPT_TAIL_BYTES);
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
      const sum = toInt(inTok?.[1]) + toInt(outTok?.[1]) + toInt(cacheRead?.[1]) + toInt(cacheWrite?.[1]);
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
