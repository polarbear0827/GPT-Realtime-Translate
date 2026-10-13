# Keynote Live Translator v0.6.2

**連接分享伺服器不用再複製貼上。**

- 執行 `npm run relay:deploy` 部署完成後，App 會自動跳出「連接分享伺服器？」，按「連接」就完成。
  網址和發佈金鑰由部署程式直接交給 App，存進 macOS 鑰匙圈，你不用看到也不用複製。
- 已經部署過的話，執行 `npm run relay:connect` 就能讓 App 重新連接（例如重灌之後）。
- App 一定會先問你才連接，而且只接受 https 的伺服器與正確格式的金鑰，避免被其他網頁或程式亂設定。
- 「分享」面板的設定畫面改成兩個步驟的說明，手動輸入收在「手動輸入網址與發佈金鑰」裡。

安裝 `KeynoteLiveTranslator-0.6.2.pkg`（macOS 12.3 以上；擷取電腦聲音需要 macOS 14.2 以上）。
分享伺服器不需要重新部署。
