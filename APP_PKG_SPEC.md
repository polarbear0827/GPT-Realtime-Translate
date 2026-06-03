# Keynote Live Translator App/pkg 規格書

## 目標

把目前本機 Web 版轉成 macOS `.app`，並用 `.pkg` 安裝到 `/Applications`。正式 keynote 使用時，使用者只需要開啟 App、貼上自己的 OpenAI API key、選擇字幕模式、按 Start。

## 字幕模式

1. 雙語字幕
   - 同時啟動兩條 Realtime 路徑。
   - `gpt-realtime-whisper` 依使用者選擇的原文語言產生原文字幕。
   - `gpt-realtime-translate` 依使用者選擇的目標語言產生翻譯字幕。
   - 逐字稿同時記錄原文與翻譯。

2. 只顯示翻譯
   - 只啟動 `gpt-realtime-translate`。
   - 畫面只顯示翻譯區。
   - 翻譯目標語言目前 UI 支援繁體中文與英文，後端保留官方 13 種輸出語言白名單。

3. 只顯示原文
   - 只啟動 `gpt-realtime-whisper`。
   - 畫面只顯示原文區。
   - 原文字幕語言目前 UI 支援英文與中文。

## 即時處理架構

- 後端只跑在 `127.0.0.1`，不接受外部網路來源。
- API key 只存在本機後端記憶體，不寫入檔案、不放瀏覽器 localStorage、不輸出到 log。
- 後端用 API key 換取短效 Realtime client secret。
- 前端直接用短效 token 連線 OpenAI Realtime。
- Translate 走 WebRTC `/v1/realtime/translations/calls`。
- Whisper 走 WebSocket `wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper`。
- Realtime Translation 來源語言由模型自動偵測；使用者只需選翻譯目標語言。
- Whisper 原文字幕使用 ISO-639-1 語言碼，目前 UI 支援 `en` 與 `zh`。
- 麥克風音訊分流：
  - WebRTC track 送給 Translate。
  - 同一支麥克風 stream 轉成 24 kHz mono PCM16，送給 Whisper。

## 繁體中文保證

- Realtime Translate 目標語言選擇中文時，前端會轉成台灣繁體中文。
- 前端載入本機 OpenCC `cn -> twp` 轉換。
- 額外保留常見簡中詞/字 fallback map，避免正式場合出現簡體字。
- SRT、TXT、Markdown、JSON 匯出前會再次 normalize。

## UI/UX

- 首屏就是字幕工作台，不做行銷首頁。
- 上方只保留必要控制：
  - 金鑰
  - Start
  - Stop
  - Record
  - 字幕模式
  - 原文語言
  - 翻譯語言
  - Export
  - Fullscreen
- 其他控制收在「進階設定」：
  - 麥克風選擇
  - EN/ZH 字體大小
  - Pause Display
  - Audio
  - 測試麥克風
  - Mark Paragraph
  - Clear Captions
  - Clear Transcript
  - 清除金鑰
- 雙語模式上下可拖曳比例。
- 只顯示原文 / 只顯示翻譯模式自動改成單一大字幕區。
- 字幕區會自動捲到最新文字。
- Transcript 側欄永遠保留，可展開檢查逐字稿。

## macOS App/pkg 打包方案

目前實作：Swift AppKit + WKWebView 真正 macOS 視窗 + 內嵌本機 server。App 不再自動開外部瀏覽器。

1. `.app` 結構
   - `Contents/MacOS/KeynoteLiveTranslator`：Swift/AppKit executable。
   - `Contents/Resources/server`：目前 Node server。
   - `Contents/Resources/public`：目前前端檔案。
   - `Contents/Resources/node`：固定版本 Node runtime。
   - `Contents/Info.plist`：麥克風權限描述、App 名稱、版本資訊。

2. 啟動流程
   - Launcher 使用 `127.0.0.1:8787`。
   - 若該位址已有本 app server 回應，直接載入字幕 UI。
   - 啟動內嵌 Node server。
   - 在 App 自己的 WKWebView 視窗載入本機 URL。
   - App 關閉時停止 Node server。

3. 麥克風權限
   - macOS App 本身宣告 `NSMicrophoneUsageDescription`。
   - WKWebView delegate 會允許本機頁面的 media capture request。
   - 使用者仍需在 macOS「隱私權與安全性 > 麥克風」允許 Keynote Live Translator。
   - 正式 keynote 建議保留「測試麥克風」按鈕，開場前確認權限。

4. `.pkg`
   - 用 `pkgbuild` 將 `.app` 安裝到 `/Applications`。
   - 若要分發給其他電腦，需後續 Developer ID 簽章與 notarization。

## 測試標準

- 前端語法檢查：`node --check public/app.js`。
- 後端語法檢查：`node --check server/index.mjs`。
- UI 模式測試：
  - 雙語模式顯示 EN/ZH 兩區與 splitter。
  - 只顯示翻譯模式只顯示翻譯區。
  - 只顯示原文模式只顯示原文區。
- 事件測試：
  - Whisper delta 會更新原文字幕。
  - Translate delta 會更新翻譯字幕。
  - 簡中輸入會轉成繁中。
- App 測試：
  - Swift executable 可成功編譯成 Mach-O。
  - `.app` codesign verify 通過。
  - `.pkg` 可成功產出。
- 權限測試：
  - App/pkg 版需單獨測 macOS 麥克風權限。
- 真實 API 測試：
  - 雙語模式確認兩條 Realtime 連線同時啟動。
  - 純繁中模式確認只建立 Translate token。
  - 純英文模式確認只建立 Whisper token。
  - SRT 匯出時間軸與字幕內容正確。
