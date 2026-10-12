# Android 版規格書

## 目標

在 Android 手機上使用與桌面版相同的字幕 UI 與資安模型。

## 架構

- 原生 Java Activity + Android WebView，無 AndroidX 相依。
- UI：`public/` 打包成 APK assets，透過 `WebViewClient.shouldInterceptRequest` 在 App 內提供，
  網址為 `https://appassets.androidplatform.net/`（安全內容、不會連到網路）。
- 不開任何本機連接埠，也不允許明文流量；其他 App 無法存取金鑰或連線權杖。
- `NativeBridge`（`window.KltAndroid`）：API 呼叫、存檔（系統存檔對話框）、保持螢幕常亮、沉浸式全螢幕、離開確認；
  只在 WebView 顯示 App 自己的頁面時回應。
- `RealtimeBackend`：金鑰驗證與保管、向 OpenAI 換短效 client secret；規則與 `server/realtime.mjs` 相同。
- `SecureKeyStore`：使用者勾選「記住金鑰」時，以 Android Keystore 的 AES-GCM 金鑰加密保存。

## 資安

- 金鑰預設只存在記憶體；`allowBackup="false"`。
- 麥克風權限只授予 App 自己的頁面；第一次使用時才向系統要求並在同意後繼續。
- 外部連結交給系統瀏覽器，WebView 只能顯示 App 內頁面。

## 權限

- `INTERNET`：連線 OpenAI。
- `RECORD_AUDIO`：收音。
- `MODIFY_AUDIO_SETTINGS`：WebView 的 WebRTC 音訊處理需要。

## UI/UX

- 沿用桌面版 UI；直播中手機版會收起模式與語言選單，讓字幕區更大。
- Android 15（targetSdk 35）強制 edge-to-edge：App 依系統列、瀏海、鍵盤的 insets 自動留白。
- 旋轉、分割畫面、摺疊機、深色模式切換不會重建 Activity，直播不中斷。
- 直播中保持螢幕常亮；返回鍵在直播中或有未匯出逐字稿時會先確認；投影模式可用返回鍵離開。
- WebView renderer 當掉時自動重建，頁面會提供還原自動備份的逐字稿。

## 建置與簽章

- `npm run build:android`；版本號與 versionCode 由 `VERSION` 計算。
- 設定 `ANDROID_KEYSTORE_FILE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`
  時產生 release 簽章 APK；CI 由 GitHub secrets 提供。所有版本必須用同一把金鑰簽章才能覆蓋升級。

## 已知限制

- Android 會在 App 進入背景時停止收音；演講中請保持 App 在前景（直播中螢幕會保持常亮）。
- 字幕視窗（第二螢幕）在 Android 不提供。
- 需在實機確認 WebRTC 與麥克風行為（本機無法編譯 Android；CI 會建置並跑 lint）。
