# Keynote Live Translator App/pkg 規格書

## 目標

macOS `.app` 以 `.pkg` 安裝到 `/Applications`。使用者開啟 App、輸入自己的 OpenAI API key、選擇字幕模式、按「開始」即可使用。

## 字幕模式

1. 雙語字幕
   - 翻譯：`gpt-realtime-translate`（WebRTC）。
   - 原文：預設用 `gpt-live-transcribe`（WebSocket，可設定關鍵字與情境說明）；
     也可在「設定 > 辨識」改用翻譯連線附帶的原文（費用約減半）。
2. 只顯示翻譯：只連 `gpt-realtime-translate`，仍會記錄翻譯連線附帶的原文逐字稿。
3. 只顯示原文：只連 `gpt-live-transcribe`。

## 架構

- `src/macos/`：Swift AppKit + WKWebView，編譯成 arm64 + x86_64 universal binary，不再內附 Node.js。
- `StaticServer.swift`：Network.framework，只綁 `127.0.0.1`，只提供 `public/` 靜態檔，檢查 Host 標頭；
  優先使用 8787（讓 localStorage 設定沿用），被佔用時改用隨機埠。
- `NativeBridge.swift`：`window.webkit.messageHandlers.klt`（`WKScriptMessageHandlerWithReply`），
  只接受本機頁面主框架的訊息；提供 API 呼叫、存檔（NSSavePanel）、全螢幕、防休眠、離開確認、字幕視窗。
- `RealtimeBackend.swift`：金鑰保管與驗證、向 OpenAI 換短效 client secret；規則與
  `server/realtime.mjs` 相同，由 `tests/contract.test.mjs` 比對。
- `KeychainStore.swift`：使用者勾選「記住金鑰」時存入登入鑰匙圈。

## 即時處理

- 麥克風 track 直接送 WebRTC（翻譯）；AudioWorklet 轉成 24 kHz PCM16 送 WebSocket（轉錄）、音量表與 VAD。
- 每句話結束（VAD 偵測靜音）才 commit，最長 15–25 秒強制分段。
- 斷線自動重連；55 分鐘時無縫換新連線（Realtime 單次連線上限 60 分鐘）。
- 停止時翻譯送 `session.close` 等 `session.closed`，轉錄等最後一句 `completed`。

## 繁體中文

- 原始文字保存在逐字稿裡，顯示與匯出時才整段經 OpenCC（cn → twp）轉換，避免逐字轉換造成詞語錯誤。
- OpenCC 載入失敗時才使用內建的簡易對照表（不含 里/后/云 等需要依上下文判斷的字）。

## UI/UX

- 頂端：狀態（燈號、計時、句數、兩條連線狀態、音量表）、開始/停止、模式、原文、翻譯、記錄逐字稿、匯出、投影模式、逐字稿、設定、金鑰。
- 設定抽屜：收音（麥克風、測試、音訊處理、收音距離）、辨識（雙語原文來源、轉錄延遲、關鍵字、情境說明）、
  顯示（字級、播放翻譯語音、投影背景、對齊、暫停顯示、字幕視窗）、逐字稿與匯出、清除、快捷鍵。
- 投影模式隱藏所有控制；字幕視窗可放到第二螢幕。

## macOS 整合

- 主選單（編輯選單讓 ⌘C/⌘V/⌘A 可用）、視窗位置記憶、深色啟動背景。
- 直播中防止螢幕休眠與 App Nap；有未匯出的逐字稿或直播中時，關窗/結束前確認。
- 麥克風權限只授予本機頁面；外部連結交給預設瀏覽器。

## 打包

- `npm run build:app`：universal app，ad-hoc 簽章；設定 `CODESIGN_IDENTITY` 時改用 Developer ID + hardened runtime。
- `npm run build:pkg`：BundleIsRelocatable = NO，一定安裝到 `/Applications`；
  可用 `INSTALLER_IDENTITY` 簽 pkg、`NOTARY_PROFILE` 或 App Store Connect API key 公證。

## 測試

- `npm test`：單元測試、server 安全性、連線控制器、Swift ↔ Node 合約測試。
- `npm run test:macos`：在不顯示的 WKWebView 中載入真正的 UI，驗證原生橋接與靜態 server。
- 真實 API 測試仍需人工：雙語、只翻譯、只原文三種模式各跑一次，確認字幕、停止收尾與 SRT 匯出。
