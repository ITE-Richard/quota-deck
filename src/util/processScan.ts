import { run } from './exec';
import { logger } from '../logger';

export interface ProcInfo {
  pid: number;
  name: string;
  commandLine: string;
}

/** 只允許安全的程序名字元，避免把使用者輸入拼進 PowerShell 過濾字串。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * 跨平台 process 掃描。
 *
 * - Windows：PowerShell `Get-CimInstance Win32_Process`，取 ProcessId / Name / CommandLine
 * - macOS / Linux：`ps -ax -o pid=,command=`
 *
 * 失敗一律回空陣列，不 throw。
 */
export async function scanProcesses(nameHints: readonly string[], timeoutMs: number): Promise<ProcInfo[]> {
  try {
    if (process.platform === 'win32') {
      return await scanWindows(nameHints, timeoutMs);
    }
    return await scanPosix(nameHints, timeoutMs);
  } catch (err) {
    logger.error('process scan failed', err);
    return [];
  }
}

async function scanWindows(nameHints: readonly string[], timeoutMs: number): Promise<ProcInfo[]> {
  const safe = nameHints.filter((n) => SAFE_NAME.test(n));
  if (safe.length === 0) {
    return [];
  }
  const filter = safe.map((n) => `Name='${n}'`).join(' OR ');
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3';

  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs }
  );
  if (r.failure || r.timedOut || !r.stdout.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const pid = typeof rec['ProcessId'] === 'number' ? rec['ProcessId'] : Number.NaN;
    if (!Number.isFinite(pid)) {
      continue;
    }
    out.push({
      pid,
      name: typeof rec['Name'] === 'string' ? rec['Name'] : '',
      commandLine: typeof rec['CommandLine'] === 'string' ? rec['CommandLine'] : '',
    });
  }
  return out;
}

async function scanPosix(nameHints: readonly string[], timeoutMs: number): Promise<ProcInfo[]> {
  const r = await run('ps', ['-ax', '-o', 'pid=,command='], { timeoutMs });
  if (r.failure || r.timedOut) {
    return [];
  }
  const out: ProcInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const pidText = m[1];
    const cmd = m[2];
    if (pidText === undefined || cmd === undefined) {
      continue;
    }
    if (!nameHints.some((hint) => cmd.includes(hint))) {
      continue;
    }
    out.push({ pid: Number.parseInt(pidText, 10), name: hintNameOf(cmd), commandLine: cmd });
  }
  return out;
}

function hintNameOf(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? '';
  const parts = first.split(/[\/]/);
  return parts[parts.length - 1] ?? first;
}

/** 這個 pid 現在還活著嗎？用來驗證 discovery file 是不是殘留檔。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 程序存在但沒有權限送訊號，仍算活著
    return code === 'EPERM';
  }
}
