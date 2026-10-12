// Session controller: owns the microphone and the Realtime connections for one live run.
// - Start acquires the mic and client secrets in parallel, then connects both tracks in parallel.
// - Stop (also during startup) cancels the run; nothing started afterwards survives.
// - Each connection reconnects on its own with backoff, and is rotated before the 60-minute
//   Realtime session limit without dropping audio.
// - gpt-live-transcribe has no server VAD, so speech turns are committed from a client-side VAD.

import * as defaultApi from "./api.js";
import { AudioInput, CHUNK_MS } from "./audio.js";
import { TranscribeClient, TranslateClient, delay as defaultDelay } from "./realtime.js";
import { VoiceActivityDetector } from "./vad.js";

const ROTATE_AFTER_MS = 55 * 60 * 1000;
const ROTATE_RETRY_MS = 60 * 1000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_TURN_MS = 15_000;
const FORCE_COMMIT_MS = 25_000;
const QUIET_COMMIT_MS = 1_500;
const STREAM_IDLE_SEAL_MS = 2_500;
const SILENCE_WARNING_MS = 20_000;
const AUDIO_BACKLOG_CHUNKS = Math.round(20_000 / CHUNK_MS);
const SOURCE_STREAM_LATENCY_MS = 600;
const ERROR_REPEAT_MS = 15_000;
const TICK_MS = 500;

const LABELS = { translate: "翻譯", transcribe: "轉錄" };

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export class SessionController {
  // `deps` lets tests replace the network, microphone and timers.
  constructor({ store, liveSource, liveTranslation, isRecording, languageInfo, onChange, onCaptions, onNotice, onLevel }, deps = {}) {
    this.api = deps.api ?? defaultApi;
    this.AudioInput = deps.AudioInput ?? AudioInput;
    this.TranslateClient = deps.TranslateClient ?? TranslateClient;
    this.TranscribeClient = deps.TranscribeClient ?? TranscribeClient;
    this.delay = deps.delay ?? defaultDelay;
    this.store = store;
    this.liveSource = liveSource;
    this.liveTranslation = liveTranslation;
    this.isRecording = isRecording;
    this.languageInfo = languageInfo;
    this.onChange = onChange;
    this.onCaptions = onCaptions;
    this.onNotice = onNotice;
    this.onLevel = onLevel;
    this.status = "idle";
    this.step = "";
    this.run = null;
    this.connections = { transcribe: "off", translate: "off" };
    this.lastErrors = new Map();
  }

  get liveSince() {
    return this.run?.liveSince ?? null;
  }

  setStatus(status, step = "") {
    this.status = status;
    this.step = step;
    this.onChange();
  }

  setConnection(name, state) {
    this.connections[name] = state;
    this.onChange();
  }

  check(run) {
    if (run.cancelled) throw new Cancelled();
  }

  rel(perf) {
    return this.store.relative(perf);
  }

  record(fn) {
    if (!this.isRecording()) return;
    this.store.ensureEpoch(performance.now());
    fn();
  }

  async start(options) {
    if (this.status !== "idle") return;
    const needTranslate = options.mode !== "source";
    const needTranscribe = options.mode === "source" || (options.mode === "bilingual" && options.bilingualEngine === "dual");
    const run = {
      options,
      needTranslate,
      needTranscribe,
      sourceFromTranslate: needTranslate && !needTranscribe,
      cancelled: false,
      audio: null,
      translate: null,
      transcribe: null,
      nextTranscribe: null,
      vad: new VoiceActivityDetector(),
      turn: null,
      lastCommitEnd: null,
      deltaSinceCommit: false,
      lastDeltaAt: 0,
      itemStarts: new Map(),
      itemEnds: new Map(),
      streamTouched: new Map(),
      pendingAudio: [],
      lastVoiceAt: performance.now(),
      silenceWarned: false,
      tick: null,
      liveSince: null,
      reconnecting: { translate: false, transcribe: false },
      rotating: { translate: false, transcribe: false },
      nextRotation: { translate: Infinity, transcribe: Infinity },
    };
    this.run = run;
    this.connections = { transcribe: needTranscribe ? "connecting" : "off", translate: needTranslate ? "connecting" : "off" };
    this.liveSource.clear();
    this.liveTranslation.clear();
    this.onCaptions();
    this.setStatus("starting", "取得麥克風與連線權杖");

    try {
      run.audio = new this.AudioInput({
        onChunk: (pcm, rms, peak, at) => this.handleAudio(run, pcm, rms, peak, at),
        onEnded: () => this.handleMicEnded(run),
      });
      const [, translateSecret, transcribeSecret] = await Promise.all([
        run.audio.open({ deviceId: options.deviceId, processing: options.micProcessing }),
        needTranslate ? this.api.createTranslationSecret(translationParams(options)) : null,
        needTranscribe ? this.api.createTranscriptionSecret(transcriptionParams(options)) : null,
      ]);
      this.check(run);
      this.setStatus("starting", "連線到 OpenAI");
      await Promise.all([
        needTranscribe ? this.attachTranscribe(run, transcribeSecret) : null,
        needTranslate ? this.attachTranslate(run, translateSecret) : null,
      ]);
      this.check(run);
      if (this.isRecording()) this.store.ensureEpoch(performance.now());
      run.liveSince = performance.now();
      run.tick = setInterval(() => this.tick(run), TICK_MS);
      this.setStatus("live");
    } catch (error) {
      await this.teardown(run, false);
      if (run.cancelled) return;
      this.run = null;
      this.connections = { transcribe: "off", translate: "off" };
      this.setStatus("idle");
      throw error;
    }
  }

  async stop() {
    const run = this.run;
    if (!run || this.status === "stopping") return;
    const graceful = this.status === "live";
    run.cancelled = true;
    this.setStatus("stopping", graceful ? "等待最後一句完成" : "");
    if (graceful && run.needTranscribe && (run.turn || run.deltaSinceCommit)) {
      const now = performance.now();
      run.transcribe?.commit({ startPerf: run.turn?.startPerf ?? run.lastCommitEnd ?? now - 2000, endPerf: now });
    }
    await this.teardown(run, graceful);
    this.store.sealAll();
    this.run = null;
    this.connections = { transcribe: "off", translate: "off" };
    this.setStatus("idle");
  }

  async teardown(run, graceful) {
    clearInterval(run.tick);
    run.tick = null;
    run.audio?.close();
    await Promise.all(
      [run.translate, run.transcribe, run.nextTranscribe].map((client) => client?.close({ graceful }).catch(() => {})),
    );
  }

  // Ends the current paragraph: commits the speech turn and closes open sentences.
  markParagraph() {
    const run = this.run;
    if (run && this.status === "live" && run.needTranscribe && (run.turn || run.deltaSinceCommit)) {
      this.commitTurn(run, performance.now());
    }
    this.store.sealStream("translation");
    this.store.sealStream("source");
  }

  setPlayAudio(play) {
    this.run?.translate?.setPlayAudio(play);
  }

  // ---- connections -------------------------------------------------------------------------

  createTranslateClient(run) {
    const client = new this.TranslateClient({
      track: run.audio.track,
      playAudio: run.options.playAudio,
      onEvent: (event) => this.handleTranslateEvent(run, event),
      onState: (state, message) => {
        if (run !== this.run || run.cancelled || client !== run.translate) return;
        if (state === "interrupted") this.setConnection("translate", "reconnecting");
        else if (state === "live") this.setConnection("translate", "live");
        else if (state === "failed") this.reconnect(run, "translate", message);
      },
    });
    return client;
  }

  createTranscribeClient(run) {
    const client = new this.TranscribeClient({
      onEvent: (event) => this.handleTranscribeEvent(run, event),
      onState: (state, message) => {
        if (run !== this.run || run.cancelled || client !== run.transcribe) return;
        if (state === "failed") this.reconnect(run, "transcribe", message);
      },
    });
    return client;
  }

  async attachTranslate(run, secret) {
    this.check(run);
    const client = this.createTranslateClient(run);
    run.translate = client;
    this.setConnection("translate", "connecting");
    try {
      await client.connect(secret);
      this.check(run);
    } catch (error) {
      client.close({ graceful: false });
      if (run.translate === client) run.translate = null;
      throw error;
    }
    this.setConnection("translate", "live");
    run.nextRotation.translate = performance.now() + ROTATE_AFTER_MS;
  }

  async attachTranscribe(run, secret) {
    this.check(run);
    const client = this.createTranscribeClient(run);
    run.transcribe = client;
    this.setConnection("transcribe", "connecting");
    try {
      await client.connect(secret);
      this.check(run);
    } catch (error) {
      client.close({ graceful: false });
      if (run.transcribe === client) run.transcribe = null;
      throw error;
    }
    // Audio captured while connecting is replayed so the first words aren't lost.
    for (const chunk of run.pendingAudio.splice(0)) client.append(chunk);
    this.setConnection("transcribe", "live");
    run.nextRotation.transcribe = performance.now() + ROTATE_AFTER_MS;
  }

  async reconnect(run, name, reason) {
    if (run.reconnecting[name] || run.cancelled) return;
    run.reconnecting[name] = true;
    const previous = run[name];
    run[name] = null;
    previous?.close({ graceful: false });
    if (name === "transcribe" && run.nextTranscribe) {
      run.nextTranscribe.close({ graceful: false });
      run.nextTranscribe = null;
    }
    this.setConnection(name, "reconnecting");
    this.onNotice("warning", `${LABELS[name]}連線中斷，正在自動重新連線…${reason ? `（${reason}）` : ""}`);
    for (let attempt = 0; !run.cancelled; attempt += 1) {
      try {
        if (name === "translate") await this.attachTranslate(run, await this.api.createTranslationSecret(translationParams(run.options)));
        else await this.attachTranscribe(run, await this.api.createTranscriptionSecret(transcriptionParams(run.options)));
        this.onNotice("success", `${LABELS[name]}連線已恢復。`);
        break;
      } catch (error) {
        if (run.cancelled || error instanceof Cancelled) break;
        this.setConnection(name, "reconnecting");
        await this.delay(RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]);
      }
    }
    run.reconnecting[name] = false;
  }

  // Realtime sessions end after 60 minutes. A fresh translation session is connected with its audio
  // muted, then audio switches over and the old session drains its last sentence.
  async rotateTranslate(run) {
    run.rotating.translate = true;
    try {
      const secret = await this.api.createTranslationSecret(translationParams(run.options));
      this.check(run);
      const next = this.createTranslateClient(run);
      try {
        await next.connect(secret, { audioEnabled: false });
        this.check(run);
      } catch (error) {
        next.close({ graceful: false });
        throw error;
      }
      const previous = run.translate;
      if (!previous || run.reconnecting.translate) {
        next.close({ graceful: false });
        return;
      }
      await next.setAudioEnabled(true);
      run.translate = next;
      previous.close({ graceful: true });
      run.nextRotation.translate = performance.now() + ROTATE_AFTER_MS;
    } catch (error) {
      if (!(error instanceof Cancelled)) run.nextRotation.translate = performance.now() + ROTATE_RETRY_MS;
    } finally {
      run.rotating.translate = false;
    }
  }

  // The transcription connection is swapped at a turn boundary, after a commit.
  async rotateTranscribe(run) {
    run.rotating.transcribe = true;
    try {
      const secret = await this.api.createTranscriptionSecret(transcriptionParams(run.options));
      this.check(run);
      const next = this.createTranscribeClient(run);
      try {
        await next.connect(secret);
        this.check(run);
      } catch (error) {
        next.close({ graceful: false });
        throw error;
      }
      if (!run.transcribe || run.reconnecting.transcribe) {
        next.close({ graceful: false });
        return;
      }
      run.nextTranscribe = next;
      if (!run.turn && !run.deltaSinceCommit) this.switchTranscribe(run);
    } catch (error) {
      if (!(error instanceof Cancelled)) run.nextRotation.transcribe = performance.now() + ROTATE_RETRY_MS;
    } finally {
      run.rotating.transcribe = false;
    }
  }

  switchTranscribe(run) {
    const next = run.nextTranscribe;
    if (!next) return;
    run.nextTranscribe = null;
    const previous = run.transcribe;
    run.transcribe = next;
    run.nextRotation.transcribe = performance.now() + ROTATE_AFTER_MS;
    previous?.close({ graceful: true });
  }

  // ---- audio and turns ----------------------------------------------------------------------

  handleAudio(run, pcm, rms, peak, at) {
    if (run !== this.run || run.cancelled) return;
    this.onLevel(rms, peak);
    const event = run.vad.update(rms, at, CHUNK_MS);
    if (event?.type === "speech-start") run.turn = { startPerf: event.atMs };
    if (run.vad.speaking) {
      run.lastVoiceAt = at;
      if (run.silenceWarned) {
        run.silenceWarned = false;
        this.onNotice("silence-cleared", "");
      }
    }
    if (!run.needTranscribe) return;

    const client = run.transcribe;
    if (client?.isOpen && !run.reconnecting.transcribe) {
      client.append(pcm);
    } else {
      run.pendingAudio.push(pcm);
      if (run.pendingAudio.length > AUDIO_BACKLOG_CHUNKS) run.pendingAudio.shift();
    }

    if (event?.type === "speech-end") {
      this.commitTurn(run, event.atMs);
    } else if (run.turn && at - run.turn.startPerf >= MAX_TURN_MS && run.vad.silenceMs(at) >= 200) {
      this.commitTurn(run, at);
    } else if (run.turn && at - run.turn.startPerf >= FORCE_COMMIT_MS) {
      this.commitTurn(run, at);
    } else if (!run.turn && run.deltaSinceCommit && at - run.lastDeltaAt >= QUIET_COMMIT_MS) {
      // The model heard speech the VAD missed (quiet speaker): still finish the turn.
      this.commitTurn(run, at);
    }
  }

  commitTurn(run, endPerf) {
    const startPerf = run.turn?.startPerf ?? run.lastCommitEnd ?? endPerf - 2000;
    run.turn = run.vad.speaking ? { startPerf: endPerf } : null;
    run.deltaSinceCommit = false;
    run.lastCommitEnd = endPerf;
    run.transcribe?.commit({ startPerf, endPerf });
    if (run.nextTranscribe) this.switchTranscribe(run);
  }

  handleMicEnded(run) {
    if (run !== this.run || run.cancelled) return;
    this.onNotice("error", "麥克風訊號中斷（可能被拔除或被其他 App 佔用），已停止。");
    this.stop();
  }

  // ---- realtime events ----------------------------------------------------------------------

  handleTranscribeEvent(run, event) {
    if (run !== this.run) return;
    const language = run.options.sourceLanguage;
    switch (event.type) {
      case "delta": {
        run.deltaSinceCommit = true;
        run.lastDeltaAt = performance.now();
        if (!run.itemStarts.has(event.itemId)) run.itemStarts.set(event.itemId, run.turn?.startPerf ?? performance.now() - 1500);
        this.liveSource.appendItem(event.itemId, event.delta);
        this.record(() =>
          this.store.upsertItem(event.itemId, {
            track: "source",
            language,
            startMs: this.rel(run.itemStarts.get(event.itemId)),
            delta: event.delta,
          }),
        );
        this.onCaptions();
        break;
      }
      case "committed": {
        if (!event.itemId || !event.turn) break;
        const start = event.turn.startPerf;
        run.itemStarts.set(event.itemId, start);
        run.itemEnds.set(event.itemId, event.turn.endPerf);
        if (this.store.byItem.has(event.itemId)) {
          this.record(() => this.store.upsertItem(event.itemId, { startMs: this.rel(start), endMs: this.rel(event.turn.endPerf) }));
        }
        break;
      }
      case "completed": {
        const start = run.itemStarts.get(event.itemId) ?? performance.now() - 2000;
        const end = run.itemEnds.get(event.itemId) ?? performance.now() - 800;
        this.liveSource.setItem(event.itemId, event.transcript);
        this.record(() =>
          this.store.upsertItem(event.itemId, {
            track: "source",
            language,
            startMs: this.rel(start),
            endMs: this.rel(Math.max(end, start + 300)),
            transcript: event.transcript,
          }),
        );
        run.itemStarts.delete(event.itemId);
        run.itemEnds.delete(event.itemId);
        this.onCaptions();
        break;
      }
      case "item-failed":
        this.reportError("transcribe", event.error?.message || "有一段語音轉錄失敗。");
        break;
      case "error":
        this.handleApiError(run, "transcribe", event.error);
        break;
      default:
        break;
    }
  }

  handleTranslateEvent(run, event) {
    if (run !== this.run) return;
    const now = performance.now();
    if (event.type === "output-delta") {
      const language = run.options.targetLanguage;
      this.liveTranslation.append(event.delta);
      run.streamTouched.set("translation", now);
      this.record(() =>
        this.store.appendStream("translation", {
          track: "translation",
          language,
          delta: event.delta,
          atMs: this.rel(now - run.options.translationLatencyMs),
          cjk: this.languageInfo(language).cjk,
        }),
      );
      this.onCaptions();
    } else if (event.type === "input-delta" && run.sourceFromTranslate) {
      const language = run.options.sourceLanguage;
      this.liveSource.append(event.delta);
      run.streamTouched.set("source", now);
      this.record(() =>
        this.store.appendStream("source", {
          track: "source",
          language,
          delta: event.delta,
          atMs: this.rel(now - SOURCE_STREAM_LATENCY_MS),
          cjk: this.languageInfo(language).cjk,
        }),
      );
      this.onCaptions();
    } else if (event.type === "error") {
      this.handleApiError(run, "translate", event.error);
    }
  }

  handleApiError(run, name, error) {
    if (error?.code === "session_expired") {
      this.reconnect(run, name, "連線已達時間上限");
      return;
    }
    this.reportError(name, error?.message || "OpenAI 回傳錯誤。");
  }

  reportError(name, message) {
    const key = `${name}:${message}`;
    const now = performance.now();
    if (now - (this.lastErrors.get(key) ?? -Infinity) < ERROR_REPEAT_MS) return;
    this.lastErrors.set(key, now);
    this.onNotice("error", `${LABELS[name]}：${message}`);
  }

  tick(run) {
    if (run !== this.run || run.cancelled) return;
    const now = performance.now();
    for (const [key, touched] of run.streamTouched) {
      if (now - touched >= STREAM_IDLE_SEAL_MS) {
        run.streamTouched.delete(key);
        this.store.sealStream(key);
      }
    }
    if (run.translate && !run.reconnecting.translate && !run.rotating.translate && now >= run.nextRotation.translate) {
      this.rotateTranslate(run);
    }
    if (run.transcribe && !run.nextTranscribe && !run.reconnecting.transcribe && !run.rotating.transcribe && now >= run.nextRotation.transcribe) {
      this.rotateTranscribe(run);
    }
    if (!run.silenceWarned && now - run.lastVoiceAt >= SILENCE_WARNING_MS) {
      run.silenceWarned = true;
      this.onNotice("silence", "已經 20 秒沒有偵測到聲音，請確認麥克風選擇與音量。");
    }
  }
}

function translationParams(options) {
  return { targetLanguage: options.targetLanguage, noiseReduction: options.noiseReduction };
}

function transcriptionParams(options) {
  return {
    sourceLanguage: options.sourceLanguage,
    delay: options.transcriptionDelay,
    prompt: options.prompt,
    keywords: options.keywords,
    noiseReduction: options.noiseReduction,
  };
}
