# Changelog

本檔案格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本編號依循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [0.1.5] — 2026-10-13

### Changed

- `quotaDeck.claude.autoProbeOnStale` 預設改為**關閉**。Haiku probe 是一次真正的 API 請求、會計入 Claude 用量，不應該在使用者不知情時因按下重新整理而觸發。README 的隱私聲明與 token 說明同步修正（移除不正確的「約 2 tokens」說法）。
- 自動 probe 失敗時，卡片訊息會寫出失敗原因，不再靜默略過。
- 手動 probe 與自動 probe 同時觸發時共用同一次請求。
- 重新整理時不再先呼叫 `detect()` 再 `fetch()`：Antigravity 少做一次 PowerShell process 掃描（約 1–2 秒）。
- 讀取 Claude 對話紀錄與 Codex rollout 改為非同步並只讀檔尾，不再阻塞 extension host。
- 移除每次都會白跑的 `codex usage --json` 探測。
- 面板上的相對時間（「3 分鐘前」「還有 2 小時」）每分鐘重繪一次；只重繪畫面，不會讀取任何資料。
- 介面、訊息與設定說明支援英文，跟隨 VSCode 顯示語言（`zh-*` 為繁體中文）。

### Fixed

- Windows 上用 `npm i -g` 安裝的 `claude.cmd` / `codex.cmd` 無法偵測與執行（Node 18.20.2 起不經 shell 執行 .cmd 會丟 `EINVAL`）。現在會在 `PATH` 中尋找 `.cmd`，並經由 `cmd.exe` 以安全引用的參數執行；逾時時連同子程序一起結束，不留孤兒程序。
- `usage_snapshot.json` 只有部分視窗（例如 probe 只拿到 5 小時窗）時，會蓋掉 `~/.claude.json` 中的每週與 Opus/Sonnet 額度。現在以較新的來源為主，缺少的視窗由較舊來源補上並保留其資料時間。
- 寫入 `usage_snapshot.json` 時會保留 statusline、Agora 等其他工具寫入的欄位。
- Log 遮蔽對 `sk-…` 與 JWT 形式的字串實際上沒有作用（秘密被當成前綴原樣保留）。

### Removed

- 未使用的程式碼：`watchForUsageCacheUpdate`、`readUsageCacheFetchedAt`、`SNAPSHOT_STALE_AFTER_MS`、`allProviders`、`SnapshotCache.clear`、各 provider 的 `detect()`。

### Internal

- 三個 provider 重複的格式化工具抽到 `src/util/format.ts`。
- `codex app-server` 的 `clientInfo.version` 改由 `package.json` 帶入。
- CSP nonce 改用 `crypto.randomBytes`。
- 新增 `npm test`（`node:test`），涵蓋 Claude / Codex / Antigravity 的 parser、來源合併、Windows 參數引用、log 遮蔽等純函式。
- `.vscode/` 加入 `.gitignore`。

## [0.1.4] — 2026-10-08

### Added

- 支援 Claude Code 背景快速探測（Haiku probe）：在背景以極短的 Haiku 請求（約 2 tokens）取得 `rate_limit_event`，直接獲得官方即時 5 小時與 7 天額度，無需開啟終端機手動輸入 `/usage`。
- 支援讀取與同步 `~/.claude/usage_snapshot.json`，完整相容 Agora 與 Claude Code 狀態列（statusline）腳本。
- 新增設定 `quotaDeck.claude.autoProbeOnStale`（預設開啟）：按下「重新整理全部」或「重新整理 Claude」時，若快取已過期（超過 15 分鐘）或不存在，自動在背景觸發 Haiku probe 取得最新用量。

### Changed

- 將 Claude Code 快照的過期門檻統一為 15 分鐘（比照 Codex），避免在短時間內頻繁顯示「過期」徽章。
- 卡片按鈕由「執行 /usage 取得當下數字」改為「背景探測即時額度 (Haiku Probe)」。

## [0.1.3] — 2026-09-07

### Fixed

- Claude 卡片維持以「剩餘」為主要百分比，並在同一列明列 Claude `/usage` 的
  「已使用」原始數字，釐清 100% 已使用等於 0% 剩餘，避免方向誤判。

## [0.1.1] — 2026-09-07

### Fixed

- 支援 Claude Code 新版 `cachedUsageUtilization.utilization.limits[]` 用量格式，
  並保留舊版 `five_hour` / `seven_day` 欄位作為 fallback。
- 強化 `/usage` 快取更新偵測，避免檔案置換事件遺失時無法刷新卡片。
- 保留既有 Marketplace extension ID `richard-jheng.ai-usage-panel`，讓 Quota Deck
  以原套件更新方式安裝，不再產生第二個擴充套件。

## [0.1.0] — 2026-08-29

### Added

- 專案鷹架：`package.json` contributes 宣告、esbuild 打包、TypeScript strict 設定
  （另含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- WebviewView 面板，同時註冊到 Activity Bar 與底部 Panel 兩個容器，
  可用 VSCode 內建拖曳搬到右側 Secondary Side Bar；三個位置共用同一份狀態。
- `Quota Deck: Open in Editor` 指令，將面板以 Webview Panel 開在編輯器分頁。
- Provider 抽象層與三家的降級鏈：
  - **Claude Code**：`claude auth status --json` → `~/.claude.json` 的
    `cachedUsageUtilization`（官方百分比快取）→ `~/.claude/projects` 本地估算。
  - **OpenAI Codex**：探測 `codex usage --json` → `codex login status` →
    rollout jsonl 內的 `rate_limits`（官方 5 小時 / 每週百分比）→ 本地 token 估算。
  - **Google Antigravity**：process 掃描 `agy --hub-port` → `/healthz` 驗活 →
    首頁取 `csrfToken` → `GetUserStatus`（帶 `x-codeium-csrf-token`）；
    備援為 language server 的 port 旗標與 `daemon/ls_*.json` discovery file。
- CLI 路徑解析器：`PATH` 找不到時自動探測 VSCode / Antigravity IDE / Cursor /
  Windsurf 擴充套件內附的 `claude.exe` 與 `codex.exe`。
- Antigravity 卡片依模型家族分開顯示 Claude / Gemini / GPT-OSS 三個獨立配額池，
  並顯示 prompt 與 flow credits。
- `globalState` 快取，重開 VSCode 時先顯示上次結果並標註為「快取」。
- 單一狀態列摘要項目（MarkdownString tooltip，不自訂顏色）與 Output channel logger。
- 手動更新：面板的「重新整理全部」、每張卡片的單獨重新整理、view title bar 的
  `refresh` 按鈕，以及五個 Command Palette 指令。

### 資料誠實度

- 本機來源的百分比一律附上「數據時間」，超過門檻標示為過期（黃色徽章、`~` 前綴、
  半透明條紋進度條）。Codex 門檻 15 分鐘；Claude 因為 `cachedUsageUtilization`
  只有在 REPL 執行 `/usage` 時才會被改寫、完全不會自我更新，門檻壓到 2 分鐘。
- **重置時刻已經過去的視窗，百分比一律作廢**。例如 Codex 在 13:15 寫下
  「5 小時窗 57%、resets_at 14:59」，到了 21:00 那個視窗早已結束、額度歸零，
  再畫一條 57% 的進度條是錯的；現在會顯示「—」與「此視窗已於 14:59 重置，
  額度應已歸零」，舊值保留在 tooltip 供參考。

### Security

- 不讀取 `~/.claude/.credentials.json`，不使用 Claude 的 OAuth accessToken
  呼叫 Anthropic 非公開 endpoint（Anthropic Consumer ToS）。
- 不實作 Google OAuth，不觸碰 `cloudcode-pa.googleapis.com`。
- 所有網路請求都只發往 `127.0.0.1`；TLS 放寬僅綁定在 loopback agent 上。
- Output channel 與 `globalState` 都會遮蔽 / 排除 token 與 credential。

### 設計決定

- **不實作任何自動輪詢或定時更新。** 除了是需求之外，社群已回報這類監控工具的
  輪詢行為本身會消耗配額，純手動觸發可完全避免此副作用。
