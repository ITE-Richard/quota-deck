// @ts-check
/*
 * AI Usage Panel 的 webview 前端。
 * 原生 DOM，不引入任何框架；所有文字都用 textContent 寫入，不做 innerHTML 拼接。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const PROVIDERS = [
    { id: 'claude', name: 'Claude Code', install: '安裝說明' },
    { id: 'codex', name: 'OpenAI Codex', install: '安裝說明' },
    { id: 'antigravity', name: 'Google Antigravity', install: '安裝說明' },
  ];

  const STATUS_TEXT = {
    ok: '已登入',
    not_logged_in: '未登入',
    cli_not_found: '未偵測到 CLI',
    unsupported: '不支援',
    error: '錯誤',
  };

  const cardsEl = /** @type {HTMLElement} */ (document.getElementById('cards'));
  const refreshAllBtn = /** @type {HTMLButtonElement} */ (document.getElementById('refresh-all'));
  const refreshAllSpinner = /** @type {HTMLElement} */ (refreshAllBtn.querySelector('.spinner'));
  const footerNote = /** @type {HTMLElement} */ (document.getElementById('footer-note'));

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
      empty.textContent = '三個 provider 都被停用了。請到設定中開啟至少一個 aiUsage.providers.*.enabled。';
      cardsEl.appendChild(empty);
      footerNote.textContent = '';
      return;
    }

    for (const p of visible) {
      cardsEl.appendChild(
        buildCard(p, snapshots[p.id], loading.indexOf(p.id) !== -1, detected[p.id])
      );
    }

    const stamps = visible
      .map(function (p) {
        return snapshots[p.id] && snapshots[p.id].fetchedAt;
      })
      .filter(Boolean)
      .sort();
    footerNote.textContent = stamps.length
      ? '最後一次更新：' + formatAbsolute(stamps[stamps.length - 1])
      : '尚未取得任何資料，請按「重新整理全部」。';
  }

  /**
   * @param {{id: string, name: string, install: string}} provider
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
      cachedBadge.textContent = '快取';
      cachedBadge.title = '這是上次工作階段的結果，按重新整理才會重新讀取。';
      title.appendChild(cachedBadge);
    }

    head.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-icon';
    refreshBtn.dataset.action = 'refresh';
    refreshBtn.dataset.provider = provider.id;
    refreshBtn.title = '只重新整理 ' + provider.name;
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
      link.textContent = provider.install;
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
      loginBtn.textContent = '登入';
      actions.appendChild(loginBtn);
      card.appendChild(actions);
    }

    // ---- 用量視窗 ----
    if (snapshot && snapshot.windows && snapshot.windows.length > 0) {
      const list = document.createElement('div');
      list.className = 'windows';
      for (const w of snapshot.windows) {
        list.appendChild(buildWindowRow(w));
      }
      card.appendChild(list);
    } else if (status === 'ok') {
      const none = document.createElement('p');
      none.className = 'card-sub';
      none.textContent = '沒有可顯示的用量數據。';
      card.appendChild(none);
    }

    // ---- credits ----
    if (snapshot && snapshot.credits) {
      const credits = document.createElement('p');
      credits.className = 'card-sub';
      credits.textContent =
        'Credits：' +
        snapshot.credits.used.toLocaleString() +
        ' / ' +
        snapshot.credits.total.toLocaleString();
      card.appendChild(credits);
    }

    // ---- Claude 專屬：跑 /usage 刷新快取 ----
    // Claude 的數字只有 REPL 內的 /usage 會改寫，所以給一個一鍵入口。
    if (
      provider.id === 'claude' &&
      snapshot &&
      snapshot.status === 'ok' &&
      snapshot.windows.some(function (w) {
        return w.stale;
      })
    ) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.dataset.action = 'claudeUsage';
      btn.textContent = '執行 /usage 取得當下數字';
      btn.title = '會開一個終端機跑 Claude Code 並送出 /usage（不消耗配額），偵測到快取更新後自動刷新這張卡片。';
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
    if (snapshot) {
      const src = document.createElement('div');
      src.className = 'card-source';
      src.textContent = '最後更新 ' + formatRelative(snapshot.fetchedAt) + '（' + formatAbsolute(snapshot.fetchedAt) + '）· 來源：' + snapshot.source;
      card.appendChild(src);
    } else {
      const src = document.createElement('div');
      src.className = 'card-source';
      src.textContent = isLoading ? '讀取中…' : '尚未讀取。';
      card.appendChild(src);
    }

    return card;
  }

  /** @param {any} w */
  function buildWindowRow(w) {
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
      staleBadge.textContent = '過期';
      staleBadge.title = '這個數字是舊快照，不是當下的值。';
      head.appendChild(staleBadge);
    }

    // 顯示「剩餘」而非「已使用」，與 ChatGPT 網頁版、Antigravity 的呈現方向一致。
    // 資料層一律以 usedPercent 為準，只有這裡做換算。
    const hasPercent = w.usedPercent !== null && w.usedPercent !== undefined;
    const remaining = hasPercent ? Math.max(0, Math.min(100, 100 - w.usedPercent)) : null;

    const percent = document.createElement('span');
    percent.className = 'window-percent' + (w.stale ? ' is-stale' : '');
    if (remaining === null) {
      percent.textContent = '—';
    } else {
      // 過期的數字加上 ~ 前綴，避免被當成當下值
      percent.textContent = '剩餘 ' + (w.stale ? '~' : '') + remaining.toFixed(1) + '%';
      percent.title = '已使用 ' + w.usedPercent.toFixed(1) + '%';
    }
    head.appendChild(percent);
    row.appendChild(head);

    if (remaining !== null) {
      const meter = document.createElement('div');
      meter.className = 'meter';
      const fill = document.createElement('div');
      // 條長 = 剩餘量；剩越少越警示
      fill.className =
        'meter-fill' +
        (remaining <= 10 ? ' level-high' : remaining <= 30 ? ' level-mid' : '') +
        (w.stale ? ' is-stale' : '');
      fill.style.width = remaining + '%';
      meter.appendChild(fill);
      row.appendChild(meter);
    }

    const metaParts = [];
    if (w.observedAt) {
      metaParts.push((w.stale ? '數據時間 ' : '數據時間 ') + formatAbsolute(w.observedAt) + '（' + formatRelative(w.observedAt) + '）');
    }
    if (w.resetsAt) {
      var resetMs = new Date(w.resetsAt).getTime();
      if (!isNaN(resetMs) && resetMs <= Date.now()) {
        // 視窗已經滾過去，舊百分比不再適用
        metaParts.push('此視窗已於 ' + formatAbsolute(w.resetsAt) + ' 重置，額度應已歸零');
      } else {
        metaParts.push('重置：' + formatCountdown(w.resetsAt) + '（' + formatAbsolute(w.resetsAt) + '）');
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
      return '剛剛';
    }
    if (diffMin < 60) {
      return diffMin + ' 分鐘前';
    }
    const hours = Math.floor(diffMin / 60);
    if (hours < 24) {
      return hours + ' 小時前';
    }
    return Math.floor(hours / 24) + ' 天前';
  }

  /** @param {string} iso */
  function formatCountdown(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '—';
    }
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) {
      return '已重置';
    }
    const totalMin = Math.round(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) {
      return '還有 ' + days + ' 天 ' + hours + ' 小時';
    }
    if (hours > 0) {
      return '還有 ' + hours + ' 小時 ' + mins + ' 分';
    }
    return '還有 ' + mins + ' 分';
  }
})();
