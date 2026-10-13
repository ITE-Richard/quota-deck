// @ts-check
/*
 * Quota Deck 的 webview 前端。
 * 原生 DOM，不引入任何框架；所有文字都用 textContent 寫入，不做 innerHTML 拼接。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** 語言由 extension 在產生 HTML 時寫進 <html lang>，與 src/i18n.ts 的判斷一致。 */
  const IS_ZH = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;

  /**
   * @param {string} zh
   * @param {string} en
   */
  function T(zh, en) {
    return IS_ZH ? zh : en;
  }

  const INSTALL_TEXT = T('安裝說明', 'Install guide');
  const PROVIDERS = [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'OpenAI Codex' },
    { id: 'antigravity', name: 'Google Antigravity' },
  ];

  /** @type {Record<string, string>} */
  const STATUS_TEXT = {
    ok: T('已登入', 'Signed in'),
    not_logged_in: T('未登入', 'Not signed in'),
    cli_not_found: T('未偵測到 CLI', 'CLI not found'),
    unsupported: T('不支援', 'Unsupported'),
    error: T('錯誤', 'Error'),
  };

  const cardsEl = /** @type {HTMLElement} */ (document.getElementById('cards'));
  const refreshAllBtn = /** @type {HTMLButtonElement} */ (document.getElementById('refresh-all'));
  const refreshAllSpinner = /** @type {HTMLElement} */ (refreshAllBtn.querySelector('.spinner'));
  const footerNote = /** @type {HTMLElement} */ (document.getElementById('footer-note'));

  setStaticText();

  /** @type {any} */
  let state = vscode.getState() || { snapshots: {}, loading: [], enabled: {}, detected: {} };

  refreshAllBtn.addEventListener('click', function () {
    if (!refreshAllBtn.disabled) {
      vscode.postMessage({ type: 'refresh' });
    }
  });

  document.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const actionEl = target.closest('[data-action]');
    if (!(actionEl instanceof HTMLElement)) {
      return;
    }
    const action = actionEl.dataset.action;
    const provider = actionEl.dataset.provider;
    if (action === 'show-logs') {
      event.preventDefault();
      vscode.postMessage({ type: 'showLogs' });
    } else if (action === 'refresh' && provider) {
      vscode.postMessage({ type: 'refresh', provider: provider });
    } else if (action === 'login' && provider) {
      vscode.postMessage({ type: 'login', provider: provider });
    } else if (action === 'install' && provider) {
      event.preventDefault();
      vscode.postMessage({ type: 'openInstall', provider: provider });
    } else if (action === 'claudeUsage') {
      vscode.postMessage({ type: 'claudeUsage' });
    }
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.type === 'state') {
      state = msg.state;
      vscode.setState(state);
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });

  // 只重新計算「3 分鐘前」「還有 2 小時」這類相對時間，不送任何訊息給 extension，
  // 不會觸發讀取——與「不自動更新」的原則不衝突。
  setInterval(function () {
    if (document.visibilityState === 'visible') {
      render();
    }
  }, 60 * 1000);

  function setStaticText() {
    /** @type {HTMLElement} */ (document.getElementById('toolbar-title')).textContent = T('AI 用量', 'AI Usage');
    /** @type {HTMLElement} */ (document.getElementById('refresh-all-label')).textContent = T('重新整理全部', 'Refresh all');
    /** @type {HTMLElement} */ (document.getElementById('show-logs-link')).textContent = T('檢視記錄', 'View logs');

    const note = /** @type {HTMLElement} */ (document.getElementById('manual-note-text'));
    const strong = document.createElement('strong');
    strong.textContent = T('不會自動更新', 'never refreshes on its own');
    note.append(T('本面板', 'This panel '), strong, T('，只有你按下重新整理時才會讀取。', '; it only reads data when you press refresh.'));
  }

  function render() {
    const loading = Array.isArray(state.loading) ? state.loading : [];
    const enabled = state.enabled || {};
    const snapshots = state.snapshots || {};
    const detected = state.detected || {};

    refreshAllBtn.disabled = loading.length > 0;
    refreshAllSpinner.hidden = loading.length === 0;

    const visible = PROVIDERS.filter(function (p) {
      return enabled[p.id] !== false;
    });

    cardsEl.textContent = '';

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = T(
        '三個 provider 都被停用了。請到設定中開啟至少一個 quotaDeck.providers.*.enabled。',
        'All three providers are disabled. Enable at least one quotaDeck.providers.*.enabled setting.'
      );
      cardsEl.appendChild(empty);
      footerNote.textContent = '';
      return;
    }

    for (const p of visible) {
      cardsEl.appendChild(buildCard(p, snapshots[p.id], loading.indexOf(p.id) !== -1, detected[p.id]));
    }

    const stamps = visible
      .map(function (p) {
        return snapshots[p.id] && snapshots[p.id].fetchedAt;
      })
      .filter(Boolean)
      .sort();
    footerNote.textContent = stamps.length
      ? T('最後一次更新：', 'Last updated: ') + formatAbsolute(stamps[stamps.length - 1])
      : T('尚未取得任何資料，請按「重新整理全部」。', 'No data yet. Press "Refresh all".');
  }

  /**
   * @param {{id: string, name: string}} provider
   * @param {any} snapshot
   * @param {boolean} isLoading
   * @param {boolean|undefined} isDetected
   */
  function buildCard(provider, snapshot, isLoading, isDetected) {
    const card = document.createElement('section');
    card.className = 'card';

    const status = snapshot ? snapshot.status : undefined;
    if (status === 'not_logged_in' || status === 'cli_not_found' || status === 'unsupported') {
      card.classList.add('dimmed');
    }

    // ---- 標題列 ----
    const head = document.createElement('div');
    head.className = 'card-head';

    const title = document.createElement('div');
    title.className = 'card-title';

    const dot = document.createElement('span');
    dot.className = 'status-dot ' + dotClass(status);
    title.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = provider.name;
    title.appendChild(name);

    if (status) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-muted';
      badge.textContent = STATUS_TEXT[status] || status;
      title.appendChild(badge);
    }

    if (snapshot && snapshot.cached) {
      const cachedBadge = document.createElement('span');
      cachedBadge.className = 'badge badge-muted';
      cachedBadge.textContent = T('快取', 'Cached');
      cachedBadge.title = T(
        '這是上次工作階段的結果，按重新整理才會重新讀取。',
        'This is the result from a previous session. Press refresh to read it again.'
      );
      title.appendChild(cachedBadge);
    }

    head.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-icon';
    refreshBtn.dataset.action = 'refresh';
    refreshBtn.dataset.provider = provider.id;
    refreshBtn.title = T('只重新整理 ', 'Refresh only ') + provider.name;
    refreshBtn.disabled = isLoading;
    if (isLoading) {
      const sp = document.createElement('span');
      sp.className = 'spinner';
      refreshBtn.appendChild(sp);
    } else {
      refreshBtn.textContent = '↻';
    }
    head.appendChild(refreshBtn);
    card.appendChild(head);

    // ---- 帳號 / 方案 ----
    const subParts = [];
    if (snapshot && snapshot.account) {
      subParts.push(snapshot.account);
    }
    if (snapshot && snapshot.plan) {
      subParts.push(snapshot.plan);
    }
    if (subParts.length > 0) {
      const sub = document.createElement('p');
      sub.className = 'card-sub';
      sub.textContent = subParts.join(' · ');
      card.appendChild(sub);
    }

    // ---- 未安裝 / 未登入 ----
    if (status === 'cli_not_found' || isDetected === false) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const link = document.createElement('a');
      link.href = '#';
      link.dataset.action = 'install';
      link.dataset.provider = provider.id;
      link.textContent = INSTALL_TEXT;
      actions.appendChild(link);
      card.appendChild(actions);
    } else if (status === 'not_logged_in') {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.className = 'btn';
      loginBtn.dataset.action = 'login';
      loginBtn.dataset.provider = provider.id;
      loginBtn.textContent = T('登入', 'Sign in');
      actions.appendChild(loginBtn);
      card.appendChild(actions);
    }

    // ---- 用量視窗 ----
    if (snapshot && snapshot.windows && snapshot.windows.length > 0) {
      const list = document.createElement('div');
      list.className = 'windows';
      for (const w of snapshot.windows) {
        list.appendChild(buildWindowRow(w, provider.id));
      }
      card.appendChild(list);
    } else if (status === 'ok') {
      const none = document.createElement('p');
      none.className = 'card-sub';
      none.textContent = T('沒有可顯示的用量數據。', 'No usage data to show.');
      card.appendChild(none);
    }

    // ---- credits ----
    if (snapshot && snapshot.credits) {
      const credits = document.createElement('p');
      credits.className = 'card-sub';
      credits.textContent =
        'Credits: ' + snapshot.credits.used.toLocaleString() + ' / ' + snapshot.credits.total.toLocaleString();
      card.appendChild(credits);
    }

    // ---- Claude 專屬：背景探測刷新快照 (Haiku probe) ----
    if (provider.id === 'claude' && snapshot && snapshot.status === 'ok') {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.dataset.action = 'claudeUsage';
      btn.textContent = T('背景探測即時額度 (Haiku Probe)', 'Probe live quota (Haiku probe)');
      btn.title = T(
        '在背景以 Haiku 送出一次極短的請求，從 rate_limit_event 取得官方即時額度。這是一次真正的 API 請求，會計入 Claude 用量。',
        'Sends one very short Haiku request in the background and reads the official live quota from rate_limit_event. This is a real API request and counts toward your Claude usage.'
      );
      btn.disabled = isLoading;
      actions.appendChild(btn);
      card.appendChild(actions);
    }

    // ---- 說明 / 錯誤訊息 ----
    if (snapshot && snapshot.message) {
      const msg = document.createElement('p');
      msg.className = 'card-message';
      msg.textContent = snapshot.message;
      card.appendChild(msg);
    }

    // ---- 資料時間與來源 ----
    const src = document.createElement('div');
    src.className = 'card-source';
    if (snapshot) {
      src.textContent =
        T('最後更新 ', 'Updated ') +
        formatRelative(snapshot.fetchedAt) +
        ' (' +
        formatAbsolute(snapshot.fetchedAt) +
        ') · ' +
        T('來源：', 'Source: ') +
        snapshot.source;
    } else {
      src.textContent = isLoading ? T('讀取中…', 'Loading…') : T('尚未讀取。', 'Not loaded yet.');
    }
    card.appendChild(src);

    return card;
  }

  /**
   * 面板主要數字一律顯示「剩餘」。Claude /usage 顯示的是「已使用」，因此
   * 另外在該列明列原始語意，讓 100% 已使用 = 0% 剩餘不會被誤解。
   * @param {any} w
   * @param {string} providerId
   */
  function buildWindowRow(w, providerId) {
    const row = document.createElement('div');
    row.className = 'window-row';

    const head = document.createElement('div');
    head.className = 'window-head';

    const label = document.createElement('span');
    label.className = 'window-label';
    label.textContent = w.label;
    if (w.raw) {
      label.title = w.raw;
    }
    head.appendChild(label);

    if (w.stale) {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'badge badge-stale';
      staleBadge.textContent = T('過期', 'Stale');
      staleBadge.title = T('這個數字是舊快照，不是當下的值。', 'This number is an old snapshot, not the current value.');
      head.appendChild(staleBadge);
    }

    const hasPercent = w.usedPercent !== null && w.usedPercent !== undefined;
    const used = hasPercent ? Math.max(0, Math.min(100, w.usedPercent)) : null;
    const remaining = used === null ? null : 100 - used;

    const percent = document.createElement('span');
    percent.className = 'window-percent' + (w.stale ? ' is-stale' : '');
    if (remaining === null || used === null) {
      percent.textContent = '—';
    } else {
      // 過期的數字加上 ~ 前綴，避免被當成當下值
      const value = (w.stale ? '~' : '') + remaining.toFixed(1) + '%';
      percent.textContent = T('剩餘 ' + value, value + ' left');
      percent.title = T('已使用 ', 'Used ') + used.toFixed(1) + '%';
    }
    head.appendChild(percent);
    row.appendChild(head);

    if (remaining !== null) {
      const meter = document.createElement('div');
      meter.className = 'meter';
      const fill = document.createElement('div');
      fill.className =
        'meter-fill' +
        (remaining <= 10 ? ' level-high' : remaining <= 30 ? ' level-mid' : '') +
        (w.stale ? ' is-stale' : '');
      fill.style.width = remaining + '%';
      meter.appendChild(fill);
      row.appendChild(meter);
    }

    const metaParts = [];
    if (providerId === 'claude' && used !== null) {
      metaParts.push(T('Claude /usage：已使用 ', 'Claude /usage: ') + used.toFixed(1) + T('%', '% used'));
    }
    if (w.observedAt) {
      metaParts.push(T('數據時間 ', 'Data from ') + formatAbsolute(w.observedAt) + ' (' + formatRelative(w.observedAt) + ')');
    }
    if (w.resetsAt) {
      const resetMs = new Date(w.resetsAt).getTime();
      if (!isNaN(resetMs) && resetMs <= Date.now()) {
        // 視窗已經滾過去，舊百分比不再適用
        metaParts.push(
          T(
            '此視窗已於 ' + formatAbsolute(w.resetsAt) + ' 重置，額度應已歸零',
            'This window reset at ' + formatAbsolute(w.resetsAt) + '; usage should be back to zero'
          )
        );
      } else {
        metaParts.push(T('重置：', 'Resets: ') + formatCountdown(w.resetsAt) + ' (' + formatAbsolute(w.resetsAt) + ')');
      }
    }
    if (w.raw && w.usedPercent === null) {
      metaParts.push(w.raw);
    }
    if (metaParts.length > 0) {
      const meta = document.createElement('div');
      meta.className = 'window-meta';
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);
    }

    return row;
  }

  /** @param {string|undefined} status */
  function dotClass(status) {
    if (status === 'ok') {
      return 'status-ok';
    }
    if (status === 'error') {
      return 'status-error';
    }
    if (status === 'not_logged_in' || status === 'cli_not_found' || status === 'unsupported') {
      return 'status-warn';
    }
    return '';
  }

  /** @param {string} iso */
  function formatAbsolute(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '—';
    }
    return d.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  /** @param {string} iso */
  function formatRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '—';
    }
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) {
      return T('剛剛', 'just now');
    }
    if (diffMin < 60) {
      return T(diffMin + ' 分鐘前', diffMin + ' min ago');
    }
    const hours = Math.floor(diffMin / 60);
    if (hours < 24) {
      return T(hours + ' 小時前', hours + ' h ago');
    }
    const days = Math.floor(hours / 24);
    return T(days + ' 天前', days + ' d ago');
  }

  /** @param {string} iso */
  function formatCountdown(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '—';
    }
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) {
      return T('已重置', 'reset');
    }
    const totalMin = Math.round(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) {
      return T('還有 ' + days + ' 天 ' + hours + ' 小時', 'in ' + days + ' d ' + hours + ' h');
    }
    if (hours > 0) {
      return T('還有 ' + hours + ' 小時 ' + mins + ' 分', 'in ' + hours + ' h ' + mins + ' min');
    }
    return T('還有 ' + mins + ' 分', 'in ' + mins + ' min');
  }
})();
