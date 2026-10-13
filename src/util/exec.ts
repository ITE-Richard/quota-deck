import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

const IS_WIN = process.platform === 'win32';

/**
 * Windows 上 `npm i -g` 裝出來的是 `claude.cmd` / `codex.cmd`。
 * Node 18.20.2 起（CVE-2024-27980）不經 shell 直接執行 .cmd/.bat 會丟 EINVAL，
 * 所以這類檔案必須明確交給 cmd.exe。
 */
export function isWindowsBatch(file: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(file);
}

/**
 * 依 MSVCRT 規則引用單一參數，供 cmd.exe 轉交給 .cmd 內的 node 使用。
 *
 * `%` 與 `!` 在 cmd.exe 內即使加了引號仍會被展開，無法安全轉義，直接拒絕。
 * 本套件所有參數都是寫死的常數，正常情況不會碰到。
 */
export function quoteWindowsArg(arg: string): string {
  if (/[%!\r\n]/.test(arg)) {
    throw new Error(`refusing to pass unsafe argument through cmd.exe: ${JSON.stringify(arg)}`);
  }
  if (arg !== '' && !/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

interface Invocation {
  file: string;
  args: string[];
  verbatim: boolean;
}

/** .cmd/.bat 改由 `cmd.exe /d /s /c "..."` 執行，其餘維持不經 shell。 */
function toInvocation(file: string, args: readonly string[]): Invocation {
  if (!isWindowsBatch(file)) {
    return { file, args: [...args], verbatim: false };
  }
  const line = [quoteWindowsArg(file), ...args.map(quoteWindowsArg)].join(' ');
  return { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * 結束程序與它的子程序。
 *
 * 經 cmd.exe 執行時，真正的工作程序是 cmd.exe 的孫程序；只 kill cmd.exe
 * 會留下孤兒，而且孤兒仍握著 stdout pipe，讓 callback 遲遲不觸發。
 */
function killTree(child: ChildProcess): void {
  if (IS_WIN && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      /* 退回 child.kill() */
    }
  }
  try {
    child.kill();
  } catch {
    /* 已經結束了 */
  }
}

/**
 * execFile 包裝。
 *
 * - 預設不經 shell，避免 shell injection；只有 Windows .cmd/.bat 例外，且參數一律引用
 * - 一律有 timeout，逾時連同子程序一起結束
 * - 永不 throw：失敗以 ExecResult 回報，讓呼叫端決定降級
 */
export function run(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const started = Date.now();
    let invocation: Invocation;
    try {
      invocation = toInvocation(file, args);
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, failure: err as Error });
      return;
    }

    let timedOut = false;
    let child: ChildProcess;
    try {
      child = execFile(
        invocation.file,
        invocation.args,
        {
          cwd: options.cwd ?? undefined,
          env: options.env ?? process.env,
          windowsHide: true,
          windowsVerbatimArguments: invocation.verbatim,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          const elapsed = Date.now() - started;
          const err = error as (Error & { code?: number | string }) | null;
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
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, failure: err as Error });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

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
 * - 不論成功失敗都保證 kill（含子程序），不會留下孤兒程序
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
    let child: ChildProcess;
    try {
      const invocation = toInvocation(file, args);
      child = spawn(invocation.file, invocation.args, {
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
      killTree(child);
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
