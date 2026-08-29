# Changelog

本檔案格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本編號依循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

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
