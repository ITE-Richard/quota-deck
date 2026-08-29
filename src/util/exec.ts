import { execFile, spawn } from 'node:child_process';
import { logger } from '../logger';

export interface ExecResult {
  /** 程序結束碼；因 timeout 或 spawn 失敗而沒有結束碼時為 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 失敗（例如 ENOENT）時的錯誤。 */
  failure?: Error;
}

export interface ExecOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * execFile 包裝。
 *
 * - 一律用 execFile（不經 shell），避免 shell injection
 * - 一律有 timeout
 * - 永不 throw：失敗以 ExecResult 回報，讓呼叫端決定降級
 */
export function run(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const started = Date.now();
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        cwd: options.cwd ?? undefined,
        env: options.env ?? process.env,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const elapsed = Date.now() - started;
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = Boolean(err?.killed) || err?.code === 'ETIMEDOUT';
        const code = typeof err?.code === 'number' ? err.code : err ? null : 0;
        const result: ExecResult = {
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut,
        };
        if (err && (timedOut || typeof err.code !== 'number')) {
          result.failure = err;
        }
        logger.debug(
          `exec ${file} ${args.join(' ')} -> code=${String(code)} timedOut=${String(timedOut)} ${elapsed}ms`
        );
        resolve(result);
      }
    );
    child.on('error', () => {
      /* 由 callback 統一處理 */
    });
  });
}

/**
 * 對一個講 stdio JSON-RPC 的長駐程序做一次「握手 + 單一請求」，拿到結果就結束它。
 *
 * 用於 `codex app-server`：先送 initialize（id 1），再送目標方法（id 2），
 * 收到 id 2 的回應就 kill 掉程序。
 *
 * - 永不 throw，失敗回 null
 * - 一定有 timeout，逾時就強制結束程序
 * - 不論成功失敗都保證 kill，不會留下孤兒程序
 */
export function jsonRpcStdio(
  file: string,
  args: readonly string[],
  handshake: Record<string, unknown>,
  request: Record<string, unknown>,
  responseId: number,
  timeoutMs: number
): Promise<unknown | null> {
  return new Promise<unknown | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      logger.debug(`jsonRpcStdio spawn 失敗：${err instanceof Error ? err.message : String(err)}`);
      resolve(null);
      return;
    }

    let settled = false;
    let buffer = '';

    const finish = (value: unknown | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已經結束了 */
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      logger.debug(`jsonRpcStdio 逾時（${timeoutMs}ms）：${file}`);
      finish(null);
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // 通知訊息或非 JSON 輸出，略過
        }
        const rec = parsed as { id?: unknown; result?: unknown; error?: unknown };
        if (rec.id === 1 && rec.result !== undefined) {
          try {
            child.stdin?.write(`${JSON.stringify(request)}\n`);
          } catch {
            finish(null);
          }
          continue;
        }
        if (rec.id === responseId) {
          finish(rec.error !== undefined ? null : (rec.result ?? null));
          return;
        }
      }
    });

    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

    try {
      child.stdin?.write(`${JSON.stringify(handshake)}\n`);
    } catch {
      finish(null);
    }
  });
}

/** 只要程序能被叫起來並回應（不論結束碼），就視為存在。 */
export async function commandExists(file: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
  const r = await run(file, args, { timeoutMs });
  if (r.failure && !r.timedOut) {
    return false;
  }
  return !r.timedOut;
}
