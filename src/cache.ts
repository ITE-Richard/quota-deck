import type * as vscode from 'vscode';
import { PROVIDER_IDS, type ProviderId, type SerializedSnapshot } from './types';

const KEY = 'quotaDeck.snapshots.v1';

type CacheShape = Partial<Record<ProviderId, SerializedSnapshot>>;

/**
 * globalState 快取。
 *
 * 只存放已序列化的摘要（百分比、方案名稱、時間戳），
 * 不存放 token、credential 或任何原始認證檔內容。
 */
export class SnapshotCache {
  constructor(private readonly memento: vscode.Memento) {}

  /** 讀回上次結果，並標記為 cached，讓 UI 可以顯示「快取」。 */
  readAll(): CacheShape {
    const raw = this.memento.get<CacheShape>(KEY);
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const out: CacheShape = {};
    for (const id of PROVIDER_IDS) {
      const snap = raw[id];
      if (snap && snap.provider === id && typeof snap.fetchedAt === 'string') {
        out[id] = { ...snap, cached: true };
      }
    }
    return out;
  }

  async write(id: ProviderId, snapshot: SerializedSnapshot): Promise<void> {
    const current = this.memento.get<CacheShape>(KEY) ?? {};
    const next: CacheShape = { ...current, [id]: { ...snapshot, cached: false } };
    await this.memento.update(KEY, next);
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, undefined);
  }
}
