# Quota Deck

在單一面板中檢視 **Claude Code**、**OpenAI Codex**、**Google Antigravity** 三個 AI 編碼助手的用量與配額。

純手動更新、資料只在本機讀取，不會把任何東西送到第三方伺服器。

***

## 安裝 · Installation

### 中文

**需求**：VSCode `1.90.0` 或更新版本。

1. 到 [Releases](https://github.com/ITE-Richard/quota-deck/releases/latest) 下載 `quota-deck-0.1.0.vsix`。
2. 用下列任一種方式安裝：

   **方式 A — VSCode 介面**

   開啟 VSCode → 左側 **Extensions**（`Ctrl+Shift+X`）→ 右上角 `...` →
   **Install from VSIX...** → 選擇剛才下載的 `.vsix` 檔。

   **方式 B — 命令列**

   ```bash
   code --install-extension quota-deck-0.1.0.vsix
   ```

   **方式 C — 命令面板**

   `Ctrl+Shift+P` → 輸入 `Extensions: Install from VSIX...` → 選擇檔案。

3. 安裝完成後重新載入視窗（`Ctrl+Shift+P` → `Developer: Reload Window`），
   左側 Activity Bar 就會出現 Quota Deck 圖示。

**更新版本**：直接安裝新的 `.vsix` 即可覆蓋舊版，不需要先移除。

**移除**：Extensions 面板找到 Quota Deck → 齒輪 → **Uninstall**，
或執行 `code --uninstall-extension richard-jheng.quota-deck`。

> 本套件同樣可以裝在 VSCode 的衍生編輯器（Cursor、Windsurf、Antigravity IDE）上，
> 把上面的 `code` 換成該編輯器的 CLI（`cursor` / `windsurf`）即可。

### English

**Requires** VSCode `1.90.0` or newer.

1. Download `quota-deck-0.1.0.vsix` from the [latest release](https://github.com/ITE-Richard/quota-deck/releases/latest).
2. Install it in any of these ways:

   **Option A — VSCode UI**

   Open VSCode → **Extensions** sidebar (`Ctrl+Shift+X`) → `...` menu in the top-right →
   **Install from VSIX...** → pick the `.vsix` file you downloaded.

   **Option B — command line**

   ```bash
   code --install-extension quota-deck-0.1.0.vsix
   ```

   **Option C — command palette**

   `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → pick the file.

3. Reload the window (`Ctrl+Shift+P` → `Developer: Reload Window`). The Quota Deck
   icon appears in the Activity Bar.

**Upgrading**: just install the newer `.vsix` over the old one — no need to uninstall first.

**Uninstalling**: Extensions panel → Quota Deck → gear icon → **Uninstall**, or run
`code --uninstall-extension richard-jheng.quota-deck`.

> The extension also installs into VSCode forks (Cursor, Windsurf, Antigravity IDE) —
> swap `code` for that editor's CLI (`cursor` / `windsurf`).

***

## 使用方式 · Usage

### 中文

**打開面板**

安裝後點左側 Activity Bar 的 Quota Deck 圖示。面板也可以放在另外兩個位置，三處共用同一份狀態：

- **右側 Secondary Side Bar**：把 view 直接拖過去（VSCode 原生行為）
- **底部 Panel 區**：`Ctrl+Shift+P` → `View: Show Quota Deck`
- **編輯器分頁**：`Ctrl+Shift+P` → `Quota Deck: Open in Editor`

**取得數字**

**本套件不會自動更新**（原因見下方「為什麼不做自動更新」），每次都要自己觸發：

- 面板上的「重新整理全部」按鈕，或 view title bar 的 `refresh` 圖示
- 每張卡片右上角可以只重新整理該家
- 或用命令面板：`Quota Deck: Refresh All` / `Refresh Claude` / `Refresh Codex` / `Refresh Antigravity`

重開 VSCode 時會先顯示上次的結果並標註「快取」，按一次重新整理才會去抓新數字。

**讀懂卡片**

| 你看到的 | 意思 |
|---|---|
| `47%` | 已使用的比例（注意：ChatGPT 網頁顯示的是**剩餘**，方向相反） |
| `~47%` + 黃色「過期」徽章 + 條紋進度條 | 這個數字來自本機快取，已超過門檻時間，僅供參考 |
| `—` 加上「此視窗已重置」 | 該計費視窗的重置時刻已經過去，舊百分比已作廢 |
| 「來源」欄位 | 這一次實際走的是哪一條降級鏈（見下方「資料來源」） |

**讓數字更準確**

- **Claude**：`cachedUsageUtilization` 只有在 Claude Code REPL 內執行 `/usage` 時才會被改寫。
  想看到新數字，先在 Claude Code 執行一次 `/usage`，再回面板按重新整理。
- **Antigravity**：必須讓 Antigravity IDE 正在執行，否則本機 hub 沒有 port 可連，卡片會提示你先開啟它。
- **Codex**：不需要額外動作，會直接向 Codex CLI 自己的 `app-server` 查詢即時數字。

**狀態列**

狀態列會顯示一則摘要（預設是剩餘額度最少的那一家），滑鼠移上去可看三家概況。
可用 `quotaDeck.statusBar.provider` 指定固定顯示某一家，或用 `quotaDeck.showStatusBarItem` 關閉。

**出問題時**

`Ctrl+Shift+P` → `Quota Deck: Show Logs` 開啟 Output channel。
把 `quotaDeck.debug` 設為 `true` 可輸出詳細 log（log 會遮蔽 token 與 credential）。
找不到 CLI 的話見下方「找不到 CLI 怎麼辦」。

### English

**Opening the panel**

Click the Quota Deck icon in the Activity Bar. The panel can live in three places, all sharing one state:

- **Secondary Side Bar (right)** — drag the view over there (standard VSCode behaviour)
- **Bottom panel** — `Ctrl+Shift+P` → `View: Show Quota Deck`
- **Editor tab** — `Ctrl+Shift+P` → `Quota Deck: Open in Editor`

**Getting numbers**

**Nothing refreshes automatically** (see "為什麼不做自動更新" below for why). You always trigger it yourself:

- The "refresh all" button in the panel, or the `refresh` icon in the view title bar
- Each card has its own refresh button for that provider only
- Or the command palette: `Quota Deck: Refresh All` / `Refresh Claude` / `Refresh Codex` / `Refresh Antigravity`

On VSCode restart the last result is restored from cache and labelled as such; hit refresh to fetch fresh numbers.

**Reading a card**

| What you see | What it means |
|---|---|
| `47%` | Percentage **used** (note: the ChatGPT web UI shows *remaining* — opposite direction) |
| `~47%` + yellow "stale" badge + striped bar | Value came from a local cache and is older than the staleness threshold — treat as indicative only |
| `—` with "window already reset" | That billing window's reset time has passed, so the old percentage is void |
| The "source" row | Which fallback path actually produced this number (see the data-source tables below) |

**Getting more accurate numbers**

- **Claude** — `cachedUsageUtilization` is only rewritten when you run `/usage` inside the Claude Code REPL.
  Run `/usage` there first, then hit refresh in the panel.
- **Antigravity** — Antigravity IDE must be running, otherwise there is no local hub port to reach;
  the card will tell you to start it.
- **Codex** — nothing extra needed; numbers come live from the Codex CLI's own `app-server`.

**Status bar**

A single status-bar item summarises usage (by default whichever provider has the least headroom left);
hover for all three. Pin one provider with `quotaDeck.statusBar.provider`, or hide the item entirely
with `quotaDeck.showStatusBarItem`.

**Troubleshooting**

`Ctrl+Shift+P` → `Quota Deck: Show Logs` opens the Output channel. Set `quotaDeck.debug` to `true`
for verbose logging (tokens and credentials are redacted). If a CLI can't be found, see
"找不到 CLI 怎麼辦" below.

***

## 功能

- **三個顯示位置，同一份狀態**
  - 左側 Activity Bar（自訂 view container）
  - 底部 Panel 區
  - 右側 Secondary Side Bar（把 view 拖過去即可，VSCode 原生支援）
  - `Quota Deck: Open in Editor` 可另外把面板開成中間編輯器區的分頁
- 每個 provider 一張卡片：登入狀態、帳號、方案、短/長週期百分比、進度條、重置倒數與絕對時刻、資料時間戳與**資料來源**
- **過期資料一定看得出來**：Claude 與 Codex 的百分比都來自本機快取／紀錄，可能遠早於你按下重新整理的時間。超過 15 分鐘的數字會標上「過期」徽章、百分比前面加 `~`、進度條變成半透明條紋，並在該列直接寫出「數據時間」。狀態列與 tooltip 同樣會加 `~` 與舊值時間。這是刻意設計——寧可讓你知道數字舊了，也不要讓一個五小時前的快照看起來像當下值。
- Antigravity 額外分開顯示 **Claude 池 / Gemini 池**（兩者是完全獨立的配額池）以及 prompt / flow credits
- 未登入時卡片變 dimmed 並提供「登入」按鈕（在 integrated terminal 執行對應指令）
- 未安裝 CLI 時顯示「未偵測到 CLI」與安裝連結
- 單一狀態列摘要項目，tooltip 列出三家概況
- 結果寫入 `globalState`；重開 VSCode 先顯示上次結果並標註「快取」

## 為什麼不做自動更新

這是刻意的設計決定，本套件**沒有任何 `setInterval`、定時輪詢或啟動時自動抓取**。

1. 這是使用者要求的行為。
2. 更實際的理由：社群已回報這類監控工具的**輪詢行為本身會消耗配額**，甚至在登出狀態下仍持續扣減。純手動觸發可以完全避免這個副作用。

啟動時只會從快取還原上次結果（卡片上會標示「快取」），要拿到新數字必須自己按重新整理。

## 資料來源與各自的限制

三家 CLI **都沒有提供乾淨的非互動式用量查詢指令**。以下是本套件實際採用的降級鏈，卡片上的「來源」欄位會顯示這一次實際走的是哪一條。

### Claude Code

| 順序 | 路徑 | 取得什麼 |
|---|---|---|
| 1 | `claude auth status --json` | 登入狀態、email、`orgName`、`subscriptionType` |
| 2 | `~/.claude.json` 的 `cachedUsageUtilization` | **官方百分比**（`five_hour` / `seven_day` / `limits[]`）與各自的 `resets_at` |
| 3 | `~/.claude/projects/**/*.jsonl` | 本地 token 加總估算 |

**限制**：`/usage` 只存在於互動式 REPL，沒有對應的非互動子指令。第 2 條拿到的是 Claude Code **自己寫下的快取**，而且實測發現它**不會隨著用量變動自動更新**——`~/.claude.json` 這個檔本身每隔幾分鐘就被改寫，但 `cachedUsageUtilization` 區塊可以停在好幾小時前。實測案例：檔案 mtime `14:49`，`fetchedAtMs` 卻是 `10:08`，當時真實用量已經是 5 小時 92% / 每週 53%，快取裡卻還是 0% / 45%。

要刷新它，請在 Claude Code 的 REPL 內執行 `/usage`，再回到面板按重新整理。實測紀錄：

```
20:53:08  fetchedAtMs=10:08:29   0% / 45%   ← /usage 之前，已經停了 10 小時
20:54:42  fetchedAtMs=20:54:42   8% / 55%   ← /usage 觸發了唯一一次刷新
21:00:10  fetchedAtMs=20:54:42   8% / 55%   ← 之後就不再變動
```

而且**即使剛刷新過，它仍然只是一個時間點的快照**。同一個案例裡，`/usage` 面板在 4 分鐘後已經顯示 14%，本機檔案卻還停在 8%——密集使用時幾分鐘就能差好幾個百分點。因此 Claude 卡片的過期門檻壓到 **2 分鐘**，實務上等於永遠標示為快照，這正是這個來源的真實性質。

`~/.claude/sessions/*.json`（只有 pid / sessionId / named pipe）與 `~/.claude/ide/*.lock`（IDE websocket 的 authToken，屬於憑證，本套件不讀取）都不含用量資訊。**Claude 沒有任何會自我更新的本機用量來源。**

第 2 條讀不到時只剩本地估算，此時百分比會是 `—`，卡片會明確標示「本地紀錄估算」。

> **關於 Anthropic ToS 的注意事項**
>
> 本套件**不會**讀取 `~/.claude/.credentials.json` 的 `accessToken`，也**不會**拿它去呼叫 `https://api.anthropic.com/api/oauth/usage`。
> 該 OAuth token 依 Anthropic Consumer ToS 僅限 Claude Code 與 Claude.ai 使用，第三方工具使用可能導致帳號停權。這條路本套件刻意不實作。
>
> 另外，Claude Code 使用 lock file 協調多個實例的 token refresh。本套件**只讀不寫、絕不主動 refresh token**，不會讓你手上的 Claude Code session 失效。

### OpenAI Codex

| 順序 | 路徑 | 取得什麼 |
|---|---|---|
| 1 | **`codex app-server` 的 `account/rateLimits/read`** | **官方即時數字**，不消耗配額 |
| 2 | `codex usage --json` | 目前**不存在**，僅做探測；未來若出現會用它 |
| 3 | `codex login status` | 登入狀態（`Not logged in` / `Logged in using ChatGPT`） |
| 4 | `${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl` | `token_count` 事件內的 `rate_limits`（快照，會過期） |
| 5 | 同上 rollout 檔的 `total_token_usage` | 本地 token 估算 |

第 1 條是 Codex CLI **自己的**查詢管道（性質等同 `claude auth status --json`）：以 stdio JSON-RPC 送出 `initialize`，再送 `account/rateLimits/read`，拿到結果就結束程序。本套件**沒有**讀 `auth.json`、也沒有自己去打任何 OpenAI endpoint。

回傳內容（camelCase）：`primary` 是 5 小時窗（`windowDurationMins: 300`）、`secondary` 是每週窗（`10080`），另有 `credits`、`planType`，以及 `rateLimitsByLimitId` 裡的其他限額池（例如 `base_model_inference` / `gpt-reserve`）與 `rateLimitResetCredits`（用量重置點數）。

已與 ChatGPT 網頁版「設定 → 使用量」逐項核對過。注意單位方向相反：**網頁顯示剩餘，本套件顯示已使用**（剩餘 79% = 已使用 21%）。

**限制**：`/status` 與 `/usage` 只在 TUI 內；`codex login status` 沒有 `--json`。第 4 條是 Codex 在你**實際使用時**才寫入的，所以會過期——只有在 app-server 查不到時才會退回它，且卡片會標出寫入時間並把已經滾過去的視窗作廢。本機來源沒有 email，帳號欄位會 fallback 顯示方案名稱（例如 `Plus`）。

`quotaDeck.codex.allowDirectApi`（預設 `false`）保留給「讀取本機 `auth.json` 並直接查 rate limit」這條路徑。目前**沒有經過驗證的公開 endpoint**，本套件不會去猜測未公開的 API，因此開啟後只會顯示說明訊息而不會發出任何請求。第 3 條已經能提供官方數字，正常情況下不需要開啟它。

### Google Antigravity

唯一可行的路徑是連本機的 language server / hub，**不需要任何 OAuth 登入**，因此安全性最好。

| 順序 | 路徑 |
|---|---|
| 1 | 掃描 process 找 `agy.exe --hub --hub-port=<port>`（VSCode 擴充套件與 Antigravity IDE 的實際做法） |
| 2 | 備援：掃描 language server 的 `-https_server_port` / `-http_server_port` / `-csrf_token`（standalone / persistent 模式） |
| 3 | 備援：`~/.gemini/{antigravity,antigravity-ide}/daemon/ls_*.json` discovery file（含 `httpPort` / `httpsPort` / `csrfToken`，並以 `pid` 驗活） |
| 4 | `GET /healthz` 驗活 → `GET /` 取出 `window.__APP_CONFIG__.csrfToken` → `POST /exa.language_server_pb.LanguageServerService/GetUserStatus` |

請求必須帶 header **`x-codeium-csrf-token`**，否則會得到 `401 {"code":"unauthenticated","message":"missing CSRF token"}`。

`GetUserStatus` 回傳 `name` / `email` / `planName` / `userTier`，以及
`cascadeModelConfigData.clientModelConfigs[].quotaInfo{remainingFraction, resetTime}`——這就是各模型的獨立配額，本套件依模型家族分成 **Claude 池 / Gemini 池 / GPT-OSS 池** 顯示，池內以剩餘量最少的模型為代表。

**限制與注意事項**：

- `/usage`（別名 `/quota`）會刷新配額並開啟互動式 TUI，沒有非互動指令可用。
- hub 的 port 是**每次啟動隨機的 ephemeral port**，Antigravity 沒在跑的時候什麼都讀不到——卡片會提示你先開啟 Antigravity。
- Antigravity 是雙重限制：**5 小時滾動 sprint 額度**與**每週 baseline 硬上限**。撞到週上限時，5 小時刷新會完全失效並鎖到下週，所以**只看 5 小時百分比會誤導你**。然而本機端點**沒有回傳每週 baseline**，本套件不會憑空推估一個數字，卡片上會明講這件事。
- `GetCommandModelConfigs` 在目前版本回 `501 unimplemented`，沒有備援價值。
- 本機 loopback 用的是自簽憑證。本套件優先走 hub 的 **HTTP** port，**正常情況下完全不需要放寬 TLS 驗證**；只有退回 HTTPS port 時才會使用一個綁死 `127.0.0.1` 的 agent，不會動全域 TLS 設定。

> 本套件**不會**實作 `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` 那條雲端路徑。它需要 Google OAuth，而把 refresh token 存成純文字是已知的安全問題。

## 隱私聲明

- **本套件不傳送任何資料到第三方伺服器，僅在本機讀取。**
- 全部的網路請求都只發往 `127.0.0.1` 的本機 Antigravity language server。沒有遙測、沒有分析、沒有外連。
- 不讀取也不使用 Claude 的 OAuth `accessToken`；不實作任何 OAuth 流程；不把任何 refresh token 落地成檔案。
- 只讀取「當前環境已登入」的帳號，不做多帳號管理。
- `globalState` 只存放已經整理過的摘要（百分比、方案名稱、時間戳），**不存放任何 token 或 credential**。
- Output channel 的 log 會再經過一次遮蔽，不會輸出 token、CSRF token 或 API key。

## 設定

| 設定 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `quotaDeck.providers.claude.enabled` | boolean | `true` | 是否顯示 Claude 卡片 |
| `quotaDeck.providers.codex.enabled` | boolean | `true` | 是否顯示 Codex 卡片 |
| `quotaDeck.providers.antigravity.enabled` | boolean | `true` | 是否顯示 Antigravity 卡片 |
| `quotaDeck.claude.cliPath` | string | `"claude"` | Claude CLI 路徑 |
| `quotaDeck.codex.cliPath` | string | `"codex"` | Codex CLI 路徑 |
| `quotaDeck.codex.allowDirectApi` | boolean | `false` | 允許讀 `auth.json` 直接查 rate limit（見上方說明） |
| `quotaDeck.commandTimeoutMs` | number | `10000` | CLI 執行與本機請求的 timeout |
| `quotaDeck.showStatusBarItem` | boolean | `true` | 是否顯示狀態列摘要 |
| `quotaDeck.statusBar.provider` | enum | `"lowest"` | 狀態列顯示哪一家（`lowest` = 剩餘最少的那家） |
| `quotaDeck.debug` | boolean | `false` | 輸出詳細 log 到 Output channel |

### 找不到 CLI 怎麼辦

在 Windows + VSCode 上，`claude` 與 `codex` 常常**不在 `PATH`**，而是被包在擴充套件目錄裡。本套件會自動探測這些位置：

- `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude.exe`
- `~/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex.exe`
- 以及 `.vscode-insiders` / `.antigravity-ide` / `.antigravity` / `.cursor` / `.windsurf` 的對應目錄

還是找不到的話，用 `quotaDeck.claude.cliPath` / `quotaDeck.codex.cliPath` 指定完整路徑即可。

## 指令

| 指令 | 說明 |
|---|---|
| `Quota Deck: Refresh All` | 重新整理全部（也是 view title bar 上的 `refresh` 按鈕） |
| `Quota Deck: Refresh Claude` | 只重新整理 Claude |
| `Quota Deck: Refresh Codex` | 只重新整理 Codex |
| `Quota Deck: Refresh Antigravity` | 只重新整理 Antigravity |
| `Quota Deck: Open in Editor` | 把面板開在中間編輯器區 |
| `Quota Deck: Show Logs` | 開啟 Output channel |

## 開發

```bash
npm install
npm run watch      # esbuild watch
npm run typecheck  # tsc --noEmit
npm run build      # production bundle
npm run package    # 產出 .vsix（需要 @vscode/vsce）
```

在 VSCode 中按 `F5` 啟動 Extension Development Host。

## 授權

MIT，見 [LICENSE](LICENSE)。
