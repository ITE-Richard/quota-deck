import * as vscode from 'vscode';
import type { SnapshotCache } from './cache';
import { readConfig } from './config';
import { logger } from './logger';
import { fetchProvider, getProvider } from './providers';
import { PROVIDER_IDS, type ProviderId, type SerializedSnapshot } from './types';

export interface PanelState {
  snapshots: Partial<Record<ProviderId, SerializedSnapshot>>;
  /** 正在抓取中的 provider，UI 用來顯示 spinner 並 disable 按鈕。 */
  loading: ProviderId[];
  enabled: Record<ProviderId, boolean>;
  /** CLI / 執行中的服務是否存在；undefined 代表還沒探測過。 */
  detected: Partial<Record<ProviderId, boolean>>;
}

/**
 * 三個顯示位置（Activity Bar / Panel / 編輯器分頁）共用的單一狀態來源。
 *
 * 刻意不提供任何 setInterval 或啟動時自動抓取：所有更新都由使用者觸發。
 */
export class UsageStore {
  private readonly emitter = new vscode.EventEmitter<PanelState>();
  readonly onDidChange = this.emitter.event;

  private readonly snapshots: Partial<Record<ProviderId, SerializedSnapshot>> = {};
  private readonly loading = new Set<ProviderId>();
  private readonly detected: Partial<Record<ProviderId, boolean>> = {};
  private readonly inFlight = new Map<ProviderId, Promise<void>>();

  constructor(private readonly cache: SnapshotCache) {
    // 開啟 VSCode 時只還原上次結果（標為快取），不主動連線
    Object.assign(this.snapshots, cache.readAll());
  }

  get state(): PanelState {
    return {
      snapshots: { ...this.snapshots },
      loading: [...this.loading],
      enabled: readConfig().enabled,
      detected: { ...this.detected },
    };
  }

  private emit(): void {
    this.emitter.fire(this.state);
  }

  /** 設定變更時重新廣播（例如切換某個 provider 的顯示與否）。 */
  notifyConfigChanged(): void {
    this.emit();
  }

  async refresh(id: ProviderId): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) {
      return existing;
    }
    const task = this.doRefresh(id).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, task);
    return task;
  }

  private async doRefresh(id: ProviderId): Promise<void> {
    this.loading.add(id);
    this.emit();
    try {
      try {
        this.detected[id] = await getProvider(id).detect();
      } catch {
        this.detected[id] = false;
      }
      const snapshot = await fetchProvider(id);
      this.snapshots[id] = snapshot;
      await this.cache.write(id, snapshot);
    } catch (err) {
      logger.error(`${id}: refresh 失敗`, err);
    } finally {
      this.loading.delete(id);
      this.emit();
    }
  }

  /** 只重新整理目前啟用的 provider，且彼此獨立——一家失敗不影響其他家。 */
  async refreshAll(): Promise<void> {
    const enabled = readConfig().enabled;
    const targets = PROVIDER_IDS.filter((id) => enabled[id]);
    await Promise.allSettled(targets.map((id) => this.refresh(id)));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
