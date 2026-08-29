import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../logger';
import { commandExists } from './exec';

/**
 * CLI 路徑解析。
 *
 * 偵察發現：在 Windows + VSCode 上，`claude` 與 `codex` 常常「沒有」進 PATH，
 * 而是被包在 VSCode 擴充套件目錄裡（例如
 * `~/.vscode/extensions/anthropic.claude-code-<ver>/resources/native-binary/claude.exe`）。
 * 只信 PATH 會讓三張卡片全部顯示「未偵測到 CLI」，所以這裡加上內附 binary 的探測。
 */

const IS_WIN = process.platform === 'win32';

/** VSCode 系列 IDE 的使用者擴充套件目錄。 */
function extensionRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.antigravity-ide', 'extensions'),
    path.join(home, '.antigravity', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ];
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 掃所有擴充套件根目錄，找出名稱以 prefix 開頭的資料夾，再接上 relative 候選路徑。 */
function bundledCandidates(prefix: string, relatives: readonly string[]): string[] {
  const found: string[] = [];
  for (const root of extensionRoots()) {
    for (const name of safeReaddir(root)) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      for (const rel of relatives) {
        const full = path.join(root, name, rel);
        if (isFile(full)) {
          found.push(full);
        }
      }
    }
  }
  // 新版本的目錄名字典序通常較大，優先用最新的
  return found.sort().reverse();
}

function codexPlatformDir(): string {
  if (IS_WIN) {
    return 'windows-x86_64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  }
  return process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
}

function claudeCandidates(): string[] {
  const home = os.homedir();
  const exe = IS_WIN ? 'claude.exe' : 'claude';
  const out = bundledCandidates('anthropic.claude-code-', [
    path.join('resources', 'native-binary', exe),
    path.join('resources', 'native-binary', 'claude'),
  ]);
  for (const p of [
    path.join(home, '.local', 'bin', exe),
    path.join(home, '.claude', 'local', exe),
    path.join(home, 'AppData', 'Roaming', 'npm', IS_WIN ? 'claude.cmd' : 'claude'),
  ]) {
    if (isFile(p)) {
      out.push(p);
    }
  }
  return out;
}

function codexCandidates(): string[] {
  const home = os.homedir();
  const exe = IS_WIN ? 'codex.exe' : 'codex';
  const out = bundledCandidates('openai.chatgpt-', [
    path.join('bin', codexPlatformDir(), exe),
  ]);
  for (const p of [
    path.join(home, '.local', 'bin', exe),
    path.join(home, '.codex', 'bin', exe),
    path.join(home, 'AppData', 'Roaming', 'npm', IS_WIN ? 'codex.cmd' : 'codex'),
  ]) {
    if (isFile(p)) {
      out.push(p);
    }
  }
  return out;
}

const DEFAULTS: Record<'claude' | 'codex', string> = { claude: 'claude', codex: 'codex' };

const resolved = new Map<string, string | null>();

/**
 * 解析 CLI 的實際可執行路徑。
 *
 * 1. 使用者在設定裡指定了非預設值 → 完全尊重，不做額外探測
 * 2. 否則先試 PATH 上的預設名字
 * 3. 再試各 IDE 擴充套件內附的 binary
 *
 * 結果會快取在記憶體中，避免每次重新整理都重掃磁碟。
 */
export async function resolveCli(
  which: 'claude' | 'codex',
  configuredPath: string,
  probeArgs: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  const configured = configuredPath.trim();
  const isDefault = configured === '' || configured === DEFAULTS[which];
  const cacheKey = `${which}:${isDefault ? '<default>' : configured}`;
  const memo = resolved.get(cacheKey);
  if (memo !== undefined) {
    return memo;
  }

  const candidates = isDefault
    ? [DEFAULTS[which], ...(which === 'claude' ? claudeCandidates() : codexCandidates())]
    : [configured];

  for (const candidate of candidates) {
    if (await commandExists(candidate, probeArgs, timeoutMs)) {
      logger.debug(`resolved ${which} CLI -> ${candidate}`);
      resolved.set(cacheKey, candidate);
      return candidate;
    }
  }

  logger.debug(`could not resolve ${which} CLI (tried ${candidates.length} candidate(s))`);
  resolved.set(cacheKey, null);
  return null;
}

/** 設定變更時清掉快取，讓下次重新整理重新探測。 */
export function clearCliCache(): void {
  resolved.clear();
}
