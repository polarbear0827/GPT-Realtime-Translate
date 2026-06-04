# Android 版規格書

## 目標

讓 Keynote Live Translator 可以在 Android 手機上使用，保留目前桌面版的資安模型與響應式字幕 UI。

## 架構

- 原生 Android Java Activity。
- Android WebView 載入本機 UI。
- App 內啟動 Java localhost server。
- Server 綁定 `127.0.0.1:8787`。
- UI assets 直接使用 `public/` 目錄內容。
- Android Gradle build 透過 GitHub Actions 產生 APK。

## 資安

- API key 由使用者在手機 App 內輸入。
- API key 只存在 Android app process 記憶體。
- API key 不寫入 SharedPreferences。
- API key 不寫入檔案。
- API key 不寫入 WebView localStorage。
- WebView 不直接持有長效 OpenAI API key。
- 本機 server 以 API key 換取短效 Realtime client secrets。
- WebView 使用短效 client secrets 連線 OpenAI Realtime。

## 權限

- `INTERNET`：連線 OpenAI API。
- `RECORD_AUDIO`：收音產生字幕與翻譯。
- `usesCleartextTraffic` + network security config：允許 WebView 連線本機 `127.0.0.1`。

## UI/UX

- 沿用桌面版字幕工作台，不做 landing page。
- Android 直式小螢幕下：
  - 控制列可捲動。
  - 主要操作以 2 欄工具列呈現。
  - 使用步驟預設收合。
  - 字幕區保留最大可視高度。
- 字幕模式：
  - 雙語字幕。
  - 只顯示翻譯。
  - 只顯示原文。
- 語言：
  - 原文字幕：English / 中文。
  - 翻譯目標：繁體中文 / English。

## 建置

本機需要 Android SDK + Gradle：

```bash
npm run build:android
```

GitHub Actions 會自動在 release tag 時產生：

```text
KeynoteLiveTranslator-android-<version>-debug.apk
```

## 已知限制

- 目前 APK 是 debug-signed，適合直接測試與內部使用。
- 上架 Play Store 或正式分發前，需要 release signing。
- 真機麥克風/WebRTC 行為仍需在 Android Chrome WebView 實機上測試。
