# Keynote Live Translator 1.0.0

**第一個正式版。** 演講、會議、影片的即時字幕與翻譯，還能讓全場觀眾用自己的手機同步看。

![Keynote Live Translator](https://raw.githubusercontent.com/polarbear0827/Keynote-Live-Translator/v1.0.0/docs/images/hero.png)

## 重點功能

- **雙語即時字幕**：`gpt-live-transcribe` 產生準確的原文逐字稿（支援關鍵字與情境說明），`gpt-realtime-translate` 即時翻譯；13 種原文語言、13 種翻譯語言，中文自動轉成台灣繁體用語。
- **投影模式與字幕視窗**：全螢幕大字幕、第二螢幕字幕視窗、淺色／深色／純黑／綠幕背景。
- **分享給觀眾**：掃 QR Code 就能在手機上看即時翻譯，不用裝 App。可暫停、發公告、看線上人數；在 Cloudflare 上實測 1,000 位同時觀看，95% 的字幕在 0.35 秒內送達。觀眾再多，OpenAI 費用也不變。
- **翻譯電腦播放的聲音**：直接擷取 Mac 的音訊（不用外放），翻譯顯示在可縮放、可調透明度、浮在全螢幕影片上的懸浮字幕。
- **逐字稿與匯出**：SRT（原文／翻譯／雙語）、Markdown、純文字、JSON，自動備份。
- **穩定**：斷線自動重連、60 分鐘上限前自動換線、停止時把最後一句翻完。
- **安全**：OpenAI 金鑰只在本機（可存進鑰匙圈）；分享伺服器是你自己的，一鍵連接、只有你的 App 能開房間。

## 安裝

下載 `KeynoteLiveTranslator-1.0.0.pkg` 並安裝（macOS 12.3 以上，Apple silicon 與 Intel 皆可；擷取電腦聲音需要 macOS 14.2 以上）。

要讓觀眾用手機看：在專案資料夾執行 `npm run relay:deploy`，部署完成後在 App 按「連接」。詳細說明請看 [README](https://github.com/polarbear0827/Keynote-Live-Translator#分享給觀眾)。

已經部署過分享伺服器的話，不需要重新部署。
