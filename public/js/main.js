import * as api from "./api.js";
import { AudioInput, levelToDb, listMicrophones, microphonePermissionState } from "./audio.js";
import { CaptionView, captionLines } from "./captions.js";
import { exportJson, exportMarkdown, exportSrt, exportText } from "./exporters.js";
import { buildOverlayPayload } from "./overlay.js";
import { platform } from "./platform.js";
import { SessionController } from "./session.js";
import { loadSettings, safeStorage, saveSetting } from "./settings.js";
import { ShareUi, applyQrDialog, renderCaptionQr } from "./share-ui.js";
import { SystemAudioInput } from "./system-audio.js";
import { TranscriptStore } from "./transcript.js";
import { TranscriptView } from "./transcript-view.js";
import { bindMenu, confirmDialog, createToaster } from "./ui.js";
import { displayText, ensureZhConverter } from "./zh.js";

const BACKUP_KEY = "keynote:transcriptBackup";
const DISPLAY_CHANNEL = "klt-display";
const OVERLAY_INTERVAL_MS = 100;
const OVERLAY_LINES = 4;
const FEED_LIMIT = 400;
const isDisplayView = new URLSearchParams(location.search).get("view") === "display";

const $ = (id) => document.getElementById(id);
const els = {
  statusDot: $("statusDot"),
  statusLabel: $("statusLabel"),
  elapsed: $("elapsed"),
  entryCount: $("entryCount"),
  transcribePill: $("transcribePill"),
  translatePill: $("translatePill"),
  levelMeter: $("levelMeter"),
  startStopBtn: $("startStopBtn"),
  captionModeSelect: $("captionModeSelect"),
  audioSourceField: $("audioSourceField"),
  audioSourceSelect: $("audioSourceSelect"),
  overlayBtn: $("overlayBtn"),
  systemAudioSettings: $("systemAudioSettings"),
  muteSystemAudioToggle: $("muteSystemAudioToggle"),
  themeSelect: $("themeSelect"),
  overlaySettings: $("overlaySettings"),
  overlayLockToggle: $("overlayLockToggle"),
  overlayOpacityInput: $("overlayOpacityInput"),
  overlayOpacityValue: $("overlayOpacityValue"),
  overlayLinesSelect: $("overlayLinesSelect"),
  overlayShowOriginalToggle: $("overlayShowOriginalToggle"),
  overlayResetBtn: $("overlayResetBtn"),
  sourceLanguageSelect: $("sourceLanguageSelect"),
  targetLanguageSelect: $("targetLanguageSelect"),
  recordBtn: $("recordBtn"),
  exportBtn: $("exportBtn"),
  exportMenu: $("exportMenu"),
  presentBtn: $("presentBtn"),
  shareBtn: $("shareBtn"),
  sharePanel: $("sharePanel"),
  captionQr: $("captionQr"),
  captionQrCode: $("captionQrCode"),
  qrDialog: $("qrDialog"),
  exitPresentBtn: $("exitPresentBtn"),
  transcriptBtn: $("transcriptBtn"),
  settingsBtn: $("settingsBtn"),
  keyBtn: $("keyBtn"),
  captionLayout: $("captionLayout"),
  sourceCaption: $("sourceCaption"),
  translatedCaption: $("translatedCaption"),
  sourceLanguageLabel: $("sourceLanguageLabel"),
  targetLanguageLabel: $("targetLanguageLabel"),
  splitter: $("splitter"),
  transcriptPanel: $("transcriptPanel"),
  transcriptScroll: $("transcriptScroll"),
  transcriptEmpty: $("transcriptEmpty"),
  jumpLatestBtn: $("jumpLatestBtn"),
  settingsPanel: $("settingsPanel"),
  liveSettingsNote: $("liveSettingsNote"),
  micSelect: $("micSelect"),
  micTestBtn: $("micTestBtn"),
  micTestResult: $("micTestResult"),
  micTestMeter: $("micTestMeter"),
  micProcessingSelect: $("micProcessingSelect"),
  noiseReductionSelect: $("noiseReductionSelect"),
  bilingualEngineSelect: $("bilingualEngineSelect"),
  delaySelect: $("delaySelect"),
  keywordsInput: $("keywordsInput"),
  promptInput: $("promptInput"),
  sourceFont: $("sourceFont"),
  sourceFontValue: $("sourceFontValue"),
  translatedFont: $("translatedFont"),
  translatedFontValue: $("translatedFontValue"),
  playAudioToggle: $("playAudioToggle"),
  smartBreaksToggle: $("smartBreaksToggle"),
  displayBackgroundSelect: $("displayBackgroundSelect"),
  displayAlignSelect: $("displayAlignSelect"),
  pauseBtn: $("pauseBtn"),
  displayWindowBtn: $("displayWindowBtn"),
  autoBackupToggle: $("autoBackupToggle"),
  latencyInput: $("latencyInput"),
  srtOffsetInput: $("srtOffsetInput"),
  markBtn: $("markBtn"),
  clearCaptionsBtn: $("clearCaptionsBtn"),
  clearTranscriptBtn: $("clearTranscriptBtn"),
  clearKeyBtn: $("clearKeyBtn"),
  versionLabel: $("versionLabel"),
  toasts: $("toasts"),
  providerSelect: $("providerSelect"),
  keyDialog: $("keyDialog"),
  keyDialogTitle: $("keyDialogTitle"),
  keyDialogSource: $("keyDialogSource"),
  keyForm: $("keyForm"),
  apiKeyInput: $("apiKeyInput"),
  toggleKeyVisibility: $("toggleKeyVisibility"),
  rememberKeyField: $("rememberKeyField"),
  rememberKeyToggle: $("rememberKeyToggle"),
  rememberKeyLabel: $("rememberKeyLabel"),
  keyError: $("keyError"),
  saveKeyBtn: $("saveKeyBtn"),
  cancelKeyBtn: $("cancelKeyBtn"),
  confirmDialog: $("confirmDialog"),
};

const config = await fetch("/realtime-config.json").then((response) => response.json());
const settings = loadSettings();
const storage = safeStorage();
const toaster = createToaster(els.toasts);
const store = new TranscriptStore();
// Every phrase, recorded or not: the live captions, floating captions and audience sharing use it.
const feed = new TranscriptStore();
const sourceView = new CaptionView(els.sourceCaption, "等待語音輸入…");
const translationView = new CaptionView(els.translatedCaption, "等待翻譯…");
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(DISPLAY_CHANNEL) : null;

// Which providers have a key in the backend (it never comes back to the page).
const keys = { openai: false, gemini: false };
const PROVIDERS = {
  openai: { name: "OpenAI", placeholder: "sk-...", prefix: ["sk-"], source: "在 platform.openai.com/api-keys 建立金鑰。" },
  // AI Studio creates AQ.… keys; older restricted AIza… keys still work.
  gemini: { name: "Gemini", placeholder: "AQ.Ab...", prefix: ["AQ.", "AIza"], source: "在 Google AI Studio（aistudio.google.com/apikey）建立金鑰，免費方案就能試用。" },
};
const hasKey = () => keys[settings.provider];
let platformInfo = { supports: {} };
let appVersion = "";
let paused = false;
let captionFrame = 0;
let statusFrame = 0;
let backupTimer = 0;
let presentControlsTimer = 0;
let transcriptView = null;
let exportMenu = null;
let lastKeepAwake = null;
let lastLeaveGuard = "";
let overlayState = { visible: false, locked: false, opacity: 0.85, lines: 2, showOriginal: true };
let share = null;
// Captions show phrases from this sequence number on (see clearCaptions).
let captionsFrom = 0;
let overlayTimer = 0;
let lastOverlaySent = 0;
let lastOverlayPayload = "";

const controller = new SessionController({
  store,
  feed,
  isRecording: () => settings.recording,
  languageInfo,
  onChange: () => scheduleStatus(),
  onCaptions: () => {
    scheduleCaptions();
    scheduleOverlay();
  },
  onNotice: handleNotice,
  onLevel: (rms) => setMeter(els.levelMeter, rms),
});

export function languageInfo(code) {
  const meta = config.languages[code] || { label: code || "—", lang: code || "und", cjk: false };
  return { code, label: meta.label, targetLabel: meta.targetLabel || meta.label, lang: meta.lang, cjk: Boolean(meta.cjk), short: (code || "?").toUpperCase() };
}

// Dev-server diagnostics only (http://127.0.0.1:8787/?debug): exposes internals to the console.
if (platform.kind === "web" && new URLSearchParams(location.search).has("debug")) {
  window.__klt = { store, feed, controller, scheduleCaptions, share: () => share };
}

if (isDisplayView) initDisplayView();
else await initMainView();

// ---- caption window (second screen) -------------------------------------------------------------

function initDisplayView() {
  document.body.classList.add("display-view");
  document.title = "字幕視窗 · Keynote Live Translator";
  if (!channel) return;
  channel.onmessage = ({ data }) => {
    if (data?.type !== "captions") return;
    applyDisplayState(data);
  };
  // Closing the projected QR code here (Esc) closes it in the main window too.
  els.qrDialog.addEventListener("close", () => channel.postMessage({ type: "qr-closed" }));
  channel.postMessage({ type: "hello" });
}

function applyDisplayState(data) {
  els.captionLayout.dataset.mode = data.mode;
  applyLayout(data.settings);
  applyTheme(data.settings.theme);
  sourceView.render(data.source.lines ?? [], data.source.lang);
  translationView.render(data.translation.lines ?? [], data.translation.lang);
  renderCaptionQr(els.captionQr, els.captionQrCode, data.share);
  applyQrDialog(els.qrDialog, data.qr);
}

// ---- main view ---------------------------------------------------------------------------------

async function initMainView() {
  populateLanguageSelects();
  applySettingsToControls();
  applyLayout(settings);
  applyTheme(settings.theme);
  bindEvents();
  transcriptView = new TranscriptView({
    store,
    scroll: els.transcriptScroll,
    empty: els.transcriptEmpty,
    jumpButton: els.jumpLatestBtn,
    languageInfo,
  });
  store.subscribe(onStoreChange);

  platformInfo = await platform.info().catch(() => ({ supports: {} }));
  els.displayWindowBtn.hidden = !platformInfo.supports?.displayWindow;
  initSystemAudioAndOverlay();
  let health = null;
  try {
    health = await api.getHealth();
    keys.openai = Boolean(health.hasApiKey);
    keys.gemini = Boolean(health.gemini?.hasKey);
    appVersion = health.version || platformInfo.version || "";
    els.versionLabel.textContent = appVersion ? `版本 ${appVersion}` : "";
  } catch (error) {
    toaster.show("error", `無法連線到本機服務：${error.message}`);
  }
  initShare(health?.share);
  renderStatus();
  scheduleCaptions();
  if (!hasKey()) openKeyDialog();
  await refreshMicrophones();
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
  loadChineseIfNeeded();
  offerBackupRestore();
  setInterval(renderElapsed, 1000);
}


function populateLanguageSelects() {
  const fill = (select, codes, target) => {
    select.replaceChildren(
      ...codes.map((code) => {
        const info = languageInfo(code);
        return new Option(target ? info.targetLabel : info.label, code);
      }),
    );
  };
  fill(els.sourceLanguageSelect, config.transcriptionLanguages, false);
  fill(els.targetLanguageSelect, config.translationOutputLanguages, true);
  if (!config.transcriptionLanguages.includes(settings.sourceLanguage)) settings.sourceLanguage = config.defaults.sourceLanguage;
  if (!config.translationOutputLanguages.includes(settings.targetLanguage)) settings.targetLanguage = config.defaults.targetLanguage;
  if (!config.transcriptionDelays.includes(settings.transcriptionDelay)) settings.transcriptionDelay = config.defaults.transcriptionDelay;
  if (!config.noiseReductionTypes.includes(settings.noiseReduction)) settings.noiseReduction = config.defaults.noiseReduction;
}

function applySettingsToControls() {
  els.captionModeSelect.value = settings.captionMode;
  els.audioSourceSelect.value = settings.audioSource;
  els.muteSystemAudioToggle.checked = settings.muteSystemAudio;
  els.themeSelect.value = settings.theme;
  els.providerSelect.value = settings.provider;
  applyProvider();
  els.sourceLanguageSelect.value = settings.sourceLanguage;
  els.targetLanguageSelect.value = settings.targetLanguage;
  els.micProcessingSelect.value = settings.micProcessing;
  els.noiseReductionSelect.value = settings.noiseReduction;
  els.bilingualEngineSelect.value = settings.bilingualEngine;
  els.delaySelect.value = settings.transcriptionDelay;
  els.keywordsInput.value = settings.keywords;
  els.promptInput.value = settings.prompt;
  els.sourceFont.value = String(settings.sourceFontSize);
  els.translatedFont.value = String(settings.translatedFontSize);
  els.playAudioToggle.checked = settings.playAudio;
  els.smartBreaksToggle.checked = settings.smartBreaks;
  els.displayBackgroundSelect.value = settings.displayBackground;
  els.displayAlignSelect.value = settings.displayAlign;
  els.autoBackupToggle.checked = settings.autoBackup;
  els.latencyInput.value = String(settings.translationLatencyMs);
  els.srtOffsetInput.value = String(settings.srtOffsetMs);
}

function applyLayout(values) {
  els.captionLayout.dataset.mode = values.captionMode ?? values.mode ?? settings.captionMode;
  const ratio = Number(values.splitRatio) || 0.48;
  els.captionLayout.style.setProperty("--split-top", `${ratio}fr`);
  els.captionLayout.style.setProperty("--split-bottom", `${1 - ratio}fr`);
  els.captionLayout.style.setProperty("--source-font", `${values.sourceFontSize}px`);
  els.captionLayout.style.setProperty("--translated-font", `${values.translatedFontSize}px`);
  els.splitter.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  document.body.dataset.background = values.displayBackground;
  document.body.dataset.align = values.displayAlign;
  if (els.sourceFontValue) {
    els.sourceFontValue.textContent = `${values.sourceFontSize}px`;
    els.translatedFontValue.textContent = `${values.translatedFontSize}px`;
  }
}

function updateSetting(name, value) {
  settings[name] = value;
  saveSetting(name, value);
  applyLayout(settings);
  scheduleCaptions();
  if (name === "captionMode" || name === "sourceLanguage" || name === "targetLanguage") share?.updateMeta();
}

function bindEvents() {
  els.startStopBtn.addEventListener("click", toggleSession);
  els.captionModeSelect.addEventListener("change", () => {
    updateSetting("captionMode", els.captionModeSelect.value);
    loadChineseIfNeeded();
  });
  els.sourceLanguageSelect.addEventListener("change", () => {
    updateSetting("sourceLanguage", els.sourceLanguageSelect.value);
    loadChineseIfNeeded();
  });
  els.targetLanguageSelect.addEventListener("change", () => {
    updateSetting("targetLanguage", els.targetLanguageSelect.value);
    loadChineseIfNeeded();
  });
  els.audioSourceSelect.addEventListener("change", () => {
    updateSetting("audioSource", els.audioSourceSelect.value);
    renderStatus();
  });
  els.muteSystemAudioToggle.addEventListener("change", () => updateSetting("muteSystemAudio", els.muteSystemAudioToggle.checked));
  els.themeSelect.addEventListener("change", () => {
    updateSetting("theme", els.themeSelect.value);
    applyTheme(settings.theme);
    broadcastCaptions();
  });
  els.overlayBtn.addEventListener("click", () => setOverlayVisible(!overlayState.visible));
  els.overlayLockToggle.addEventListener("change", () => configureOverlay({ locked: els.overlayLockToggle.checked }));
  els.overlayOpacityInput.addEventListener("input", () => {
    els.overlayOpacityValue.textContent = `${els.overlayOpacityInput.value}%`;
    configureOverlay({ opacity: Number(els.overlayOpacityInput.value) / 100 });
  });
  els.overlayLinesSelect.addEventListener("change", () => configureOverlay({ lines: Number(els.overlayLinesSelect.value) }));
  els.overlayShowOriginalToggle.addEventListener("change", () => configureOverlay({ showOriginal: els.overlayShowOriginalToggle.checked }));
  els.overlayResetBtn.addEventListener("click", () => setOverlayVisible(true, { resetFrame: true }));
  els.recordBtn.addEventListener("click", () => {
    updateSetting("recording", !settings.recording);
    if (!settings.recording) store.sealAll();
    renderStatus();
  });

  els.exportBtn.addEventListener("click", updateExportMenu);
  exportMenu = bindMenu(els.exportBtn, els.exportMenu, exportTranscript);

  els.presentBtn.addEventListener("click", () => setPresenting(true));
  els.exitPresentBtn.addEventListener("click", () => setPresenting(false));
  document.addEventListener("pointermove", () => {
    if (!document.body.classList.contains("presenting")) return;
    document.body.classList.add("show-controls");
    clearTimeout(presentControlsTimer);
    presentControlsTimer = setTimeout(() => document.body.classList.remove("show-controls"), 2500);
  });
  document.addEventListener("fullscreenchange", () => {
    if (platform.kind === "web" && !document.fullscreenElement && document.body.classList.contains("presenting")) setPresenting(false);
  });

  els.transcriptBtn.addEventListener("click", () => toggleDrawer(els.transcriptPanel));
  els.shareBtn.addEventListener("click", () => toggleDrawer(els.sharePanel));
  els.settingsBtn.addEventListener("click", () => toggleDrawer(els.settingsPanel));
  for (const button of document.querySelectorAll("[data-close-drawer]")) {
    button.addEventListener("click", () => toggleDrawer(button.closest(".drawer"), false));
  }
  els.keyBtn.addEventListener("click", openKeyDialog);

  els.micSelect.addEventListener("change", () => updateSetting("micDeviceId", els.micSelect.value));
  els.micTestBtn.addEventListener("click", testMicrophone);
  els.micProcessingSelect.addEventListener("change", () => updateSetting("micProcessing", els.micProcessingSelect.value));
  els.noiseReductionSelect.addEventListener("change", () => updateSetting("noiseReduction", els.noiseReductionSelect.value));
  els.bilingualEngineSelect.addEventListener("change", () => updateSetting("bilingualEngine", els.bilingualEngineSelect.value));
  els.delaySelect.addEventListener("change", () => updateSetting("transcriptionDelay", els.delaySelect.value));
  els.keywordsInput.addEventListener("change", () => updateSetting("keywords", els.keywordsInput.value));
  els.promptInput.addEventListener("change", () => updateSetting("prompt", els.promptInput.value.trim()));
  els.sourceFont.addEventListener("input", () => updateSetting("sourceFontSize", Number(els.sourceFont.value)));
  els.translatedFont.addEventListener("input", () => updateSetting("translatedFontSize", Number(els.translatedFont.value)));
  els.playAudioToggle.addEventListener("change", () => {
    updateSetting("playAudio", els.playAudioToggle.checked);
    controller.setPlayAudio(settings.playAudio);
  });
  els.displayBackgroundSelect.addEventListener("change", () => updateSetting("displayBackground", els.displayBackgroundSelect.value));
  els.displayAlignSelect.addEventListener("change", () => updateSetting("displayAlign", els.displayAlignSelect.value));
  els.pauseBtn.addEventListener("click", togglePause);
  els.displayWindowBtn.addEventListener("click", openDisplayWindow);
  els.autoBackupToggle.addEventListener("change", () => {
    updateSetting("autoBackup", els.autoBackupToggle.checked);
    if (settings.autoBackup) scheduleBackup();
    else storage.remove(BACKUP_KEY);
  });
  els.providerSelect.addEventListener("change", () => {
    updateSetting("provider", els.providerSelect.value);
    applyProvider();
    renderStatus();
    if (!hasKey()) openKeyDialog();
  });
  els.smartBreaksToggle.addEventListener("change", () => {
    updateSetting("smartBreaks", els.smartBreaksToggle.checked);
    controller.setSmartBreaks(settings.smartBreaks);
  });
  els.latencyInput.addEventListener("change", () => updateSetting("translationLatencyMs", clampNumber(els.latencyInput, 0, 5000)));
  els.srtOffsetInput.addEventListener("change", () => updateSetting("srtOffsetMs", clampNumber(els.srtOffsetInput, -10000, 10000)));
  els.markBtn.addEventListener("click", () => controller.markParagraph());
  els.clearCaptionsBtn.addEventListener("click", clearCaptions);
  els.clearTranscriptBtn.addEventListener("click", clearTranscript);
  els.clearKeyBtn.addEventListener("click", clearApiKey);

  els.keyForm.addEventListener("submit", saveApiKey);
  els.cancelKeyBtn.addEventListener("click", () => els.keyDialog.close());
  els.toggleKeyVisibility.addEventListener("click", () => {
    const visible = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = visible ? "text" : "password";
    els.toggleKeyVisibility.textContent = visible ? "隱藏" : "顯示";
    els.toggleKeyVisibility.setAttribute("aria-pressed", String(visible));
  });
  els.keyDialog.addEventListener("close", () => {
    els.apiKeyInput.value = "";
    els.apiKeyInput.type = "password";
    els.toggleKeyVisibility.textContent = "顯示";
  });

  bindSplitter();
  document.addEventListener("keydown", handleShortcut);
  const topbar = $("topbar");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--topbar-height", `${topbar.offsetHeight}px`);
  }).observe(topbar);

  if (channel) {
    channel.onmessage = ({ data }) => {
      if (data?.type === "hello") broadcastCaptions();
      if (data?.type === "qr-closed") share?.setProjecting(false);
    };
  }
}

// ---- session ----------------------------------------------------------------------------------

async function toggleSession() {
  if (controller.status === "idle") await startSession();
  else await controller.stop();
}

async function startSession() {
  if (!hasKey()) {
    openKeyDialog();
    return;
  }
  const options = {
    provider: settings.provider,
    mode: settings.captionMode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    bilingualEngine: settings.bilingualEngine,
    deviceId: settings.micDeviceId,
    micProcessing: settings.micProcessing,
    noiseReduction: settings.noiseReduction,
    transcriptionDelay: settings.transcriptionDelay,
    prompt: settings.prompt,
    keywords: settings.keywords,
    translationLatencyMs: settings.translationLatencyMs,
    playAudio: settings.playAudio,
    smartBreaks: settings.smartBreaks,
    audioSource: settings.audioSource,
    muteSystemAudio: settings.muteSystemAudio,
  };
  if (options.mode !== "source" && options.sourceLanguage === options.targetLanguage) {
    toaster.show("info", "原文與翻譯語言相同，翻譯模型可能不會輸出內容；只需要字幕時建議改用「只顯示原文」。", { key: "same-language" });
  }
  if (settings.recording && !store.isEmpty) {
    toaster.show("info", "接續記錄到目前的逐字稿。要從頭開始，請先在設定中清除逐字稿。", { key: "resume" });
  }
  loadChineseIfNeeded();
  // A new run starts with empty captions; the transcript keeps everything.
  captionsFrom = feed.nextId;
  try {
    await controller.start(options);
    refreshMicrophones();
    // Translating what the Mac plays is meant to be read over the video: show the floating captions.
    if (options.audioSource === "system" && platformInfo.supports?.overlay && !overlayState.visible) setOverlayVisible(true);
  } catch (error) {
    toaster.show("error", describeStartError(error), { key: "start-error" });
  }
}

function describeStartError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return `麥克風權限被拒絕。${platform.micHelp}`;
  if (name === "OverconstrainedError" || (name === "NotFoundError" && settings.micDeviceId)) {
    return "找不到設定中選擇的麥克風，請到「設定 > 收音」重新選擇。";
  }
  if (name === "NotFoundError") return "找不到可用的麥克風，請確認麥克風已連接。";
  if (name === "NotReadableError") return "麥克風無法讀取，可能正被其他 App 使用。請關閉其他使用麥克風的 App 後再試。";
  if (name === "NotSupportedError") return error.message;
  return error?.message || "無法開始即時字幕。";
}

function handleNotice(level, message) {
  if (level === "silence") toaster.show("warning", message, { key: "silence", timeout: 0 });
  else if (level === "silence-cleared") toaster.dismiss("silence");
  else if (level === "system-audio-silent") toaster.show("warning", `${message}${platform.systemAudioHelp || ""}`, { key: "system-audio", timeout: 0 });
  else toaster.show(level, message);
}

function renderStatus() {
  statusFrame = 0;
  const status = controller.status;
  const live = status === "live";
  const degraded = live && Object.values(controller.connections).some((state) => state === "reconnecting" || state === "failed");
  const labels = { idle: "待命", starting: `準備中：${controller.step}`, live: "直播中", stopping: `收尾中：${controller.step}` };
  els.statusLabel.textContent = degraded ? "直播中（部分連線重新連線中）" : labels[status] || status;
  els.statusDot.dataset.status = degraded ? "degraded" : status;
  setPill(els.transcribePill, controller.connections.transcribe);
  setPill(els.translatePill, controller.connections.translate);

  const busy = status !== "idle";
  els.startStopBtn.textContent = { idle: "開始", starting: "取消", live: "停止", stopping: "收尾中…" }[status];
  els.startStopBtn.classList.toggle("is-stop", busy);
  els.startStopBtn.disabled = status === "stopping";
  for (const control of [
    els.captionModeSelect,
    els.sourceLanguageSelect,
    els.targetLanguageSelect,
    els.micSelect,
    els.micProcessingSelect,
    els.noiseReductionSelect,
    els.bilingualEngineSelect,
    els.delaySelect,
    els.keywordsInput,
    els.promptInput,
    els.clearKeyBtn,
    els.providerSelect,
  ]) {
    control.disabled = busy;
  }
  els.clearKeyBtn.disabled = busy || !hasKey();
  const systemAudio = settings.audioSource === "system";
  els.audioSourceSelect.disabled = busy;
  els.muteSystemAudioToggle.disabled = busy || !systemAudio;
  els.micSelect.disabled = busy || systemAudio;
  els.micProcessingSelect.disabled = busy || systemAudio;
  els.playAudioToggle.disabled = systemAudio;
  els.liveSettingsNote.hidden = !busy;
  document.body.classList.toggle("is-live", busy);

  els.recordBtn.setAttribute("aria-pressed", String(settings.recording));
  els.recordBtn.textContent = settings.recording ? "記錄逐字稿：開" : "記錄逐字稿：關";
  els.keyBtn.textContent = `${hasKey() ? "更換" : "輸入"} ${PROVIDERS[settings.provider].name} 金鑰`;
  els.keyBtn.disabled = busy;
  els.pauseBtn.setAttribute("aria-pressed", String(paused));
  els.pauseBtn.textContent = paused ? "恢復顯示" : "暫停顯示";
  els.entryCount.textContent = `${store.entries.length} 句`;
  els.levelMeter.hidden = !busy;
  if (!busy) setMeter(els.levelMeter, 0);

  const source = languageInfo(settings.sourceLanguage);
  const target = languageInfo(settings.targetLanguage);
  const fromTranslateModel = settings.captionMode === "bilingual" && settings.bilingualEngine === "translate";
  els.sourceLanguageLabel.textContent = fromTranslateModel ? `${source.label}（自動偵測）` : source.label;
  els.targetLanguageLabel.textContent = target.targetLabel;

  const keepAwake = status === "live" || status === "starting";
  if (keepAwake !== lastKeepAwake) {
    lastKeepAwake = keepAwake;
    platform.setKeepAwake(keepAwake);
  }
  share?.setSessionStatus(status);
  updateLeaveGuard();
  renderElapsed();
}

function scheduleStatus() {
  if (!statusFrame) statusFrame = requestAnimationFrame(renderStatus);
}

function setPill(pill, state) {
  pill.dataset.state = state;
  const names = { off: "未使用", connecting: "連線中", live: "已連線", reconnecting: "重新連線中", failed: "失敗" };
  pill.title = `${pill.textContent}：${names[state] || state}`;
}

function renderElapsed() {
  const since = controller.liveSince;
  const seconds = since ? Math.floor((performance.now() - since) / 1000) : 0;
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  els.elapsed.textContent = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function setMeter(meter, rms) {
  const db = levelToDb(rms);
  meter.firstElementChild.style.transform = `scaleX(${Math.max(0, (db + 60) / 60).toFixed(3)})`;
}

// ---- captions ---------------------------------------------------------------------------------

function scheduleCaptions() {
  if (!captionFrame) {
    captionFrame = requestAnimationFrame(() => {
      captionFrame = 0;
      renderCaptions();
    });
  }
}

function renderCaptions() {
  if (paused) return;
  if (feed.entries.length > FEED_LIMIT * 1.25) feed.trim(FEED_LIMIT);
  sourceView.render(captionLines(feed, "source", { from: captionsFrom }), languageInfo(settings.sourceLanguage).lang);
  translationView.render(captionLines(feed, "translation", { from: captionsFrom }), languageInfo(settings.targetLanguage).lang);
  broadcastCaptions();
}

function broadcastCaptions() {
  channel?.postMessage({
    type: "captions",
    mode: settings.captionMode,
    source: { lines: sourceView.lines, lang: languageInfo(settings.sourceLanguage).lang },
    translation: { lines: translationView.lines, lang: languageInfo(settings.targetLanguage).lang },
    settings: {
      captionMode: settings.captionMode,
      splitRatio: settings.splitRatio,
      sourceFontSize: settings.sourceFontSize,
      translatedFontSize: settings.translatedFontSize,
      displayBackground: settings.displayBackground,
      displayAlign: settings.displayAlign,
      theme: settings.theme,
    },
    share: share?.captionQrState() ?? null,
    qr: share?.projectionState() ?? null,
  });
}

function togglePause() {
  paused = !paused;
  for (const badge of document.querySelectorAll(".paused-badge")) badge.hidden = !paused;
  renderStatus();
  if (!paused) {
    scheduleCaptions();
    scheduleOverlay();
  }
}

function clearCaptions() {
  captionsFrom = feed.nextId;
  if (paused) togglePause();
  scheduleCaptions();
  scheduleOverlay();
}

function loadChineseIfNeeded() {
  if (settings.sourceLanguage !== "zh" && settings.targetLanguage !== "zh") return;
  ensureZhConverter().then((loaded) => {
    if (!loaded) toaster.show("warning", "繁體轉換元件載入失敗，改用內建的簡易對照表。", { key: "opencc" });
    scheduleCaptions();
    transcriptView?.invalidate();
  });
}

// ---- presentation, drawers, shortcuts ---------------------------------------------------------

async function setPresenting(on) {
  document.body.classList.toggle("presenting", on);
  els.exitPresentBtn.hidden = !on;
  if (on) toggleDrawer(null);
  await platform.setFullscreen(on).catch(() => {});
}

function toggleDrawer(drawer, force) {
  for (const panel of [els.transcriptPanel, els.settingsPanel, els.sharePanel]) {
    const open = panel === drawer ? (force ?? panel.hidden) : false;
    panel.hidden = !open;
  }
  els.transcriptBtn.setAttribute("aria-pressed", String(!els.transcriptPanel.hidden));
  els.settingsBtn.setAttribute("aria-pressed", String(!els.settingsPanel.hidden));
  els.shareBtn.setAttribute("aria-pressed", String(!els.sharePanel.hidden));
  transcriptView?.setOpen(!els.transcriptPanel.hidden);
}

async function openDisplayWindow() {
  try {
    await platform.openDisplayWindow();
    setTimeout(broadcastCaptions, 500);
  } catch (error) {
    toaster.show("error", error.message || "無法開啟字幕視窗。");
  }
}

function handleShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
  if (event.key === "Escape") {
    if (exportMenu?.isOpen) {
      exportMenu.close();
      return;
    }
    if (document.body.classList.contains("presenting")) setPresenting(false);
    else toggleDrawer(null);
    return;
  }
  if (typing) return;
  const onButton = target instanceof HTMLElement && target.matches("button");
  switch (event.key) {
    case " ":
      if (onButton) return;
      toggleSession();
      break;
    case "p":
    case "P":
      togglePause();
      break;
    case "m":
    case "M":
      controller.markParagraph();
      break;
    case "f":
    case "F":
      setPresenting(!document.body.classList.contains("presenting"));
      break;
    case "t":
    case "T":
      toggleDrawer(els.transcriptPanel);
      break;
    case "q":
    case "Q":
      share?.toggleProjecting();
      break;
    case "+":
    case "=":
      resizeFonts(4);
      break;
    case "-":
    case "_":
      resizeFonts(-4);
      break;
    default:
      return;
  }
  event.preventDefault();
}

function resizeFonts(delta) {
  updateSetting("sourceFontSize", Math.min(120, Math.max(20, settings.sourceFontSize + delta)));
  updateSetting("translatedFontSize", Math.min(140, Math.max(20, settings.translatedFontSize + delta)));
  els.sourceFont.value = String(settings.sourceFontSize);
  els.translatedFont.value = String(settings.translatedFontSize);
}

function bindSplitter() {
  const splitter = els.splitter;
  let dragging = false;
  const setRatio = (ratio, persist) => {
    settings.splitRatio = Math.min(0.78, Math.max(0.22, ratio));
    applyLayout(settings);
    if (persist) saveSetting("splitRatio", settings.splitRatio.toFixed(3));
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    splitter.dataset.dragging = "false";
    saveSetting("splitRatio", settings.splitRatio.toFixed(3));
    broadcastCaptions();
  };
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    splitter.dataset.dragging = "true";
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = els.captionLayout.getBoundingClientRect();
    setRatio((event.clientY - rect.top) / rect.height, false);
  });
  splitter.addEventListener("pointerup", end);
  splitter.addEventListener("pointercancel", end);
  splitter.addEventListener("lostpointercapture", end);
  splitter.addEventListener("keydown", (event) => {
    const steps = { ArrowUp: -0.02, ArrowDown: 0.02, PageUp: -0.1, PageDown: 0.1 };
    if (event.key in steps) setRatio(settings.splitRatio + steps[event.key], true);
    else if (event.key === "Home") setRatio(0.22, true);
    else if (event.key === "End") setRatio(0.78, true);
    else return;
    event.preventDefault();
    broadcastCaptions();
  });
}

// ---- theme ------------------------------------------------------------------------------------

function applyTheme(theme = "system") {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  platform.setAppearance?.(theme);
}

// ---- system audio & floating captions (macOS app) ---------------------------------------------

function initSystemAudioAndOverlay() {
  const supports = platformInfo.supports || {};
  els.audioSourceField.hidden = !supports.systemAudio;
  els.systemAudioSettings.hidden = !supports.systemAudio;
  if (!supports.systemAudio && settings.audioSource === "system") updateSetting("audioSource", "mic");
  els.audioSourceSelect.value = settings.audioSource;
  els.overlayBtn.hidden = !supports.overlay;
  els.overlaySettings.hidden = !supports.overlay;
  if (platformInfo.overlay) overlayState = platformInfo.overlay;
  // The native window reports changes made from its own controls or the app menu.
  window.__kltOverlayState = (state) => {
    const becameVisible = state.visible && !overlayState.visible;
    overlayState = state;
    renderOverlayControls();
    if (becameVisible) {
      lastOverlayPayload = "";
      scheduleOverlay();
    }
  };
  renderOverlayControls();
}

function renderOverlayControls() {
  els.overlayBtn.setAttribute("aria-pressed", String(overlayState.visible));
  els.overlayLockToggle.checked = Boolean(overlayState.locked);
  const opacity = Math.round((overlayState.opacity ?? 0.85) * 100);
  if (document.activeElement !== els.overlayOpacityInput) els.overlayOpacityInput.value = String(opacity);
  els.overlayOpacityValue.textContent = `${opacity}%`;
  els.overlayLinesSelect.value = String(overlayState.lines ?? 2);
  els.overlayShowOriginalToggle.checked = overlayState.showOriginal !== false;
}

async function configureOverlay(change) {
  if (!platform.setOverlay) return;
  try {
    overlayState = await platform.setOverlay(change);
  } catch (error) {
    toaster.show("error", `懸浮字幕：${error.message}`);
  }
  renderOverlayControls();
}

async function setOverlayVisible(visible, extra = {}) {
  await configureOverlay({ visible, ...extra });
  if (overlayState.visible) {
    lastOverlayPayload = "";
    scheduleOverlay();
  }
}

// Driven by caption events with a timer (not requestAnimationFrame), so the floating captions keep
// updating while the main window is hidden behind a full-screen video.
function scheduleOverlay() {
  if (!overlayState.visible || !platform.updateOverlay || paused) return;
  const wait = OVERLAY_INTERVAL_MS - (performance.now() - lastOverlaySent);
  if (wait <= 0) sendOverlay();
  else if (!overlayTimer) {
    overlayTimer = setTimeout(() => {
      overlayTimer = 0;
      sendOverlay();
    }, wait);
  }
}

function sendOverlay() {
  lastOverlaySent = performance.now();
  const options = { from: captionsFrom, limit: OVERLAY_LINES };
  const payload = buildOverlayPayload({
    mode: settings.captionMode,
    sourceLines: captionLines(feed, "source", options),
    translationLines: captionLines(feed, "translation", options),
    sourceInfo: languageInfo(settings.sourceLanguage),
    targetInfo: languageInfo(settings.targetLanguage),
  });
  const json = JSON.stringify(payload);
  if (json === lastOverlayPayload) return;
  lastOverlayPayload = json;
  platform.updateOverlay(payload);
}

// ---- audience sharing -------------------------------------------------------------------------

function initShare(shareInfo) {
  share = new ShareUi({
    settings,
    updateSetting,
    feed,
    display: displayText,
    languageInfo,
    toaster,
    confirm: (message, options) => confirmDialog(els.confirmDialog, message, options),
    storage,
    getSessionStatus: () => controller.status,
    isBusy: () => controller.status !== "idle",
    onChange: ({ openPanel } = {}) => {
      if (openPanel) toggleDrawer(els.sharePanel, true);
      broadcastCaptions();
      updateLeaveGuard();
    },
  });
  share.init(shareInfo, platformInfo);
}

// ---- microphone -------------------------------------------------------------------------------

async function refreshMicrophones() {
  const devices = await listMicrophones();
  const selected = settings.micDeviceId;
  const options = [new Option("系統預設", "")];
  devices.forEach((device, index) => options.push(new Option(device.label || `麥克風 ${index + 1}`, device.deviceId)));
  if (selected && !devices.some((device) => device.deviceId === selected)) {
    options.push(new Option(devices.length ? "先前選擇的麥克風（目前未連接）" : "先前選擇的麥克風", selected));
  }
  els.micSelect.replaceChildren(...options);
  els.micSelect.value = selected;
}

async function testMicrophone() {
  if (controller.status !== "idle") {
    toaster.show("info", "直播中，請看上方的音量表確認收音。");
    return;
  }
  const systemAudio = settings.audioSource === "system";
  els.micTestBtn.disabled = true;
  els.micTestMeter.hidden = false;
  els.micTestResult.textContent = systemAudio ? "請在 Mac 上播放影片或音樂…" : "請對著麥克風說話…";
  let peak = 0;
  const Input = systemAudio ? SystemAudioInput : AudioInput;
  const input = new Input({
    onChunk: (_pcm, rms, chunkPeak) => {
      peak = Math.max(peak, chunkPeak);
      setMeter(els.micTestMeter, rms);
    },
  });
  try {
    await input.open({ deviceId: settings.micDeviceId, processing: settings.micProcessing, muteSource: false });
    const label = systemAudio ? "電腦播放的聲音" : input.track?.label || "麥克風";
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const peakDb = Math.round(levelToDb(peak));
    const permission = await microphonePermissionState();
    els.micTestResult.textContent =
      peakDb > -30
        ? `收音正常：${label}（峰值 ${peakDb} dB）`
        : peakDb > -50
          ? `音量偏小：${label}（峰值 ${peakDb} dB），請靠近麥克風或調高輸入音量。`
          : systemAudio
            ? `沒有收到電腦播放的聲音。${platform.systemAudioHelp || ""}`
            : `幾乎沒有收到聲音：${label}。請確認選擇的麥克風與靜音開關。`;
    if (permission === "denied") els.micTestResult.textContent += "（權限：拒絕）";
  } catch (error) {
    els.micTestResult.textContent = "";
    toaster.show("error", describeStartError(error));
  } finally {
    input.close();
    els.micTestBtn.disabled = false;
    els.micTestMeter.hidden = true;
    refreshMicrophones();
  }
}

// ---- API key ----------------------------------------------------------------------------------

// Settings that only one provider uses are shown for that provider only.
function applyProvider() {
  for (const element of document.querySelectorAll("[data-provider]")) element.hidden = element.dataset.provider !== settings.provider;
}

function openKeyDialog() {
  if (controller.status !== "idle" || els.keyDialog.open) return;
  showKeyError("");
  const provider = PROVIDERS[settings.provider];
  els.keyDialogTitle.textContent = `輸入 ${provider.name} API key`;
  els.keyDialogSource.textContent = provider.source;
  els.apiKeyInput.placeholder = provider.placeholder;
  const supportsRemember = Boolean(platformInfo.supports?.rememberKey);
  els.rememberKeyField.hidden = !supportsRemember;
  if (supportsRemember && platformInfo.rememberKeyLabel) els.rememberKeyLabel.textContent = platformInfo.rememberKeyLabel;
  if (typeof els.keyDialog.showModal === "function") els.keyDialog.showModal();
  else els.keyDialog.setAttribute("open", "");
  els.apiKeyInput.focus();
}

async function saveApiKey(event) {
  event.preventDefault();
  const key = els.apiKeyInput.value.trim();
  const providerName = settings.provider;
  const provider = PROVIDERS[providerName];
  if (!provider.prefix.some((prefix) => key.startsWith(prefix))) {
    showKeyError(`請輸入有效的 ${provider.name} API key（以 ${provider.prefix[0]} 開頭）。`);
    return;
  }
  els.saveKeyBtn.disabled = true;
  els.saveKeyBtn.textContent = "驗證中…";
  try {
    const save = providerName === "gemini" ? api.saveGeminiKey : api.saveKey;
    const result = await save(key, els.rememberKeyToggle.checked);
    keys[providerName] = true;
    els.keyDialog.close();
    toaster.show("success", result.remembered ? "金鑰已驗證並儲存在系統安全儲存區。" : "金鑰已驗證，只保存在記憶體中。");
    for (const warning of result.warnings || []) toaster.show("warning", warning);
    renderStatus();
  } catch (error) {
    showKeyError(error.message || "金鑰儲存失敗。");
  } finally {
    els.saveKeyBtn.disabled = false;
    els.saveKeyBtn.textContent = "儲存並驗證";
  }
}

function showKeyError(message) {
  els.keyError.textContent = message;
  els.keyError.hidden = !message;
}

async function clearApiKey() {
  if (controller.status !== "idle") return;
  const providerName = settings.provider;
  const message = `確定要清除 ${PROVIDERS[providerName].name} 金鑰嗎？已記住的金鑰也會一併刪除。`;
  if (!(await confirmDialog(els.confirmDialog, message, { okText: "清除金鑰" }))) return;
  try {
    await (providerName === "gemini" ? api.deleteGeminiKey() : api.deleteKey());
    keys[providerName] = false;
    renderStatus();
    openKeyDialog();
  } catch (error) {
    toaster.show("error", error.message);
  }
}

// ---- transcript, export, backup ---------------------------------------------------------------

function onStoreChange() {
  scheduleStatus();
  scheduleBackup();
}

function updateExportMenu() {
  const empty = store.isEmpty;
  for (const item of els.exportMenu.querySelectorAll("button")) item.disabled = empty;
  if (empty) toaster.show("info", "目前還沒有逐字稿可以匯出。", { key: "export-empty" });
}

async function exportTranscript(format) {
  if (store.isEmpty) return;
  if (store.entries.some((entry) => entry.language === "zh")) await ensureZhConverter();
  const options = { display: displayText, languageInfo, offsetMs: settings.srtOffsetMs, appVersion };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const files = {
    md: ["md", "text/markdown;charset=utf-8", () => exportMarkdown(store, options)],
    txt: ["txt", "text/plain;charset=utf-8", () => exportText(store, options)],
    json: ["json", "application/json;charset=utf-8", () => exportJson(store, options)],
    "srt-source": ["srt", "application/x-subrip;charset=utf-8", () => exportSrt(store, "source", options)],
    "srt-translation": ["srt", "application/x-subrip;charset=utf-8", () => exportSrt(store, "translation", options)],
    "srt-bilingual": ["srt", "application/x-subrip;charset=utf-8", () => exportSrt(store, "bilingual", options)],
  };
  const [extension, mimeType, build] = files[format];
  const content = build();
  if (!content.trim()) {
    toaster.show("info", "這個格式目前沒有內容（例如沒有翻譯或沒有原文）。");
    return;
  }
  const name = format.startsWith("srt") ? `keynote-${format.slice(4)}-${stamp}.${extension}` : `keynote-transcript-${stamp}.${extension}`;
  try {
    const result = await platform.saveFile(name, mimeType, content);
    if (result?.saved) {
      store.markSaved();
      updateLeaveGuard();
      scheduleBackup();
      if (platform.kind !== "web") toaster.show("success", `已儲存 ${result.path || name}`);
    }
  } catch (error) {
    toaster.show("error", `匯出失敗：${error.message}`);
  }
}

async function clearTranscript() {
  if (store.isEmpty) return;
  const message = store.hasUnsavedChanges ? "逐字稿還沒有匯出，確定要清除嗎？這個動作無法復原。" : "確定要清除目前的逐字稿嗎？";
  if (!(await confirmDialog(els.confirmDialog, message, { okText: "清除逐字稿" }))) return;
  store.reset();
  storage.remove(BACKUP_KEY);
  renderStatus();
}

function updateLeaveGuard() {
  const live = controller.status !== "idle";
  const unsaved = store.hasUnsavedChanges;
  const sharing = Boolean(share?.active);
  const message = live
    ? "即時字幕仍在進行中，確定要離開嗎？"
    : sharing
      ? "觀眾分享仍在進行中，離開後觀眾會看到「講者端離線」（12 小時內重新開啟可以接著分享）。確定要離開嗎？"
      : "逐字稿還沒有匯出，確定要離開嗎？";
  const guard = live || unsaved || sharing;
  const state = `${guard}:${message}`;
  if (state === lastLeaveGuard) return;
  lastLeaveGuard = state;
  platform.setLeaveGuard(guard, message);
}

function scheduleBackup() {
  if (!settings.autoBackup || backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = 0;
    if (store.isEmpty) storage.remove(BACKUP_KEY);
    else storage.set(BACKUP_KEY, JSON.stringify({ ...store.toJSON(), unsaved: store.hasUnsavedChanges }));
    updateLeaveGuard();
  }, 3000);
}

function offerBackupRestore() {
  if (!settings.autoBackup) return;
  let backup;
  try {
    backup = JSON.parse(storage.get(BACKUP_KEY) || "null");
  } catch {
    backup = null;
  }
  if (!backup?.unsaved || !Array.isArray(backup.entries) || backup.entries.length === 0) return;
  const when = backup.startedAt ? new Date(backup.startedAt).toLocaleString("zh-TW", { hour12: false }) : "上次";
  toaster.show("warning", `找到 ${when} 尚未匯出的逐字稿（${backup.entries.length} 句），要還原嗎？`, {
    key: "restore",
    timeout: 0,
    actions: [
      {
        label: "還原",
        onClick: () => {
          if (store.restore(backup, performance.now())) {
            toaster.show("success", "已還原逐字稿，記得匯出。");
            transcriptView?.invalidate();
            renderStatus();
          }
        },
      },
      { label: "捨棄", onClick: () => storage.remove(BACKUP_KEY) },
    ],
  });
}

function clampNumber(input, min, max) {
  const value = Math.min(max, Math.max(min, Number(input.value) || 0));
  input.value = String(value);
  return value;
}
