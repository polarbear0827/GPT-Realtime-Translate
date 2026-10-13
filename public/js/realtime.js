// Connections to the OpenAI Realtime API using short-lived client secrets.
//   TranslateClient  – gpt-realtime-translate over WebRTC (/v1/realtime/translations/calls); system audio
//                      in the macOS app uses NativeTranslateClient (native-translate.js) instead
//   TranscribeClient – gpt-live-transcribe over WebSocket, audio appended as PCM16, committed per turn

const TRANSLATION_CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
const REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";
const CONNECT_TIMEOUT_MS = 15_000;
const INTERRUPTED_GRACE_MS = 6_000;
const DRAIN_TIMEOUT_MS = 4_000;

// Routes a translation-session event (same names over WebRTC and WebSocket) to a client.
export function dispatchTranslationEvent(client, data) {
  let event;
  try {
    event = JSON.parse(String(data));
  } catch {
    return;
  }
  switch (event.type) {
    case "session.output_transcript.delta":
      if (typeof event.delta === "string") client.onEvent?.({ type: "output-delta", delta: event.delta });
      break;
    case "session.input_transcript.delta":
      if (typeof event.delta === "string") client.onEvent?.({ type: "input-delta", delta: event.delta });
      break;
    case "session.closed":
      client.resolveClosed?.();
      break;
    case "error":
      client.onEvent?.({ type: "error", error: event.error || {} });
      break;
    default:
      break;
  }
}

export class TranslateClient {
  constructor({ track, playAudio = false, onEvent, onState }) {
    this.track = track;
    this.onEvent = onEvent;
    this.onState = onState;
    this.closing = false;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.muted = !playAudio;
  }

  async connect(clientSecret, { audioEnabled = true } = {}) {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    // Same shape as OpenAI's reference client (addTrack with a stream); a muted transceiver is only
    // used while a replacement session warms up before the 60-minute limit.
    this.sender = audioEnabled
      ? pc.addTrack(this.track, new MediaStream([this.track]))
      : pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
    pc.ontrack = ({ streams, track }) => {
      this.audio.srcObject = streams[0] ?? new MediaStream([track]);
    };

    const channel = pc.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = ({ data }) => this.handleMessage(data);
    channel.onclose = () => {
      if (this.connected && !this.closing) this.onState?.("failed", "翻譯事件通道已中斷。");
    };

    // Before the first connection, failures reject connect(); afterwards they are reported through
    // onState so the session controller can reconnect. An open data channel also counts as connected.
    let resolveConnected;
    let rejectConnected;
    const connected = new Promise((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    connected.catch(() => {});
    channel.onopen = () => resolveConnected();
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        clearTimeout(this.interruptedTimer);
        if (this.connected) this.onState?.("live");
        resolveConnected();
      } else if (state === "disconnected" && this.connected) {
        // Usually transient (network switch); only treat it as failed if it doesn't recover.
        this.onState?.("interrupted");
        clearTimeout(this.interruptedTimer);
        this.interruptedTimer = setTimeout(() => {
          if (pc.connectionState !== "connected" && !this.closing) this.onState?.("failed", "翻譯連線中斷。");
        }, INTERRUPTED_GRACE_MS);
      } else if (state === "failed") {
        rejectConnected(new Error("翻譯連線失敗（WebRTC 無法建立，可能是網路擋住 UDP）。"));
        if (this.connected && !this.closing) this.onState?.("failed", "翻譯連線失敗。");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetchWithTimeout(TRANSLATION_CALLS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    }, 20_000);
    const answer = await response.text();
    if (!response.ok) throw new Error(apiErrorMessage(answer, "無法建立翻譯連線。"));
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    // ICE and DTLS only start now, so they get their own time budget (not shared with the SDP request).
    const timer = setTimeout(() => {
      rejectConnected(new Error(`翻譯連線逾時（WebRTC：${pc.iceConnectionState} / ${pc.connectionState}；可能是網路擋住 UDP）。`));
    }, 20_000);
    try {
      await connected;
    } finally {
      clearTimeout(timer);
    }
    this.connected = true;
    this.connectedAt = performance.now();
  }

  handleMessage(data) {
    dispatchTranslationEvent(this, data);
  }

  setAudioEnabled(enabled) {
    return this.sender?.replaceTrack(enabled ? this.track : null).catch(() => {});
  }

  setPlayAudio(play) {
    this.audio.muted = !play;
  }

  // Graceful close asks the service to finish translating audio it already received
  // (session.close → session.closed) so the last sentence isn't cut off.
  async close({ graceful = true } = {}) {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.interruptedTimer);
    if (graceful && this.channel?.readyState === "open") {
      await this.setAudioEnabled(false);
      const closed = new Promise((resolve) => {
        this.resolveClosed = resolve;
      });
      try {
        this.channel.send(JSON.stringify({ type: "session.close" }));
        await Promise.race([closed, delay(DRAIN_TIMEOUT_MS)]);
      } catch {
        // Channel closed while draining.
      }
    }
    this.channel?.close();
    this.pc?.close();
    this.audio.srcObject = null;
  }
}

export class TranscribeClient {
  constructor({ onEvent, onState }) {
    this.onEvent = onEvent;
    this.onState = onState;
    this.closing = false;
    this.pendingTurns = [];
    this.pendingItems = new Set();
    this.bufferedMs = 0;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(clientSecret) {
    const ws = new WebSocket(REALTIME_WS_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("轉錄連線逾時。")), CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("無法建立轉錄連線。"));
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(event.reason || "轉錄連線被關閉。"));
      };
    });
    ws.onmessage = ({ data }) => this.handleMessage(data);
    ws.onerror = () => {};
    ws.onclose = (event) => {
      this.resolveDrained?.();
      if (!this.closing) this.onState?.("failed", event.reason || "轉錄連線中斷。");
    };
    this.connectedAt = performance.now();
    this.onState?.("live");
  }

  append(pcm) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }));
    this.bufferedMs += 50;
    return true;
  }

  // Ends the current speech turn. Returns false when there is nothing to commit.
  commit(turn) {
    if (!this.isOpen || this.bufferedMs < 100) return false;
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.pendingTurns.push(turn);
    this.bufferedMs = 0;
    return true;
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.committed": {
        const turn = this.pendingTurns.shift() ?? null;
        if (event.item_id) this.pendingItems.add(event.item_id);
        this.onEvent?.({ type: "committed", itemId: event.item_id, turn });
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        if (event.item_id) this.pendingItems.add(event.item_id);
        if (typeof event.delta === "string") this.onEvent?.({ type: "delta", itemId: event.item_id, delta: event.delta });
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.pendingItems.delete(event.item_id);
        this.onEvent?.({ type: "completed", itemId: event.item_id, transcript: String(event.transcript ?? "") });
        this.checkDrained();
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.pendingItems.delete(event.item_id);
        this.onEvent?.({ type: "item-failed", itemId: event.item_id, error: event.error || {} });
        this.checkDrained();
        break;
      case "error":
        if (event.error?.code === "input_audio_buffer_commit_empty") {
          this.pendingTurns.pop();
          this.checkDrained();
          break;
        }
        this.onEvent?.({ type: "error", error: event.error || {} });
        break;
      default:
        break;
    }
  }

  checkDrained() {
    if (this.pendingItems.size === 0 && this.pendingTurns.length === 0) this.resolveDrained?.();
  }

  // Graceful close waits for transcripts of already committed turns.
  async close({ graceful = true } = {}) {
    if (this.closing) return;
    this.closing = true;
    if (graceful && this.isOpen && (this.pendingItems.size > 0 || this.pendingTurns.length > 0)) {
      await Promise.race([
        new Promise((resolve) => {
          this.resolveDrained = resolve;
        }),
        delay(DRAIN_TIMEOUT_MS),
      ]);
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
  }
}

async function fetchWithTimeout(url, init, timeoutMs = CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "連線 OpenAI 逾時。" : "無法連線到 OpenAI，請檢查網路。");
  } finally {
    clearTimeout(timer);
  }
}

export function apiErrorMessage(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    return (typeof error === "string" ? error : error?.message) || fallback;
  } catch {
    return text && text.length < 200 ? text : fallback;
  }
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
