import * as vscode from 'vscode';
import { readConfig } from './config';
import { t } from './i18n';
import type { PanelState } from './store';
import { PROVIDER_IDS, PROVIDER_LABELS, type ProviderId, type SerializedSnapshot } from './types';

/**
 * 狀態列摘要。
 *
 * 依 VSCode UX 準則，整個套件只建立**一個** StatusBarItem，
 * 也不自訂顏色（顏色保留給真正的錯誤狀態，由 VSCode 自己決定）。
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('quotaDeck.summary', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Quota Deck';
    this.item.command = 'quotaDeck.viewSidebar.focus';
  }

  update(state: PanelState): void {
    const cfg = readConfig();
    if (!cfg.showStatusBarItem) {
      this.item.hide();
      return;
    }

    const visible = PROVIDER_IDS.filter((id) => cfg.enabled[id]);
    if (visible.length === 0) {
      this.item.hide();
      return;
    }

    if (state.loading.length > 0) {
      this.item.text = t('$(sync~spin) AI 用量', '$(sync~spin) AI Usage');
    } else {
      const pick = choose(state, cfg.statusBarProvider, visible);
      // 與面板一致，主要數字一律顯示「剩餘」；tooltip 同時列出已使用。
      const left = pick ? `${pick.stale ? '~' : ''}${(100 - pick.percent).toFixed(0)}%` : '';
      this.item.text = pick
        ? t(`$(graph) ${pick.label} 剩餘 ${left}`, `$(graph) ${pick.label} ${left} left`)
        : t('$(graph) AI 用量', '$(graph) AI Usage');
    }

    this.item.tooltip = buildTooltip(state, visible);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

interface Pick {
  label: string;
  percent: number;
  stale: boolean;
}

function choose(
  state: PanelState,
  mode: 'lowest' | ProviderId,
  visible: readonly ProviderId[]
): Pick | null {
  if (mode !== 'lowest') {
    if (!visible.includes(mode)) {
      return null;
    }
    const worst = worstWindow(state.snapshots[mode]);
    return worst === null ? null : { label: shortLabel(mode), ...worst };
  }

  // lowest = 剩餘最少的那家 = 已用百分比最高的那家
  let best: Pick | null = null;
  for (const id of visible) {
    const worst = worstWindow(state.snapshots[id]);
    if (worst === null) {
      continue;
    }
    if (!best || worst.percent > best.percent) {
      best = { label: shortLabel(id), ...worst };
    }
  }
  return best;
}

/** 一家之內取用得最兇的那個視窗，作為該 provider 的代表值。 */
function worstWindow(snapshot: SerializedSnapshot | undefined): { percent: number; stale: boolean } | null {
  if (!snapshot || snapshot.status !== 'ok') {
    return null;
  }
  let worst: { percent: number; stale: boolean } | null = null;
  for (const w of snapshot.windows) {
    if (w.usedPercent === null) {
      continue;
    }
    if (worst === null || w.usedPercent > worst.percent) {
      worst = { percent: w.usedPercent, stale: w.stale === true };
    }
  }
  return worst;
}

function shortLabel(id: ProviderId): string {
  return { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }[id];
}

function buildTooltip(state: PanelState, visible: readonly ProviderId[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(t('**AI 用量**\n\n', '**AI Usage**\n\n'));

  for (const id of visible) {
    const snapshot = state.snapshots[id];
    md.appendMarkdown(`**${PROVIDER_LABELS[id]}**`);
    if (!snapshot) {
      md.appendMarkdown(t(' — 尚未讀取\n\n', ' — not loaded yet\n\n'));
      continue;
    }
    if (snapshot.cached) {
      md.appendMarkdown(t(' _(快取)_', ' _(cached)_'));
    }
    md.appendMarkdown('\n\n');

    if (snapshot.status !== 'ok') {
      md.appendMarkdown(`- ${statusText(snapshot.status)}\n\n`);
      continue;
    }
    if (snapshot.windows.length === 0) {
      md.appendMarkdown(t('- 無用量數據\n\n', '- no usage data\n\n'));
      continue;
    }
    for (const w of snapshot.windows) {
      const left = w.usedPercent === null ? '' : `${w.stale ? '~' : ''}${(100 - w.usedPercent).toFixed(1)}%`;
      const used = w.usedPercent === null ? '' : `${w.usedPercent.toFixed(1)}%`;
      const pct = w.usedPercent === null ? '—' : t(`剩餘 ${left}（已使用 ${used}）`, `${left} left (${used} used)`);
      const observed = w.observedAt ? new Date(w.observedAt).toLocaleString() : '';
      const stale = w.stale && w.observedAt ? t(` _(${observed} 的舊值)_`, ` _(stale, from ${observed})_`) : '';
      const resetAt = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '';
      const reset = w.resetsAt ? t(` · 重置 ${resetAt}`, ` · resets ${resetAt}`) : '';
      md.appendMarkdown(`- ${w.label}${t('：', ': ')}${pct}${stale}${reset}\n`);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(
    t('_本面板不會自動更新，點擊開啟面板後手動重新整理。_', '_This panel never refreshes on its own. Click to open it and refresh manually._')
  );
  return md;
}

function statusText(status: SerializedSnapshot['status']): string {
  switch (status) {
    case 'ok':
      return t('正常', 'OK');
    case 'not_logged_in':
      return t('未登入', 'Not signed in');
    case 'cli_not_found':
      return t('未偵測到 CLI', 'CLI not found');
    case 'unsupported':
      return t('不支援', 'Unsupported');
    case 'error':
      return t('錯誤', 'Error');
  }
}
