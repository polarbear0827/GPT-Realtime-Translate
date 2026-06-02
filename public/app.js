const state = {
  status: "idle",
  hasApiKey: false,
  recording: true,
  paused: false,
  playAudio: false,
  captionMode: window.localStorage.getItem("keynote:captionMode") || "bilingual",
  sourceText: "",
  translatedText: "",
  splitRatio: readNumber("splitRatio", 0.48),
  sourceFontSize: readNumber("sourceFontSize", 48),
  translatedFontSize: readNumber("translatedFontSize", 62),
  segments: [],
  currentSegment: null,
  nextSegmentIndex: 1,
  sessionStartedAt: performance.now(),
  idleTimer: null,
  pc: null,
  sourceStream: null,
  remoteAudio: null,
  channel: null,
  transcriptionWs: null,
  audioContext: null,
  audioSourceNode: null,
  audioProcessorNode: null,
  transcriptionCommitTimer: null,
  transcriptionAudioSinceCommit: false,
  transcriptionItems: new Map(),
  transcriptionOrder: [],
  traditionalConverter: null,
};

const els = {
  statusDot: byId("statusDot"),
  statusLine: byId("statusLine"),
  openKeyBtn: byId("openKeyBtn"),
  clearKeyBtn: byId("clearKeyBtn"),
  startBtn: byId("startBtn"),
  stopBtn: byId("stopBtn"),
  recordBtn: byId("recordBtn"),
  captionModeSelect: byId("captionModeSelect"),
  pauseBtn: byId("pauseBtn"),
  audioBtn: byId("audioBtn"),
  micTestBtn: byId("micTestBtn"),
  markBtn: byId("markBtn"),
  micSelect: byId("micSelect"),
  sourceFont: byId("sourceFont"),
  translatedFont: byId("translatedFont"),
  clearCaptionsBtn: byId("clearCaptionsBtn"),
  clearTranscriptBtn: byId("clearTranscriptBtn"),
  exportSelect: byId("exportSelect"),
  fullscreenBtn: byId("fullscreenBtn"),
  errorBanner: byId("errorBanner"),
  captionLayout: byId("captionLayout"),
  sourceCaption: byId("sourceCaption"),
  translatedCaption: byId("translatedCaption"),
  splitter: byId("splitter"),
  transcriptPanel: byId("transcriptPanel"),
  transcriptToggle: byId("transcriptToggle"),
  transcriptScroll: byId("transcriptScroll"),
  keyModal: byId("keyModal"),
  keyForm: byId("keyForm"),
  apiKeyInput: byId("apiKeyInput"),
  keyError: byId("keyError"),
  closeModalBtn: byId("closeModalBtn"),
};

init();

async function init() {
  initTraditionalConverter();
  if (!["bilingual", "zh", "en"].includes(state.captionMode)) state.captionMode = "bilingual";
  els.captionModeSelect.value = state.captionMode;
  els.sourceFont.value = String(state.sourceFontSize);
  els.translatedFont.value = String(state.translatedFontSize);
  applyLayoutSettings();
  bindEvents();
  await refreshHealth();
  await refreshDevices();
  render();
}

function initTraditionalConverter() {
  if (window.OpenCC?.Converter) {
    state.traditionalConverter = window.OpenCC.Converter({ from: "cn", to: "twp" });
  }
}

function bindEvents() {
  els.openKeyBtn.addEventListener("click", () => showKeyModal(true));
  els.closeModalBtn.addEventListener("click", () => showKeyModal(false));
  els.keyForm.addEventListener("submit", saveApiKey);
  els.clearKeyBtn.addEventListener("click", clearApiKey);
  els.startBtn.addEventListener("click", startRealtime);
  els.stopBtn.addEventListener("click", stopRealtime);
  els.recordBtn.addEventListener("click", () => {
    state.recording = !state.recording;
    render();
  });
  els.captionModeSelect.addEventListener("change", () => {
    state.captionMode = els.captionModeSelect.value;
    window.localStorage.setItem("keynote:captionMode", state.captionMode);
    applyLayoutSettings();
    render();
  });
  els.pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    render();
  });
  els.audioBtn.addEventListener("click", () => {
    state.playAudio = !state.playAudio;
    if (state.remoteAudio) state.remoteAudio.muted = !state.playAudio;
    render();
  });
  els.micTestBtn.addEventListener("click", testMicrophonePermission);
  els.markBtn.addEventListener("click", closeCurrentSegment);
  els.clearCaptionsBtn.addEventListener("click", clearCaptions);
  els.clearTranscriptBtn.addEventListener("click", clearTranscript);
  els.exportSelect.addEventListener("change", () => {
    exportTranscript(els.exportSelect.value);
    els.exportSelect.value = "";
  });
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  els.transcriptToggle.addEventListener("click", () => {
    els.transcriptPanel.classList.toggle("open");
  });
  els.sourceFont.addEventListener("input", () => {
    state.sourceFontSize = Number(els.sourceFont.value);
    writeNumber("sourceFontSize", state.sourceFontSize);
    applyLayoutSettings();
  });
  els.translatedFont.addEventListener("input", () => {
    state.translatedFontSize = Number(els.translatedFont.value);
    writeNumber("translatedFontSize", state.translatedFontSize);
    applyLayoutSettings();
  });
  bindSplitter();
  window.addEventListener("beforeunload", (event) => {
    if (state.segments.length > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

async function testMicrophonePermission() {
  clearError();
  try {
    const permissionState = await queryMicrophonePermission();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: els.micSelect.value
        ? { deviceId: { exact: els.micSelect.value } }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const tracks = stream.getAudioTracks();
    tracks.forEach((track) => track.stop());
    await refreshDevices();
    showInfo(
      `麥克風測試成功。瀏覽器權限狀態：${permissionState || "unknown"}；偵測到 ${tracks.length} 個音訊 track。`,
    );
  } catch (error) {
    showError(`${formatStartupError(error)} 目前瀏覽器：${navigator.userAgent}`);
  }
}

async function queryMicrophonePermission() {
  try {
    if (!navigator.permissions?.query) return "";
    const result = await navigator.permissions.query({ name: "microphone" });
    return result.state;
  } catch {
    return "";
  }
}

function bindSplitter() {
  let dragging = false;
  els.splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    els.splitter.setPointerCapture(event.pointerId);
    els.splitter.dataset.dragging = "true";
  });
  els.splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = els.captionLayout.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    state.splitRatio = Math.min(0.78, Math.max(0.22, ratio));
    writeNumber("splitRatio", state.splitRatio);
    applyLayoutSettings();
  });
  els.splitter.addEventListener("pointerup", (event) => {
    dragging = false;
    els.splitter.dataset.dragging = "false";
    els.splitter.releasePointerCapture(event.pointerId);
  });
}

async function refreshHealth() {
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    state.hasApiKey = Boolean(health.hasApiKey);
    showKeyModal(!state.hasApiKey);
  } catch {
    showError("無法連線到本機 server。");
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    els.micSelect.innerHTML = '<option value="">Default</option>';
    for (const device of inputs) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${device.deviceId.slice(0, 6)}`;
      els.micSelect.append(option);
    }
  } catch {
    // Device labels are unavailable until microphone permission is granted.
  }
}

async function saveApiKey(event) {
  event.preventDefault();
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey.startsWith("sk-")) {
    showKeyError("請輸入有效的 OpenAI API key。");
    return;
  }

  try {
    const response = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    if (!response.ok) throw new Error("API key 儲存失敗。");
    els.apiKeyInput.value = "";
    state.hasApiKey = true;
    showKeyModal(false);
    render();
  } catch (error) {
    showKeyError(error.message || "API key 儲存失敗。");
  }
}

async function clearApiKey() {
  if (state.status === "live") return;
  await fetch("/api/key", { method: "DELETE" });
  state.hasApiKey = false;
  showKeyModal(true);
  render();
}

async function startRealtime() {
  if (!state.hasApiKey) {
    showKeyModal(true);
    return;
  }
  clearError();
  clearCaptions();
  state.sessionStartedAt = performance.now();
  state.segments = [];
  state.currentSegment = null;
  state.nextSegmentIndex = 1;
  state.transcriptionItems = new Map();
  state.transcriptionOrder = [];
  renderTranscript();

  try {
    const needsTranslation = state.captionMode !== "en";
    const needsTranscription = state.captionMode !== "zh";
    setStatus("creating-token");
    const [translationClientSecret, transcriptionClientSecret] = await Promise.all([
      needsTranslation ? createTranslationClientSecret() : Promise.resolve(null),
      needsTranscription ? createTranscriptionClientSecret() : Promise.resolve(null),
    ]);
    setStatus("requesting-microphone");
    state.sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: els.micSelect.value
        ? { deviceId: { exact: els.micSelect.value } }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await refreshDevices();

    setStatus("connecting");
    if (needsTranslation) {
      state.pc = new RTCPeerConnection();
      for (const track of state.sourceStream.getAudioTracks()) {
        state.pc.addTrack(track, state.sourceStream);
      }

      state.remoteAudio = new Audio();
      state.remoteAudio.autoplay = true;
      state.remoteAudio.muted = !state.playAudio;
      state.pc.ontrack = ({ streams }) => {
        if (streams[0]) state.remoteAudio.srcObject = streams[0];
      };

      state.channel = state.pc.createDataChannel("oai-events");
      state.channel.onmessage = ({ data }) => handleRealtimeMessage(String(data));
      state.channel.onerror = () => showError("Realtime translation event channel failed.");
      state.pc.onconnectionstatechange = () => {
        if (!state.pc) return;
        if (state.pc.connectionState === "connected") setStatus("live");
        if (state.pc.connectionState === "failed" || state.pc.connectionState === "disconnected") {
          showError(`Realtime translation connection ${state.pc.connectionState}.`);
          setStatus("error");
        }
      };
    }

    if (needsTranscription) {
      await startRealtimeTranscription(transcriptionClientSecret, state.sourceStream);
    }

    if (needsTranslation) {
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${translationClientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!sdpResponse.ok) throw new Error(await sdpResponse.text());
      await state.pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    } else {
      setStatus("live");
    }
  } catch (error) {
    showError(formatStartupError(error));
    setStatus("error");
    stopRealtime();
  }
}

function formatStartupError(error) {
  const name = error?.name || "";
  const message = error?.message || "";
  if (name === "NotAllowedError" || /not allowed|denied permission|permission/i.test(message)) {
    return "麥克風權限被瀏覽器或系統擋住了。請在瀏覽器網站設定允許麥克風，並在 macOS「系統設定 > 隱私權與安全性 > 麥克風」允許目前瀏覽器，然後重新整理再按 Start。";
  }
  if (name === "NotFoundError" || /not found|device/i.test(message)) {
    return "找不到可用麥克風。請確認麥克風已連接，或到「進階設定」選擇另一個 Mic。";
  }
  if (name === "NotReadableError" || /not readable|in use/i.test(message)) {
    return "麥克風目前無法讀取，可能被其他 App 佔用。請關閉正在使用麥克風的 App 後再試一次。";
  }
  return message || "無法啟動即時翻譯。";
}

function stopRealtime() {
  closeCurrentSegment();
  setStatus("stopping");
  stopRealtimeTranscription();
  state.channel?.close();
  state.channel = null;
  state.pc?.getSenders().forEach((sender) => sender.track?.stop());
  state.pc?.close();
  state.pc = null;
  state.sourceStream?.getTracks().forEach((track) => track.stop());
  state.sourceStream = null;
  if (state.remoteAudio) {
    state.remoteAudio.srcObject = null;
    state.remoteAudio = null;
  }
  setStatus("stopped");
}

async function createTranslationClientSecret() {
  const response = await fetch("/api/realtime/translation-client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "zh", safetyIdentifier: "local-keynote-user" }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(message || "Unable to create realtime client secret.");
  }
  const token = payload.value || payload.client_secret?.value;
  if (!token) throw new Error("Realtime client secret response did not include a token.");
  return token;
}

async function createTranscriptionClientSecret() {
  const response = await fetch("/api/realtime/transcription-client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delay: "low", safetyIdentifier: "local-keynote-user" }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(message || "Unable to create realtime transcription client secret.");
  }
  const token = payload.value || payload.client_secret?.value;
  if (!token) throw new Error("Realtime transcription client secret response did not include a token.");
  return token;
}

async function startRealtimeTranscription(clientSecret, stream) {
  const ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper", [
    "realtime",
    `openai-insecure-api-key.${clientSecret}`,
  ]);
  state.transcriptionWs = ws;

  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Realtime Whisper connection timed out.")), 12000);
    ws.onopen = () => {
      window.clearTimeout(timer);
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "gpt-realtime-whisper", language: "en", delay: "low" },
                noise_reduction: { type: "near_field" },
                turn_detection: null,
              },
            },
          },
        }),
      );
      resolve();
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("Unable to connect to Realtime Whisper."));
    };
  });

  ws.onmessage = (message) => handleTranscriptionMessage(String(message.data));
  ws.onclose = () => {
    state.transcriptionWs = null;
  };
  startAudioFanout(stream);
}

function stopRealtimeTranscription() {
  if (state.transcriptionCommitTimer) {
    window.clearInterval(state.transcriptionCommitTimer);
    state.transcriptionCommitTimer = null;
  }
  commitTranscriptionAudio();
  state.audioProcessorNode?.disconnect();
  state.audioProcessorNode = null;
  state.audioSourceNode?.disconnect();
  state.audioSourceNode = null;
  state.audioContext?.close();
  state.audioContext = null;
  state.transcriptionWs?.close();
  state.transcriptionWs = null;
}

function startAudioFanout(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContextClass();
  const resumePromise = state.audioContext.resume?.();
  if (resumePromise) resumePromise.catch(() => {});
  state.audioSourceNode = state.audioContext.createMediaStreamSource(stream);
  state.audioProcessorNode = state.audioContext.createScriptProcessor(4096, 1, 1);
  state.audioProcessorNode.onaudioprocess = (event) => {
    const ws = state.transcriptionWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = floatToPcm16(resampleTo24k(input, state.audioContext.sampleRate));
    if (pcm16.byteLength === 0) return;
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: arrayBufferToBase64(pcm16.buffer) }));
    state.transcriptionAudioSinceCommit = true;
  };
  state.audioSourceNode.connect(state.audioProcessorNode);
  state.audioProcessorNode.connect(state.audioContext.destination);
  state.transcriptionCommitTimer = window.setInterval(commitTranscriptionAudio, 900);
}

function commitTranscriptionAudio() {
  const ws = state.transcriptionWs;
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.transcriptionAudioSinceCommit) return;
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  state.transcriptionAudioSinceCommit = false;
}

function resampleTo24k(input, sampleRate) {
  if (!input.length) return input;
  if (sampleRate === 24000) return input;
  const ratio = sampleRate / 24000;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function floatToPcm16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function handleTranscriptionMessage(data) {
  try {
    const event = JSON.parse(data);
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      updateTranscriptionItem(event.item_id || "live", event.delta, false);
      if (state.recording) {
        const segment = currentSegment();
        segment.sourceText = replaceOrAppendTranscript(segment.sourceText, event.delta);
        touchSegment();
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      updateTranscriptionItem(event.item_id || crypto.randomUUID(), event.transcript, true);
      if (state.recording) {
        const segment = currentSegment();
        segment.sourceText = state.sourceText || event.transcript;
        touchSegment();
      }
      return;
    }
    if (event.type === "error") {
      showError(event.error?.message || "Realtime Whisper returned an error.");
    }
  } catch {
    showError("Unable to parse a realtime Whisper event.");
  }
}

function updateTranscriptionItem(itemId, text, replace) {
  if (!state.transcriptionItems.has(itemId)) {
    state.transcriptionItems.set(itemId, "");
    state.transcriptionOrder.push(itemId);
  }
  const current = state.transcriptionItems.get(itemId) || "";
  state.transcriptionItems.set(itemId, replace ? text : replaceOrAppendTranscript(current, text));
  state.sourceText = trimLiveText(state.transcriptionOrder.map((id) => state.transcriptionItems.get(id)).join(" "));
  if (!state.paused) renderCaptions();
}

function handleRealtimeMessage(data) {
  try {
    const event = JSON.parse(data);
    const sourceDelta = extractTranscriptText(event, "input");
    const translationDelta = extractTranscriptText(event, "output");
    if (sourceDelta && !state.transcriptionWs) {
      appendSource(sourceDelta);
    }
    if (translationDelta) {
      appendTranslation(toTraditionalChinese(translationDelta));
    }
    if (!sourceDelta && !translationDelta && event.type === "error") {
      showError(event.error?.message || "Realtime API returned an error.");
      setStatus("error");
    }
  } catch {
    showError("Unable to parse a realtime event.");
  }
}

function extractTranscriptText(event, direction) {
  if (!event?.type) return "";
  const type = String(event.type);
  const isInput =
    type === "session.input_transcript.delta" ||
    type === "session.input_transcript.completed" ||
    type.includes("input_transcript") ||
    type.includes("input_audio_transcription");
  const isOutput =
    type === "session.output_transcript.delta" ||
    type === "session.output_transcript.completed" ||
    type.includes("output_transcript") ||
    type.includes("output_audio_transcript");

  if ((direction === "input" && !isInput) || (direction === "output" && !isOutput)) return "";
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.transcript === "string") return event.transcript;
  if (typeof event.item?.transcript === "string") return event.item.transcript;
  if (typeof event.content?.transcript === "string") return event.content.transcript;
  return "";
}

function replaceOrAppendTranscript(currentText, incomingText) {
  if (!currentText) return incomingText;
  if (!incomingText) return currentText;
  const trimmed = currentText.trim();
  if (incomingText.length > trimmed.length && incomingText.startsWith(trimmed)) return incomingText;
  if (currentText.endsWith(incomingText)) return currentText;
  return currentText + incomingText;
}

function appendSource(delta) {
  if (!state.paused) {
    state.sourceText = trimLiveText(replaceOrAppendTranscript(state.sourceText, delta));
    renderCaptions();
  }
  if (state.recording) {
    const segment = currentSegment();
    segment.sourceText = replaceOrAppendTranscript(segment.sourceText, delta);
    touchSegment();
  }
}

function appendTranslation(delta) {
  if (!state.paused) {
    state.translatedText = trimLiveText(replaceOrAppendTranscript(state.translatedText, delta));
    renderCaptions();
  }
  if (state.recording) {
    const segment = currentSegment();
    segment.translatedText = replaceOrAppendTranscript(segment.translatedText, delta);
    touchSegment();
  }
}

function currentSegment() {
  if (!state.currentSegment) {
    const now = performance.now() - state.sessionStartedAt;
    state.currentSegment = {
      id: crypto.randomUUID(),
      index: state.nextSegmentIndex++,
      startedAtMs: Math.max(0, now),
      endedAtMs: Math.max(0, now + 800),
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      sourceText: "",
      translatedText: "",
      status: "streaming",
    };
    state.segments.push(state.currentSegment);
  }
  return state.currentSegment;
}

function touchSegment() {
  const segment = state.currentSegment;
  if (!segment) return;
  const now = performance.now() - state.sessionStartedAt;
  segment.endedAtMs = Math.max(segment.startedAtMs + 800, now);
  renderTranscript();

  if (state.idleTimer) window.clearTimeout(state.idleTimer);
  state.idleTimer = window.setTimeout(closeCurrentSegment, 2500);

  const source = segment.sourceText.trim();
  const translated = segment.translatedText.trim();
  if (
    (source.length > 220 && translated.length > 80) ||
    (/[.!?。！？]\s*$/.test(source) && /[.!?。！？]\s*$/.test(translated))
  ) {
    closeCurrentSegment();
  }
}

function closeCurrentSegment() {
  if (state.idleTimer) {
    window.clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  const segment = state.currentSegment;
  if (!segment) return;
  segment.sourceText = normalizeTranscriptText(segment.sourceText);
  segment.translatedText = normalizeTranscriptText(segment.translatedText);
  if (!segment.sourceText && !segment.translatedText) {
    state.segments = state.segments.filter((item) => item.id !== segment.id);
  } else {
    segment.status = "closed";
    segment.endedAtMs = Math.max(segment.endedAtMs, segment.startedAtMs + 800);
  }
  state.currentSegment = null;
  render();
}

function clearCaptions() {
  state.sourceText = "";
  state.translatedText = "";
  renderCaptions();
}

function clearTranscript() {
  if (state.segments.length === 0) return;
  if (!window.confirm("確定要清除目前逐字稿嗎？這個動作無法復原。")) return;
  state.segments = [];
  state.currentSegment = null;
  state.nextSegmentIndex = 1;
  render();
}

function exportTranscript(format) {
  if (!format || state.segments.length === 0) return;
  closeCurrentSegment();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (format === "md") downloadFile(`keynote-transcript-${stamp}.md`, exportMarkdown(state.segments), "text/markdown;charset=utf-8");
  if (format === "txt") downloadFile(`keynote-transcript-${stamp}.txt`, exportText(state.segments));
  if (format === "json") downloadFile(`keynote-transcript-${stamp}.json`, exportJson(state.segments), "application/json;charset=utf-8");
  if (format === "srt-zh") downloadFile(`keynote-subtitles-zh-TW-${stamp}.srt`, exportSrt(state.segments, "zh-TW"));
  if (format === "srt-en") downloadFile(`keynote-subtitles-en-${stamp}.srt`, exportSrt(state.segments, "en"));
  if (format === "srt-bilingual") {
    downloadFile(`keynote-subtitles-bilingual-${stamp}.srt`, exportSrt(state.segments, "bilingual"));
  }
}

function exportText(segments) {
  return segments
    .filter(hasContent)
    .map((segment) => `[${formatClock(segment.startedAtMs)} - ${formatClock(segment.endedAtMs)}]\nEN ${segment.sourceText}\nZH ${segment.translatedText}`)
    .join("\n\n");
}

function exportMarkdown(segments) {
  return [
    "# Keynote Transcript",
    "",
    ...segments.filter(hasContent).flatMap((segment) => [
      `## ${formatClock(segment.startedAtMs)} -> ${formatClock(segment.endedAtMs)}`,
      "",
      "**EN**",
      "",
      segment.sourceText || "_(empty)_",
      "",
      "**繁中**",
      "",
      segment.translatedText || "_(empty)_",
      "",
    ]),
  ].join("\n");
}

function exportJson(segments) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), segments: segments.filter(hasContent) }, null, 2);
}

function exportSrt(segments, mode) {
  return segments
    .filter(hasContent)
    .map((segment, index) => {
      const body = srtBody(segment, mode);
      return `${index + 1}\n${formatSrtTime(segment.startedAtMs)} --> ${formatSrtTime(segment.endedAtMs)}\n${body}`;
    })
    .join("\n\n");
}

function srtBody(segment, mode) {
  if (mode === "en") return wrapLines(segment.sourceText, 42);
  if (mode === "zh-TW") return wrapLines(segment.translatedText, 24);
  return [wrapLines(segment.sourceText, 42), wrapLines(segment.translatedText, 24)].filter(Boolean).join("\n");
}

function downloadFile(filename, contents, type = "text/plain;charset=utf-8") {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function render() {
  renderStatus();
  renderCaptions();
  renderTranscript();
  els.recordBtn.classList.toggle("active", state.recording);
  els.pauseBtn.classList.toggle("active", state.paused);
  els.audioBtn.classList.toggle("active", state.playAudio);
  els.clearKeyBtn.disabled = !state.hasApiKey || state.status === "live";
  els.startBtn.disabled = !state.hasApiKey || ["live", "creating-token", "connecting", "requesting-microphone"].includes(state.status);
  els.stopBtn.disabled = !["live", "creating-token", "connecting", "requesting-microphone"].includes(state.status);
  els.captionModeSelect.disabled = !["idle", "stopped", "error"].includes(state.status);
  els.openKeyBtn.textContent = state.hasApiKey ? "更換金鑰" : "輸入金鑰";
}

function renderStatus() {
  els.statusDot.className = `status-dot status-${state.status}`;
  els.statusLine.textContent = `${statusLabel(state.status)} · Key ${state.hasApiKey ? "Ready" : "Missing"} · ${state.segments.length} segments`;
}

function renderCaptions() {
  els.sourceCaption.innerHTML = "";
  els.translatedCaption.innerHTML = "";
  els.sourceCaption.append(state.sourceText || placeholder("等待語音輸入..."));
  els.translatedCaption.append(state.translatedText || placeholder("等待翻譯..."));
  scrollCaptionToBottom(els.sourceCaption);
  scrollCaptionToBottom(els.translatedCaption);
}

function renderTranscript() {
  els.transcriptScroll.innerHTML = "";
  if (state.segments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder compact";
    empty.textContent = "逐字稿會在開始 Record 後出現在這裡。";
    els.transcriptScroll.append(empty);
    renderStatus();
    return;
  }
  for (const segment of state.segments) {
    const article = document.createElement("article");
    article.className = segment.status === "streaming" ? "segment streaming" : "segment";
    article.innerHTML = `<time>${formatClock(segment.startedAtMs)} → ${formatClock(segment.endedAtMs)}</time>`;
    const source = document.createElement("p");
    source.innerHTML = "<strong>EN</strong> ";
    source.append(segment.sourceText);
    const translated = document.createElement("p");
    translated.innerHTML = "<strong>ZH</strong> ";
    translated.append(segment.translatedText);
    article.append(source, translated);
    els.transcriptScroll.append(article);
  }
  els.transcriptScroll.scrollTop = els.transcriptScroll.scrollHeight;
  renderStatus();
}

function applyLayoutSettings() {
  els.captionLayout.dataset.mode = state.captionMode;
  els.captionLayout.style.gridTemplateRows =
    state.captionMode === "bilingual" ? `${state.splitRatio}fr auto ${1 - state.splitRatio}fr` : "1fr";
  els.sourceCaption.style.fontSize = `clamp(24px, ${state.sourceFontSize}px, 11vw)`;
  els.translatedCaption.style.fontSize = `clamp(28px, ${state.translatedFontSize}px, 12vw)`;
}

function scrollCaptionToBottom(element) {
  window.requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function setStatus(status) {
  state.status = status;
  render();
}

function showKeyModal(open) {
  els.keyModal.hidden = !open;
  if (open) els.apiKeyInput.focus();
  showKeyError("");
}

function showKeyError(message) {
  els.keyError.textContent = message;
  els.keyError.hidden = !message;
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.classList.remove("info-banner");
  els.errorBanner.hidden = false;
}

function showInfo(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.classList.add("info-banner");
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.textContent = "";
  els.errorBanner.classList.remove("info-banner");
  els.errorBanner.hidden = true;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

function placeholder(text) {
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = text;
  return span;
}

function hasContent(segment) {
  return Boolean(segment.sourceText.trim() || segment.translatedText.trim());
}

function normalizeTranscriptText(text) {
  return toTraditionalChinese(text).replace(/\s+/g, " ").replace(/\s+([,.!?;:，。！？；：])/g, "$1").trim();
}

function trimLiveText(text) {
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length > 1800 ? normalized.slice(-1800) : normalized;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSrtTime(ms) {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function wrapLines(text, limit) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const tokens = /[\u3400-\u9fff]/.test(trimmed) ? Array.from(trimmed) : trimmed.split(/(\s+)/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const token of tokens) {
    if ((current + token).length > limit && current) {
      lines.push(current.trim());
      current = token;
    } else {
      current += token;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n");
}

function toTraditionalChinese(text) {
  let converted = state.traditionalConverter ? state.traditionalConverter(text) : text;
  const phraseMap = {
    软件: "軟體",
    硬件: "硬體",
    智能: "智慧",
    实时: "即時",
    语音: "語音",
    翻译: "翻譯",
    对话: "對話",
    记录: "記錄",
    会议: "會議",
    处理: "處理",
    连接: "連線",
    用户: "使用者",
    体验: "體驗",
    改变: "改變",
    应用: "應用",
    开发: "開發",
    支持: "支援",
    商业: "商業",
    其实: "其實",
    紧密: "緊密",
    相关: "相關",
    台湾: "台灣",
    将增长: "將增長",
    不可思议: "不可思議",
    我们: "我們",
    你们: "你們",
    这里: "這裡",
    那里: "那裡",
    生成式: "生成式",
    人工智能: "人工智慧",
    机器学习: "機器學習",
    云端: "雲端",
    数据: "資料",
    网络: "網路",
    默认: "預設",
    麦克风: "麥克風",
    屏幕: "螢幕",
    视频: "影片",
    音频: "音訊",
    字幕: "字幕",
    逐字稿: "逐字稿",
    实作: "實作",
    界面: "介面",
  };
  const charMap = {
    后: "後",
    里: "裡",
    并: "並",
    与: "與",
    为: "為",
    于: "於",
    个: "個",
    们: "們",
    说: "說",
    请: "請",
    谢: "謝",
    讲: "講",
    语: "語",
    译: "譯",
    话: "話",
    词: "詞",
    证: "證",
    识: "識",
    论: "論",
    议: "議",
    讯: "訊",
    让: "讓",
    该: "該",
    详: "詳",
    误: "誤",
    读: "讀",
    现: "現",
    录: "錄",
    实: "實",
    时: "時",
    历: "歷",
    业: "業",
    产: "產",
    杂: "雜",
    体: "體",
    会: "會",
    对: "對",
    处: "處",
    连: "連",
    线: "線",
    软: "軟",
    硬: "硬",
    开: "開",
    发: "發",
    变: "變",
    应: "應",
    湾: "灣",
    紧: "緊",
    关: "關",
    将: "將",
    长: "長",
    议: "議",
    从: "從",
    来: "來",
    这: "這",
    两: "兩",
    么: "麼",
    数: "數",
    据: "據",
    网: "網",
    络: "絡",
    云: "雲",
    计: "計",
    优: "優",
    问: "問",
    题: "題",
    决: "決",
    况: "況",
    状: "狀",
    态: "態",
    动: "動",
    过: "過",
    标: "標",
    资: "資",
    类: "類",
    项: "項",
    页: "頁",
    区: "區",
    块: "塊",
    划: "劃",
    设: "設",
    导: "導",
    观: "觀",
    众: "眾",
    听: "聽",
    麦: "麥",
    风: "風",
    声: "聲",
    频: "頻",
    屏: "螢",
    码: "碼",
    际: "際",
    国: "國",
    电: "電",
    脑: "腦",
    机: "機",
    学: "學",
    习: "習",
    认: "認",
    样: "樣",
    级: "級",
    总: "總",
    结: "結",
    构: "構",
    选: "選",
    择: "擇",
    输: "輸",
    删: "刪",
    简: "簡",
    转: "轉",
    换: "換",
    医: "醫",
    疗: "療",
    财: "財",
    务: "務",
    营: "營",
    销: "銷",
    键: "鍵",
    钥: "鑰",
    须: "須",
    顶: "頂",
    滚: "滾",
    权: "權",
    预: "預",
    测: "測",
    试: "試",
    验: "驗",
    错: "錯",
    丢: "丟",
    别: "別",
    额: "額",
    场: "場",
    战: "戰",
    专: "專",
    门: "門",
    约: "約",
    归: "歸",
    纳: "納",
    继: "繼",
    续: "續",
    显: "顯",
    隐: "隱",
    调: "調",
    杆: "桿",
    载: "載",
    启: "啟",
    闭: "閉",
    释: "釋",
  };
  for (const [from, to] of Object.entries(phraseMap)) {
    converted = converted.replaceAll(from, to);
  }
  return Array.from(converted)
    .map((char) => charMap[char] || char)
    .join("");
}

function statusLabel(status) {
  return {
    idle: "Idle",
    "requesting-microphone": "Requesting mic",
    "creating-token": "Creating token",
    connecting: "Connecting",
    live: "Live",
    stopping: "Stopping",
    stopped: "Stopped",
    error: "Error",
  }[status];
}

function byId(id) {
  return document.getElementById(id);
}

function readNumber(key, fallback) {
  const stored = window.localStorage.getItem(`keynote:${key}`);
  return stored ? Number(stored) || fallback : fallback;
}

function writeNumber(key, value) {
  window.localStorage.setItem(`keynote:${key}`, String(value));
}
