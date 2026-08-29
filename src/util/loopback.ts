import * as http from 'node:http';
import * as https from 'node:https';

export interface LoopbackRequestOptions {
  protocol: 'http' | 'https';
  port: number;
  path: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface LoopbackResponse {
  status: number;
  body: string;
}

const HOST = '127.0.0.1';

/**
 * 只對 127.0.0.1 發送的極簡 HTTP/HTTPS client（Node 內建，不引入 axios 等依賴）。
 *
 * 本機語言伺服器用的是自簽憑證，因此 https 時需要放寬憑證驗證；
 * 這裡把 rejectUnauthorized:false 綁死在「host 必定是 127.0.0.1」的 agent 上，
 * 不去動全域的 NODE_TLS_REJECT_UNAUTHORIZED，也不影響任何其他請求。
 */
const insecureLoopbackAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
});

export function loopbackRequest(options: LoopbackRequestOptions): Promise<LoopbackResponse> {
  return new Promise<LoopbackResponse>((resolve, reject) => {
    if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
      reject(new Error(`invalid loopback port: ${String(options.port)}`));
      return;
    }

    const isHttps = options.protocol === 'https';
    const transport = isHttps ? https : http;
    const requestOptions: https.RequestOptions = {
      host: HOST,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined
          ? {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(options.body)),
            }
          : {}),
        ...options.headers,
      },
      timeout: options.timeoutMs,
      ...(isHttps ? { agent: insecureLoopbackAgent } : {}),
    };

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`loopback request timed out after ${options.timeoutMs}ms`));
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
