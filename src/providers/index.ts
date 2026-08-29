import { logger } from '../logger';
import {
  expireRolledOverWindows,
  PROVIDER_IDS,
  serializeSnapshot,
  type ProviderId,
  type SerializedSnapshot,
  type UsageProvider,
} from '../types';
import { AntigravityProvider } from './antigravity';
import { ClaudeProvider } from './claude';
import { CodexProvider } from './codex';

const registry: Record<ProviderId, UsageProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  antigravity: new AntigravityProvider(),
};

export function getProvider(id: ProviderId): UsageProvider {
  return registry[id];
}

export function allProviders(): UsageProvider[] {
  return PROVIDER_IDS.map((id) => registry[id]);
}

/**
 * 抓單一 provider 的用量。
 *
 * 這裡是最後一道防線：provider 內部已經自己 catch 過各條降級鏈，
 * 萬一還是漏了，也絕不讓例外往上冒泡影響其他 provider 或整個面板。
 */
export async function fetchProvider(id: ProviderId): Promise<SerializedSnapshot> {
  const provider = registry[id];
  try {
    const snapshot = await provider.fetch();
    // 統一在這裡作廢已經滾過去的視窗，三家都不會漏掉
    snapshot.windows = expireRolledOverWindows(snapshot.windows, snapshot.fetchedAt);
    logger.debug(`${id}: status=${snapshot.status} source=${snapshot.source} windows=${snapshot.windows.length}`);
    return serializeSnapshot(snapshot);
  } catch (err) {
    logger.error(`${id}: fetch 未預期地失敗`, err);
    return {
      provider: id,
      status: 'error',
      windows: [],
      fetchedAt: new Date().toISOString(),
      source: 'unhandled',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
