// Host integration. The same UI runs in two hosts:
//   macOS app – WKWebView, native bridge window.webkit.messageHandlers.klt (replies via promises)
//   browser   – `npm start` dev server, API over fetch with a per-launch token
// The macOS app keeps the API key and calls OpenAI itself, so no local HTTP API is exposed there.

export const platform = typeof window === "undefined" ? null : detectPlatform();

function detectPlatform() {
  if (window.webkit?.messageHandlers?.klt) return createMacPlatform(window.webkit.messageHandlers.klt);
  return createWebPlatform();
}

function createMacPlatform(handler) {
  const call = async (message) => {
    const reply = await handler.postMessage(message);
    return typeof reply === "string" ? JSON.parse(reply) : reply;
  };
  return {
    kind: "macos",
    info: () => call({ action: "info" }),
    request: (method, path, body) => call({ action: "request", method, path, body: body ?? null }),
    saveFile: (filename, mimeType, content) => call({ action: "saveFile", filename, mimeType, content }),
    setFullscreen: (enabled) => call({ action: "setFullscreen", enabled }),
    setKeepAwake: (enabled) => call({ action: "setKeepAwake", enabled }).catch(() => {}),
    setLeaveGuard: (enabled, message = "") => call({ action: "setLeaveGuard", enabled, message }).catch(() => {}),
    openDisplayWindow: () => call({ action: "openDisplayWindow" }),
    startSystemAudio: ({ muteSource = false } = {}) => call({ action: "systemAudioStart", muteSource }),
    openTranslation: ({ id, targetLanguage, audioEnabled }) => call({ action: "translationOpen", id, targetLanguage, audioEnabled }),
    setTranslationAudio: ({ id, enabled }) => call({ action: "translationAudio", id, enabled }).catch(() => {}),
    closeTranslation: ({ id, graceful }) => call({ action: "translationClose", id, graceful }),
    stopSystemAudio: () => call({ action: "systemAudioStop" }).catch(() => {}),
    setOverlay: (state) => call({ action: "overlay", ...state }),
    updateOverlay: (payload) => call({ action: "overlayUpdate", ...payload }).catch(() => {}),
    setAppearance: (theme) => call({ action: "setAppearance", theme }).catch(() => {}),
    micHelp: "請到「系統設定 > 隱私權與安全性 > 麥克風」允許 Keynote Live Translator，然後重新開啟 App。",
    systemAudioHelp:
      "請確認正在播放聲音，並到「系統設定 > 隱私權與安全性 > 螢幕與系統錄音」的「僅限系統錄音」允許 Keynote Live Translator（變更後需重新開啟 App）。",
  };
}

function createWebPlatform() {
  const token = document.querySelector('meta[name="klt-token"]')?.content || "";
  let leaveGuard = false;
  let wakeLock = null;
  let wantWakeLock = false;

  window.addEventListener("beforeunload", (event) => {
    if (!leaveGuard) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (wantWakeLock && document.visibilityState === "visible") acquireWakeLock();
  });

  async function acquireWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      wakeLock = null;
    }
  }

  return {
    kind: "web",
    info: async () => ({
      platform: "web",
      supports: { rememberKey: false, nativeSave: false, displayWindow: true },
    }),
    request: async (method, path, body) => {
      const headers = { "X-KLT-Token": token };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let data = {};
      try {
        data = await response.json();
      } catch {
        // Non-JSON error page.
      }
      return { status: response.status, data };
    },
    saveFile: async (filename, mimeType, content) => {
      const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoking immediately can cancel the download in WebKit.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return { saved: true };
    },
    setFullscreen: async (enabled) => {
      try {
        if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
        if (!enabled && document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // Fullscreen refused; the in-page presentation mode still applies.
      }
      return { fullscreen: Boolean(document.fullscreenElement) };
    },
    setKeepAwake: async (enabled) => {
      wantWakeLock = enabled;
      if (enabled) await acquireWakeLock();
      else {
        await wakeLock?.release().catch(() => {});
        wakeLock = null;
      }
    },
    setLeaveGuard: async (enabled) => {
      leaveGuard = enabled;
    },
    openDisplayWindow: async () => {
      const opened = window.open("/?view=display", "klt-display", "popup,width=1280,height=720");
      if (!opened) throw new Error("瀏覽器擋下了新視窗，請允許彈出視窗。");
      return { opened: true };
    },
    startSystemAudio: null,
    setOverlay: null,
    setAppearance: async () => {},
    micHelp: "請點網址列左側的網站設定允許麥克風，並確認作業系統的隱私權設定允許這個瀏覽器使用麥克風，然後重新整理頁面。",
  };
}
