// Translation for system audio in the macOS app: the app opens the translation WebSocket itself (with
// the API key) and streams the audio it captures straight into it, so no WebRTC/UDP is involved.
// Same interface as TranslateClient; events arrive via window.__kltTranslationEvent.

import { platform } from "./platform.js";
import { dispatchTranslationEvent } from "./realtime.js";

const clients = new Map();

function installHandlers() {
  window.__kltTranslationEvent = (id, data) => clients.get(id)?.handleMessage(data);
  window.__kltTranslationClosed = (id, reason) => clients.get(id)?.handleClosed(reason);
}

export class NativeTranslateClient {
  static get supported() {
    return Boolean(platform?.openTranslation);
  }

  constructor({ targetLanguage, onEvent, onState }) {
    this.id = crypto.randomUUID();
    this.targetLanguage = targetLanguage;
    this.onEvent = onEvent;
    this.onState = onState;
    this.closing = false;
  }

  async connect(_clientSecret, { audioEnabled = true } = {}) {
    installHandlers();
    clients.set(this.id, this);
    try {
      await platform.openTranslation({ id: this.id, targetLanguage: this.targetLanguage, audioEnabled });
    } catch (error) {
      clients.delete(this.id);
      throw error;
    }
    this.connected = true;
    this.connectedAt = performance.now();
  }

  handleMessage(data) {
    dispatchTranslationEvent(this, data);
  }

  handleClosed(reason) {
    clients.delete(this.id);
    if (this.connected && !this.closing) this.onState?.("failed", reason || "翻譯連線中斷。");
  }

  setAudioEnabled(enabled) {
    return platform.setTranslationAudio({ id: this.id, enabled });
  }

  setPlayAudio() {}

  async close({ graceful = true } = {}) {
    if (this.closing) return;
    this.closing = true;
    await platform.closeTranslation({ id: this.id, graceful }).catch(() => {});
    clients.delete(this.id);
  }
}
