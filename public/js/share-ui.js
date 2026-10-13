// "分享給觀眾" panel: connects the app to the user's relay, starts, pauses and ends a room, shows its QR
// code and drives the SharePublisher. Also renders the QR code in the caption corner and the full-screen
// QR projection, in this window and (through main.js) in the caption window.

import * as api from "./api.js";
import { platform } from "./platform.js";
import { qrSvg } from "./qr.js";
import { SharePublisher, buildMeta } from "./share.js";

const ROOM_KEY = "keynote:shareRoom";
const REOPEN_KEY = "keynote:reopenShare";
// The relay deletes a room 12 hours after its host was last seen.
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const PHASES = {
  connecting: "連線中…",
  live: "分享中",
  reconnecting: "重新連線中…",
  failed: "已中斷",
  ended: "已結束",
};

export class ShareUi {
  constructor({ settings, updateSetting, feed, display, languageInfo, toaster, confirm, storage, getSessionStatus, isBusy, onChange }) {
    this.settings = settings;
    this.updateSetting = updateSetting;
    this.languageInfo = languageInfo;
    this.toaster = toaster;
    this.confirm = confirm;
    this.storage = storage;
    this.getSessionStatus = getSessionStatus;
    this.isBusy = isBusy;
    this.onChange = onChange;
    this.configured = false;
    this.origin = "";
    this.editingServer = false;
    this.projecting = false;
    this.publisher = new SharePublisher({ feed, display, languageInfo, onChange: () => this.publisherChanged() });
    const $ = (id) => document.getElementById(id);
    this.els = {
      button: $("shareBtn"),
      buttonLabel: $("shareBtnLabel"),
      panel: $("sharePanel"),
      setup: $("shareSetup"),
      configForm: $("shareConfigForm"),
      urlInput: $("shareUrlInput"),
      keyInput: $("shareKeyInput"),
      configError: $("shareConfigError"),
      configSave: $("shareConfigSaveBtn"),
      configCancel: $("shareConfigCancelBtn"),
      configRemove: $("shareConfigRemoveBtn"),
      configNote: $("shareConfigNote"),
      manual: $("shareManual"),
      autoSteps: $("shareAutoSteps"),
      autoHint: $("shareAutoHint"),
      live: $("shareLive"),
      qr: $("shareQr"),
      phase: $("sharePhase"),
      phaseLabel: $("sharePhaseLabel"),
      viewers: $("shareViewers"),
      link: $("shareLink"),
      copy: $("shareCopyBtn"),
      project: $("shareProjectBtn"),
      pause: $("sharePauseBtn"),
      pausedNote: $("sharePausedNote"),
      captionQrToggle: $("shareCaptionQrToggle"),
      noteForm: $("shareNoteForm"),
      noteInput: $("shareNoteInput"),
      noteCurrent: $("shareNoteCurrent"),
      noteText: $("shareNoteText"),
      noteClear: $("shareNoteClearBtn"),
      options: $("shareOptions"),
      titleInput: $("shareTitleInput"),
      originalToggle: $("shareOriginalToggle"),
      startBlock: $("shareStartBlock"),
      start: $("shareStartBtn"),
      error: $("shareError"),
      serverLabel: $("shareServerLabel"),
      changeServer: $("shareChangeServerBtn"),
      endBlock: $("shareEndBlock"),
      end: $("shareEndBtn"),
      captionQr: $("captionQr"),
      captionQrCode: $("captionQrCode"),
      dialog: $("qrDialog"),
    };
  }

  get active() {
    return this.publisher.active;
  }

  get viewerUrl() {
    return this.publisher.room?.viewerUrl ?? "";
  }

  // `share` is /api/health's { configured, origin }.
  init(share, platformInfo) {
    this.configured = Boolean(share?.configured);
    this.origin = share?.origin ?? "";
    if (platformInfo?.platform !== "macos") {
      // Automatic pairing needs the macOS app; the dev server is set up by hand or with KLT_RELAY_*.
      this.els.configNote.textContent = "發佈金鑰只保存在這個本機服務的記憶體中。連接後畫面會重新載入一次。";
      this.els.autoSteps.hidden = true;
      this.els.autoHint.hidden = true;
      this.els.manual.open = true;
    }
    this.els.titleInput.value = this.settings.shareTitle;
    this.els.originalToggle.checked = this.settings.shareOriginal;
    this.els.captionQrToggle.checked = this.settings.shareCaptionQr;
    this.bind();
    this.render();
    this.offerResume();
    // `npm run relay:deploy` opens the app with a setup link; native code hands it over.
    window.__kltShareSetup = (setup) => this.handleSetupLink(setup);
    platform.takeShareSetup?.().then((setup) => this.handleSetupLink(setup));
    if (this.storage.get(REOPEN_KEY)) {
      this.storage.remove(REOPEN_KEY);
      this.onChange({ openPanel: true });
      if (this.configured) this.toaster.show("success", "分享伺服器已連接，可以開始分享了。");
    }
  }

  bind() {
    const { els } = this;
    els.configForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveServer();
    });
    els.configCancel.addEventListener("click", () => {
      this.editingServer = false;
      this.render();
    });
    els.configRemove.addEventListener("click", () => this.removeServer());
    els.changeServer.addEventListener("click", () => {
      this.editingServer = true;
      els.urlInput.value = this.origin;
      els.keyInput.value = "";
      this.render();
      els.keyInput.focus();
    });
    els.start.addEventListener("click", () => this.start());
    els.end.addEventListener("click", () => this.end());
    els.copy.addEventListener("click", () => this.copyLink());
    els.project.addEventListener("click", () => this.setProjecting(true));
    els.pause.addEventListener("click", () => this.publisher.setPaused(!this.publisher.paused));
    els.captionQrToggle.addEventListener("change", () => {
      this.updateSetting("shareCaptionQr", els.captionQrToggle.checked);
      this.render();
    });
    els.noteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.publisher.setNote(els.noteInput.value);
      els.noteInput.value = "";
    });
    els.noteClear.addEventListener("click", () => this.publisher.setNote(""));
    els.titleInput.addEventListener("change", () => {
      this.updateSetting("shareTitle", els.titleInput.value.trim().slice(0, 80));
      this.updateMeta();
    });
    els.originalToggle.addEventListener("change", () => {
      this.updateSetting("shareOriginal", els.originalToggle.checked);
      this.updateMeta();
    });
    els.dialog.addEventListener("close", () => {
      if (this.projecting) this.setProjecting(false);
    });
    document.getElementById("qrDialogCloseBtn").addEventListener("click", () => this.setProjecting(false));
    window.addEventListener("pagehide", () => this.publisher.dispose());
  }

  // ---- server -------------------------------------------------------------------------------

  async saveServer() {
    const { els } = this;
    if (this.isBusy()) {
      this.showConfigError("請先停止字幕，再連接分享伺服器（畫面需要重新載入）。");
      return;
    }
    this.showConfigError("");
    els.configSave.disabled = true;
    els.configSave.textContent = "驗證中…";
    try {
      await api.saveShareConfig(els.urlInput.value, els.keyInput.value);
      els.keyInput.value = "";
      // The page may only connect to the relay after reloading with the new security policy.
      this.storage.set(REOPEN_KEY, "1");
      location.reload();
    } catch (error) {
      this.showConfigError(error.message || "無法連接分享伺服器。");
      els.configSave.disabled = false;
      els.configSave.textContent = "連接並驗證";
    }
  }

  // A setup link carries the relay URL and publish key, so nothing has to be copied. Any app or web page
  // could open such a link, so the user confirms the server first.
  async handleSetupLink(setup) {
    if (typeof setup?.url !== "string" || typeof setup?.key !== "string") return;
    this.onChange({ openPanel: true });
    const host = setup.url.replace(/^https?:\/\//, "");
    if (this.active || this.isBusy()) {
      this.toaster.show("warning", `要連接分享伺服器 ${host}，請先停止字幕並結束目前的分享，再執行一次 npm run relay:connect。`, { key: "share-setup", timeout: 0 });
      return;
    }
    const message = this.configured && this.origin === setup.url
      ? `重新連接分享伺服器「${host}」嗎？（發佈金鑰會更新成剛部署的這一組）`
      : `要連接分享伺服器「${host}」嗎？只有在你剛執行 npm run relay:deploy 或 relay:connect 時才按「連接」。`;
    if (!(await this.confirm(message, { okText: "連接", cancelText: "取消" }))) return;
    this.editingServer = true;
    this.els.manual.open = true;
    this.els.urlInput.value = setup.url;
    this.els.keyInput.value = setup.key;
    this.render();
    await this.saveServer();
  }

  async removeServer() {
    if (this.active || this.isBusy()) return;
    if (!(await this.confirm("確定要中斷與分享伺服器的連接嗎？之後需要重新貼上網址與發佈金鑰。", { okText: "中斷連接" }))) return;
    try {
      await api.deleteShareConfig();
      this.clearRoom();
      location.reload();
    } catch (error) {
      this.showConfigError(error.message);
    }
  }

  showConfigError(message) {
    this.els.configError.textContent = message;
    this.els.configError.hidden = !message;
  }

  // ---- room ---------------------------------------------------------------------------------

  meta() {
    return buildMeta({
      title: this.settings.shareTitle,
      mode: this.settings.captionMode,
      sourceLanguage: this.settings.sourceLanguage,
      targetLanguage: this.settings.targetLanguage,
      original: this.settings.shareOriginal,
      languageInfo: this.languageInfo,
    });
  }

  updateMeta() {
    if (this.active) this.publisher.setMeta(this.meta());
  }

  setSessionStatus(status) {
    if (this.active) this.publisher.setSessionStatus(status);
  }

  async start() {
    const { els } = this;
    this.settings.shareTitle = els.titleInput.value.trim().slice(0, 80);
    this.updateSetting("shareTitle", this.settings.shareTitle);
    els.start.disabled = true;
    els.start.textContent = "建立中…";
    try {
      const room = await api.createShareRoom(this.settings.shareTitle);
      this.saveRoom(room);
      this.begin(room);
    } catch (error) {
      this.toaster.show("error", `無法開始分享：${error.message}`, { key: "share" });
    } finally {
      els.start.disabled = false;
      els.start.textContent = "開始分享";
    }
  }

  begin(room, { note = "", paused = false } = {}) {
    this.publisher.start(room, { meta: this.meta(), sessionStatus: this.getSessionStatus(), note, paused });
    this.render();
  }

  async end() {
    if (!(await this.confirm("結束分享後，觀眾畫面會顯示「已結束」，這個 QR Code 也會失效。確定要結束嗎？", { okText: "結束分享" }))) return;
    this.els.end.disabled = true;
    await this.publisher.end();
    this.els.end.disabled = false;
    this.clearRoom();
    this.setProjecting(false);
    this.toaster.show("info", "已結束分享。", { key: "share" });
    this.render();
  }

  // A room survives an app restart (the relay keeps it for 12 hours), so viewers needn't rescan.
  offerResume() {
    if (!this.configured) return;
    let saved;
    try {
      saved = JSON.parse(this.storage.get(ROOM_KEY) || "null");
    } catch {
      saved = null;
    }
    if (!saved?.room?.socketUrl || saved.origin !== this.origin || Date.now() - saved.savedAt > ROOM_MAX_AGE_MS) {
      this.clearRoom();
      return;
    }
    this.toaster.show("warning", "上次的分享還沒有結束，觀眾的連結仍然有效。要接著分享嗎？", {
      key: "share-resume",
      timeout: 0,
      actions: [
        { label: "接著分享", onClick: () => this.begin(saved.room, { note: saved.note ?? "", paused: Boolean(saved.paused) }) },
        {
          label: "結束它",
          onClick: async () => {
            this.publisher.start(saved.room, { meta: this.meta() });
            await this.publisher.end();
            this.clearRoom();
            this.render();
          },
        },
      ],
    });
  }

  // The announcement and the pause carry over when the room is resumed.
  saveRoom(room) {
    const { note, paused } = this.publisher.room === room ? this.publisher : { note: "", paused: false };
    this.storage.set(ROOM_KEY, JSON.stringify({ room, origin: this.origin, savedAt: Date.now(), note, paused }));
  }

  touchRoom() {
    if (this.publisher.room && this.active) this.saveRoom(this.publisher.room);
  }

  clearRoom() {
    this.storage.remove(ROOM_KEY);
  }

  publisherChanged() {
    const { phase, error } = this.publisher;
    if (phase === "failed") {
      this.clearRoom();
      this.setProjecting(false);
      this.toaster.show("error", error, { key: "share", timeout: 0 });
    } else {
      this.touchRoom();
    }
    this.render();
  }

  // ---- actions ------------------------------------------------------------------------------

  async copyLink() {
    const url = this.viewerUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const field = document.createElement("textarea");
      field.value = url;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    this.toaster.show("success", "已複製觀眾連結。", { key: "share-copy" });
  }

  setProjecting(on) {
    const projecting = Boolean(on && this.active);
    if (projecting === this.projecting && projecting === this.els.dialog.open) return;
    this.projecting = projecting;
    applyQrDialog(this.els.dialog, this.projectionState());
    this.onChange({});
  }

  toggleProjecting() {
    if (this.active) this.setProjecting(!this.projecting);
  }

  projectionState() {
    return { open: this.projecting && this.active, url: this.viewerUrl, title: this.settings.shareTitle };
  }

  captionQrState() {
    return { show: this.active && this.settings.shareCaptionQr, url: this.viewerUrl };
  }

  // ---- rendering ----------------------------------------------------------------------------

  render() {
    const { els, publisher } = this;
    const active = this.active;
    const editing = !this.configured || this.editingServer;
    els.setup.hidden = !editing || active;
    els.configCancel.hidden = !this.configured;
    els.configRemove.hidden = !this.configured;
    els.options.hidden = editing && !active;
    els.startBlock.hidden = editing || active;
    els.live.hidden = !active;
    els.endBlock.hidden = !active;
    els.serverLabel.textContent = this.origin.replace(/^https?:\/\//, "");
    els.error.hidden = publisher.phase !== "failed";
    els.error.textContent = publisher.phase === "failed" ? publisher.error : "";

    if (active) {
      els.phase.dataset.phase = publisher.paused && publisher.phase === "live" ? "paused" : publisher.phase;
      els.phaseLabel.textContent = publisher.paused && publisher.phase === "live" ? "暫停中" : PHASES[publisher.phase] ?? publisher.phase;
      els.viewers.textContent = publisher.viewers.toLocaleString("zh-TW");
      els.link.textContent = this.viewerUrl.replace(/^https?:\/\//, "");
      els.pause.setAttribute("aria-pressed", String(publisher.paused));
      els.pause.textContent = publisher.paused ? "繼續分享" : "暫停分享";
      els.pausedNote.hidden = !publisher.paused;
      els.noteCurrent.hidden = !publisher.note;
      els.noteText.textContent = publisher.note ? `目前公告：${publisher.note}` : "";
      renderQr(els.qr, this.viewerUrl, "觀眾連結的 QR Code");
    }

    els.button.dataset.state = active ? (publisher.phase === "live" ? (publisher.paused ? "paused" : "live") : "connecting") : "off";
    els.buttonLabel.textContent = active ? `分享中・${publisher.viewers.toLocaleString("zh-TW")} 人` : "分享";
    renderCaptionQr(els.captionQr, els.captionQrCode, this.captionQrState());
    if (this.projecting) applyQrDialog(els.dialog, this.projectionState());
    this.onChange({});
  }
}

// QR codes are only rebuilt when the link changes.
export function renderQr(container, url, label) {
  if (container.dataset.url === url) return;
  container.dataset.url = url;
  container.replaceChildren(url ? qrSvg(url, { ecc: "M", margin: 2, label }) : "");
}

export function renderCaptionQr(container, code, state) {
  const show = Boolean(state?.show && state.url);
  container.hidden = !show;
  // The captions next to the QR code wrap before it instead of running underneath.
  document.body.classList.toggle("has-caption-qr", show);
  if (show) renderQr(code, state.url, "用手機掃描，看即時翻譯");
}

// The projection fills the window: a QR code big enough to scan from the back of the room.
export function applyQrDialog(dialog, state) {
  if (!state?.open || !state.url) {
    if (dialog.open) dialog.close();
    return;
  }
  document.getElementById("qrDialogTitle").textContent = state.title || "即時翻譯";
  document.getElementById("qrDialogUrl").textContent = state.url.replace(/^https?:\/\//, "");
  renderQr(document.getElementById("qrDialogCode"), state.url, "用手機掃描，看即時翻譯");
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
}
