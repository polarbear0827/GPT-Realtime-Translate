# Keynote Live Translator 1.3.0

**可以改用 Google Gemini 了。**

- 「設定 → AI 服務」可以在 OpenAI 和 Google Gemini 之間切換，兩家的金鑰各自保存，切換時不用重新輸入。
- 選 Gemini 時：
  - 翻譯用 Gemini 3.5 Live Translate（`gemini-3.5-live-translate-preview`，預覽版）；講者說的已經是目標語言時會照原文顯示，字幕不會漏掉。
  - 原文用 Gemini 3.5 Transcribe（`gemini-3.5-transcribe-live`），自動加標點、去掉贅字，「關鍵字」會當成自訂詞彙。
  - 智慧斷句用 `gemini-3.5-flash-lite`。
  - 也能播放翻譯語音。
- Gemini 金鑰在 Google AI Studio（aistudio.google.com/apikey）建立，免費方案就能試用；正式活動建議用付費金鑰（免費用量可能被用來改進 Google 的產品）。
- 費用（官方價格）：雙語字幕一小時，Gemini 約 2.8 美元，OpenAI 約 3.1 美元。
- 金鑰一樣只留在你的電腦：App 用它換一次性的連線權杖，權杖鎖定了這次連線的所有設定，網頁拿不到金鑰，也改不了設定。
- Gemini 的連線大約 10 分鐘就會被關閉，App 會在 8 分鐘時（或 Google 提前通知時）無縫換到新連線，字幕不會中斷。
- 只有 OpenAI 用得到的設定（轉錄延遲、收音距離、情境說明），選 Gemini 時會自動隱藏。

安裝 `KeynoteLiveTranslator-1.3.0.pkg`（macOS 12.3 以上；擷取電腦聲音需要 macOS 14.2 以上）。分享伺服器不需要重新部署。
