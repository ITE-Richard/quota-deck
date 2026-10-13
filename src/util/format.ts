import * as fs from 'node:fs';
import { t } from '../i18n';

/** 三個 provider 共用的格式化與型別收斂工具。 */

export function formatLocal(d: Date): string {
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) {
    return t(`${minutes} 分鐘`, `${minutes} min`);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? t(`${hours} 小時 ${rest} 分`, `${hours} h ${rest} min`) : t(`${hours} 小時`, `${hours} h`);
  }
  const days = Math.floor(hours / 24);
  return t(`${days} 天 ${hours % 24} 小時`, `${days} d ${hours % 24} h`);
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 數字或數字字串 → 有限數字；其他一律 null。 */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/**
 * 只讀檔案最後 maxBytes 位元組（非同步，不阻塞 extension host）。
 *
 * 對話紀錄可能有數十 MB，而我們只需要最新的幾筆事件。
 * 從中間切開的第一行會是殘缺的，呼叫端逐行 JSON.parse 時自然會略過。
 */
export async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
