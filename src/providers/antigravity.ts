import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../config';
import { logger } from '../logger';
import type { UsageProvider, UsageSnapshot, UsageWindow } from '../types';
import { loopbackRequest } from '../util/loopback';
import { isPidAlive, scanProcesses } from '../util/processScan';

/**
 * Google Antigravity provider。
 *
 * 偵察結論（Antigravity 2.11.0 / VSCode 擴充套件 google.google-antigravity-1.1.0）：
 * - VSCode 上跑的不是 language_server_*.exe，而是
 *   `agy.exe --hub --hub-port=<隨機 ephemeral port> --app_data_dir=antigravity`
 * - hub 同時開兩個 port：--hub-port 是 HTTP，另一個相鄰 port 是自簽憑證的 HTTPS
 * - 直接打 RPC 會得到 401 {"code":"unauthenticated","message":"missing CSRF token"}
 * - CSRF token 由 hub 首頁以未認證方式提供：
 *   GET http://127.0.0.1:<hubPort>/ 的 HTML 內含
 *   window.__APP_CONFIG__ = {"csrfToken":"..."}
 * - 正確的 header 是 x-codeium-csrf-token（從 hub 的 main.js Connect interceptor 挖出來）
 * - GET /healthz 回 {"instanceId":...,"status":"ok"}，比 GetUnleashData 更輕量，用來驗活
 * - GetUserStatus 回 name / email / planName / userTier /
 *   cascadeModelConfigData.clientModelConfigs[].quotaInfo{remainingFraction,resetTime}
 * - GetCommandModelConfigs 在這個版本回 501 unimplemented，備援價值為零
 *
 * 因為 HTTP port 完全可用，正常路徑不需要放寬任何 TLS 驗證；
 * 只有退回 HTTPS port 時才會用 loopback.ts 內綁死 127.0.0.1 的 agent。
 *
 * 明確不做：POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota。
 * 那條路要 Google OAuth，且需要把 refresh token 落地成純文字檔。
 */
export class AntigravityProvider implements UsageProvider {
  readonly id = 'antigravity' as const;

  async detect(): Promise<boolean> {
    const cfg = readConfig();
    if ((await findHubEndpoints(cfg.commandTimeoutMs)).length > 0) {
      return true;
    }
    return agyBinaryExists() || languageServerBinaryExists();
  }

  loginCommand(): string {
    // Antigravity 的登入是在 IDE 內完成的，沒有非互動指令
    return 'agy login';
  }

  async fetch(): Promise<UsageSnapshot> {
    const cfg = readConfig();
    const now = new Date();
    const timeoutMs = cfg.commandTimeoutMs;

    const endpoints = await findHubEndpoints(timeoutMs);
    if (endpoints.length === 0) {
      const installed = agyBinaryExists() || languageServerBinaryExists();
      return {
        provider: 'antigravity',
        status: installed ? 'not_logged_in' : 'cli_not_found',
        windows: [],
        fetchedAt: now,
        source: 'process-scan',
        message: installed
          ? 'Antigravity 目前沒有在執行。請開啟 Antigravity IDE，或在 VSCode 內啟用 Antigravity 擴充套件，再重新整理。'
          : '未偵測到 Antigravity。',
      };
    }

    const failures: string[] = [];
    for (const ep of endpoints) {
      try {
        const snapshot = await fetchFromEndpoint(ep, timeoutMs, now);
        if (snapshot) {
          return snapshot;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${ep.protocol}:${ep.port} ${detail}`);
        logger.debug(`antigravity: endpoint ${ep.protocol}:${ep.port} 失敗 — ${detail}`);
      }
    }

    return {
      provider: 'antigravity',
      status: 'error',
      windows: [],
      fetchedAt: now,
      source: 'loopback:language-server',
      message: `找到 ${endpoints.length} 個候選端點但都無法取得用量。${failures[0] ?? ''}`,
    };
  }
}

interface Endpoint {
  protocol: 'http' | 'https';
  port: number;
  /** 若來源已經帶了 token（discovery file / 命令列），就不必再去首頁抓。 */
  csrfToken?: string;
  origin: string;
}

const SERVICE = '/exa.language_server_pb.LanguageServerService';

/**
 * 依序用三種方式找出候選端點：
 *   1. process 掃描 agy.exe --hub-port（VSCode / Antigravity IDE 的實際做法）
 *   2. process 掃描 language_server 的 -https_server_port / -csrf_token（standalone 模式）
 *   3. ~/.gemini/<app_data_dir>/daemon/ls_*.json discovery file（persistent 模式，需 pid 驗活）
 */
async function findHubEndpoints(timeoutMs: number): Promise<Endpoint[]> {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  const push = (ep: Endpoint): void => {
    const key = `${ep.protocol}:${ep.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ep);
    }
  };

  const procs = await scanProcesses(
    ['agy.exe', 'agy', 'language_server_windows_x64.exe', 'language_server.exe', 'language_server'],
    Math.min(timeoutMs, 15000)
  );

  for (const p of procs) {
    const hubPort = readIntFlag(p.commandLine, 'hub-port');
    if (hubPort) {
      push({ protocol: 'http', port: hubPort, origin: 'process:agy --hub-port' });
      // hub 的 HTTPS port 與 HTTP port 相鄰，順帶列為備援
      push({ protocol: 'https', port: hubPort + 3, origin: 'process:agy --hub-port+3' });
    }
    const httpsPort = readIntFlag(p.commandLine, 'https_server_port');
    const httpPort = readIntFlag(p.commandLine, 'http_server_port');
    const extPort = readIntFlag(p.commandLine, 'extension_server_port');
    const token = readStringFlag(p.commandLine, 'csrf_token');
    if (httpPort) {
      push({ protocol: 'http', port: httpPort, origin: 'process:-http_server_port', ...(token ? { csrfToken: token } : {}) });
    }
    if (httpsPort) {
      push({ protocol: 'https', port: httpsPort, origin: 'process:-https_server_port', ...(token ? { csrfToken: token } : {}) });
    }
    if (extPort) {
      push({ protocol: 'http', port: extPort, origin: 'process:-extension_server_port', ...(token ? { csrfToken: token } : {}) });
    }
  }

  for (const d of readDiscoveryFiles()) {
    if (!isPidAlive(d.pid)) {
      continue;
    }
    if (d.httpPort) {
      push({ protocol: 'http', port: d.httpPort, origin: 'discovery-file', ...(d.csrfToken ? { csrfToken: d.csrfToken } : {}) });
    }
    if (d.httpsPort) {
      push({ protocol: 'https', port: d.httpsPort, origin: 'discovery-file', ...(d.csrfToken ? { csrfToken: d.csrfToken } : {}) });
    }
  }

  return out;
}

async function fetchFromEndpoint(ep: Endpoint, timeoutMs: number, now: Date): Promise<UsageSnapshot | null> {
  // 驗活：/healthz 比 GetUnleashData 便宜，而且不需要 token
  const health = await loopbackRequest({
    protocol: ep.protocol,
    port: ep.port,
    path: '/healthz',
    method: 'GET',
    timeoutMs,
  });
  if (health.status !== 200) {
    return null;
  }

  const token = ep.csrfToken ?? (await readCsrfTokenFromIndex(ep, timeoutMs));
  if (!token) {
    return null;
  }

  const res = await loopbackRequest({
    protocol: ep.protocol,
    port: ep.port,
    path: `${SERVICE}/GetUserStatus`,
    method: 'POST',
    headers: { 'x-codeium-csrf-token': token },
    body: '{}',
    timeoutMs,
  });

  if (res.status === 401) {
    logger.debug('antigravity: GetUserStatus 回 401，CSRF token 可能已經換掉');
    return null;
  }
  if (res.status !== 200) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return null;
  }

  const userStatus = parsed['userStatus'];
  if (!userStatus || typeof userStatus !== 'object') {
    return null;
  }
  return buildSnapshot(userStatus as Record<string, unknown>, ep, now);
}

/** hub 首頁把 csrfToken 直接寫在 window.__APP_CONFIG__ 裡，不需要任何認證。 */
async function readCsrfTokenFromIndex(ep: Endpoint, timeoutMs: number): Promise<string | null> {
  const res = await loopbackRequest({
    protocol: ep.protocol,
    port: ep.port,
    path: '/',
    method: 'GET',
    timeoutMs,
  });
  if (res.status !== 200) {
    return null;
  }
  const m = /"csrfToken"\s*:\s*"([^"]+)"/.exec(res.body);
  return m?.[1] ?? null;
}

function buildSnapshot(us: Record<string, unknown>, ep: Endpoint, now: Date): UsageSnapshot {
  const planStatus = asRecord(us['planStatus']);
  const planInfo = asRecord(planStatus?.['planInfo']);
  const userTier = asRecord(us['userTier']);

  const account =
    typeof us['email'] === 'string' && us['email'] !== ''
      ? us['email']
      : typeof us['name'] === 'string'
        ? us['name']
        : undefined;

  const planName =
    typeof planInfo?.['planName'] === 'string'
      ? `Antigravity ${planInfo['planName'] as string}`
      : typeof userTier?.['name'] === 'string'
        ? (userTier['name'] as string)
        : undefined;

  const windows = buildModelPools(us);

  // Prompt / Flow credits：available 與 monthly 是兩個不同意義的欄位，
  // 這裡照原樣顯示，不去推導一個可能誤導的百分比。
  const availablePrompt = asNumber(planStatus?.['availablePromptCredits']);
  const monthlyPrompt = asNumber(planInfo?.['monthlyPromptCredits']);
  if (availablePrompt !== null || monthlyPrompt !== null) {
    windows.push({
      label: 'Prompt credits',
      usedPercent: null,
      resetsAt: null,
      raw: `可用 ${fmtNum(availablePrompt)}${monthlyPrompt !== null ? ` / 每月額度 ${fmtNum(monthlyPrompt)}` : ''}`,
    });
  }
  const availableFlow = asNumber(planStatus?.['availableFlowCredits']);
  const monthlyFlow = asNumber(planInfo?.['monthlyFlowCredits']);
  if (availableFlow !== null || monthlyFlow !== null) {
    windows.push({
      label: 'Flow credits',
      usedPercent: null,
      resetsAt: null,
      raw: `可用 ${fmtNum(availableFlow)}${monthlyFlow !== null ? ` / 每月額度 ${fmtNum(monthlyFlow)}` : ''}`,
    });
  }

  return {
    provider: 'antigravity',
    status: 'ok',
    ...(account !== undefined ? { account } : {}),
    ...(planName !== undefined ? { plan: planName } : {}),
    windows,
    fetchedAt: now,
    source: `loopback:${ep.protocol}:${ep.port}/GetUserStatus (${ep.origin})`,
    message:
      'Claude 與 Gemini 是完全獨立的配額池，重置時刻也不同，請分開看。' +
      'Antigravity 的本機端點只提供上面這些滾動視窗，沒有回傳每週 baseline 硬上限；' +
      '撞到週上限時滾動視窗會失效並鎖到下週，但那個數字無法從本機取得，本套件不會憑空推估。',
  };
}

interface ModelQuota {
  label: string;
  modelId: string;
  remainingFraction: number | null;
  resetTime: Date | null;
}

/** 依模型家族分池（Claude / Gemini / 其他），池內取剩餘量最少的模型當代表。 */
function buildModelPools(us: Record<string, unknown>): UsageWindow[] {
  const cfgData = asRecord(us['cascadeModelConfigData']);
  const raw = cfgData?.['clientModelConfigs'];
  if (!Array.isArray(raw)) {
    return [];
  }

  const quotas: ModelQuota[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) {
      continue;
    }
    const quotaInfo = asRecord(rec['quotaInfo']);
    const resetRaw = quotaInfo?.['resetTime'];
    const reset = typeof resetRaw === 'string' ? new Date(resetRaw) : null;
    quotas.push({
      label: typeof rec['label'] === 'string' ? rec['label'] : '(unknown)',
      modelId: typeof rec['modelId'] === 'string' ? rec['modelId'] : '',
      remainingFraction: asNumber(quotaInfo?.['remainingFraction']),
      resetTime: reset && !Number.isNaN(reset.getTime()) ? reset : null,
    });
  }

  const pools = new Map<string, ModelQuota[]>();
  for (const q of quotas) {
    const family = familyOf(q.modelId, q.label);
    const list = pools.get(family);
    if (list) {
      list.push(q);
    } else {
      pools.set(family, [q]);
    }
  }

  const order = ['Claude', 'Gemini', 'GPT-OSS'];
  const sortedKeys = [...pools.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });

  const windows: UsageWindow[] = [];
  for (const key of sortedKeys) {
    const list = pools.get(key) ?? [];
    const withQuota = list.filter((q) => q.remainingFraction !== null);
    if (withQuota.length === 0) {
      continue;
    }
    let worst = withQuota[0];
    for (const q of withQuota) {
      if (worst === undefined || (q.remainingFraction ?? 1) < (worst.remainingFraction ?? 1)) {
        worst = q;
      }
    }
    if (worst === undefined) {
      continue;
    }
    const remaining = worst.remainingFraction ?? 1;
    windows.push({
      label: `${key} 配額池`,
      usedPercent: clampPercent((1 - remaining) * 100),
      resetsAt: worst.resetTime,
      raw: `${list.length} 個模型，剩餘 ${(remaining * 100).toFixed(2)}%（以 ${worst.label} 為準）`,
    });
  }
  return windows;
}

function familyOf(modelId: string, label: string): string {
  const hay = `${modelId} ${label}`.toLowerCase();
  if (hay.includes('claude')) {
    return 'Claude';
  }
  if (hay.includes('gemini')) {
    return 'Gemini';
  }
  if (hay.includes('gpt-oss') || hay.includes('gpt_oss') || hay.includes('openai')) {
    return 'GPT-OSS';
  }
  return '其他';
}

interface DiscoveryFile {
  pid: number;
  httpPort: number | null;
  httpsPort: number | null;
  csrfToken: string | null;
}

function geminiDir(): string {
  return path.join(os.homedir(), '.gemini');
}

/** persistent 模式才會寫出的 discovery file；hub 模式不會寫，所以只當備援。 */
function readDiscoveryFiles(): DiscoveryFile[] {
  const out: DiscoveryFile[] = [];
  for (const appDataDir of ['antigravity', 'antigravity-ide']) {
    const dir = path.join(geminiDir(), appDataDir, 'daemon');
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('ls_') || !name.endsWith('.json')) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
        const pid = asNumber(parsed['pid']);
        if (pid === null) {
          continue;
        }
        out.push({
          pid,
          httpPort: asNumber(parsed['httpPort']),
          httpsPort: asNumber(parsed['httpsPort']),
          csrfToken: typeof parsed['csrfToken'] === 'string' ? parsed['csrfToken'] : null,
        });
      } catch {
        /* 殘留或損毀的檔案直接跳過 */
      }
    }
  }
  return out;
}

function agyBinaryExists(): boolean {
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  return fileExists(path.join(geminiDir(), 'bin', exe));
}

function languageServerBinaryExists(): boolean {
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            home,
            'AppData',
            'Local',
            'Programs',
            'Antigravity IDE',
            'resources',
            'app',
            'extensions',
            'antigravity',
            'bin',
            'language_server_windows_x64.exe'
          ),
          path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
        ]
      : [
          '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm',
          '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64',
        ];
  return candidates.some(fileExists);
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readIntFlag(commandLine: string, flag: string): number | null {
  const re = new RegExp(`--?${flag}[=\\s]+(\\d+)`);
  const m = re.exec(commandLine);
  if (!m?.[1]) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function readStringFlag(commandLine: string, flag: string): string | null {
  const re = new RegExp(`--?${flag}[=\\s]+"?([A-Za-z0-9._~-]+)"?`);
  return re.exec(commandLine)?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

function fmtNum(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}
