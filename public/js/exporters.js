// Transcript exporters (Markdown, text, JSON, SRT). Pure functions: callers pass the language helpers.
//   options.display(text, language) → display text (Chinese conversion)
//   options.languageInfo(code)      → { label, short, cjk }

import { chunkText, formatClock, formatSrtTime, joinText, normalizeTranscriptText, wrapLines } from "./text.js";

const SRT_MAX_CUE_MS = 7000;
const SRT_MIN_CUE_MS = 700;
const ALIGN_MAX_GAP_MS = 3000;
const ALIGN_TAIL_MS = 800;

export function lineLimit(info) {
  return info.cjk ? 18 : 42;
}

// Pairs each translated sentence with the source utterance it overlaps most (or the nearest one
// within ALIGN_MAX_GAP_MS). Translations that match nothing become their own group.
export function alignGroups(sourceEntries, translationEntries) {
  const groups = [...sourceEntries]
    .sort((a, b) => a.startMs - b.startMs)
    .map((entry) => ({ startMs: entry.startMs, endMs: entry.endMs, source: [entry], translation: [] }));
  const standalone = [];
  let low = 0;
  for (const entry of [...translationEntries].sort((a, b) => a.startMs - b.startMs)) {
    while (low < groups.length && groups[low].source[0].endMs + ALIGN_TAIL_MS + ALIGN_MAX_GAP_MS < entry.startMs) low += 1;
    let best = null;
    let bestScore = -Infinity;
    let bestDistance = Infinity;
    for (let index = low; index < groups.length; index += 1) {
      const group = groups[index];
      const source = group.source[0];
      if (source.startMs > entry.endMs + ALIGN_MAX_GAP_MS) break;
      // Overlap in ms (negative = gap). Ties go to the utterance that started closest to the translation.
      const score = Math.min(source.endMs, entry.endMs) - Math.max(source.startMs, entry.startMs);
      const distance = Math.abs(source.startMs - entry.startMs);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        bestScore = score;
        bestDistance = distance;
        best = group;
      }
    }
    if (best && bestScore > -ALIGN_MAX_GAP_MS) best.translation.push(entry);
    else standalone.push({ startMs: entry.startMs, endMs: entry.endMs, source: [], translation: [entry] });
  }
  return [...groups, ...standalone]
    .map((group) => {
      const members = [...group.source, ...group.translation];
      return {
        ...group,
        startMs: Math.min(...members.map((member) => member.startMs)),
        endMs: Math.max(...members.map((member) => member.endMs)),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

function groupText(entries, options) {
  if (entries.length === 0) return { text: "", language: "" };
  const language = entries[0].language;
  const info = options.languageInfo(language);
  const text = joinText(entries.map((entry) => normalizeTranscriptText(options.display(entry.text, entry.language))), info.cjk);
  return { text, language, info };
}

export function buildGroups(store) {
  return alignGroups(store.track("source"), store.track("translation"));
}

export function exportMarkdown(store, options) {
  const lines = ["# Keynote Transcript", ""];
  if (store.epochWall) lines.push(`- 開始時間：${new Date(store.epochWall).toLocaleString("zh-TW", { hour12: false })}`, "");
  for (const group of buildGroups(store)) {
    lines.push(`## ${formatClock(group.startMs)} – ${formatClock(group.endMs)}`, "");
    for (const part of [groupText(group.source, options), groupText(group.translation, options)]) {
      if (!part.text) continue;
      lines.push(`**${part.info.label}**`, "", part.text, "");
    }
  }
  return lines.join("\n");
}

export function exportText(store, options) {
  return (
    buildGroups(store)
      .map((group) => {
        const parts = [groupText(group.source, options), groupText(group.translation, options)]
          .filter((part) => part.text)
          .map((part) => `${part.info.short} ${part.text}`);
        return [`[${formatClock(group.startMs)} - ${formatClock(group.endMs)}]`, ...parts].join("\n");
      })
      .join("\n\n") + "\n"
  );
}

export function exportJson(store, options) {
  const data = store.toJSON();
  return JSON.stringify(
    {
      ...data,
      app: { name: "Keynote Live Translator", version: options.appVersion || "" },
      exportedAt: new Date().toISOString(),
      entries: data.entries.map((entry) => ({ ...entry, displayText: options.display(entry.text, entry.language) })),
      groups: buildGroups(store).map((group) => ({
        startMs: group.startMs,
        endMs: group.endMs,
        source: groupText(group.source, options).text,
        translation: groupText(group.translation, options).text,
      })),
    },
    null,
    2,
  );
}

// mode: "source" | "translation" | "bilingual"
export function exportSrt(store, mode, options) {
  const offsetMs = Number(options.offsetMs) || 0;
  let cues;
  if (mode === "bilingual") {
    cues = buildGroups(store).flatMap((group) => bilingualCues(group, options));
  } else {
    cues = store.track(mode).flatMap((entry) => trackCues(entry, options));
  }
  return formatCues(finalizeCues(cues, offsetMs));
}

function trackCues(entry, options) {
  const { text, info } = groupText([entry], options);
  if (!text) return [];
  const limit = lineLimit(info);
  const duration = Math.max(entry.endMs - entry.startMs, SRT_MIN_CUE_MS);
  const count = Math.max(Math.ceil(duration / SRT_MAX_CUE_MS), Math.ceil(wrapLines(text, limit, info.cjk).length / 2));
  return spreadOverTime(chunkText(text, count, info.cjk), entry.startMs, duration).map((piece) => ({
    startMs: piece.startMs,
    endMs: piece.endMs,
    lines: wrapLines(piece.text, limit, info.cjk),
  }));
}

function bilingualCues(group, options) {
  const source = groupText(group.source, options);
  const translation = groupText(group.translation, options);
  const duration = Math.max(group.endMs - group.startMs, SRT_MIN_CUE_MS);
  const linesOf = (part) => (part.text ? wrapLines(part.text, lineLimit(part.info), part.info.cjk).length : 0);
  const count = Math.max(Math.ceil(duration / SRT_MAX_CUE_MS), Math.ceil(linesOf(source) / 2), Math.ceil(linesOf(translation) / 2), 1);
  const sourceChunks = source.text ? chunkText(source.text, count, source.info.cjk) : Array(count).fill("");
  const translationChunks = translation.text ? chunkText(translation.text, count, translation.info.cjk) : Array(count).fill("");
  const step = duration / count;
  return Array.from({ length: count }, (_, index) => ({
    startMs: group.startMs + step * index,
    endMs: group.startMs + step * (index + 1),
    lines: [
      ...(source.text ? wrapLines(sourceChunks[index], lineLimit(source.info), source.info.cjk) : []),
      ...(translation.text ? wrapLines(translationChunks[index], lineLimit(translation.info), translation.info.cjk) : []),
    ],
  }));
}

function spreadOverTime(chunks, startMs, duration) {
  const pieces = chunks.filter((chunk) => chunk.trim());
  const total = pieces.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
  let cursor = startMs;
  return pieces.map((chunk) => {
    const length = (duration * chunk.length) / total;
    const piece = { text: chunk, startMs: cursor, endMs: cursor + length };
    cursor += length;
    return piece;
  });
}

function finalizeCues(cues, offsetMs) {
  const sorted = cues.filter((cue) => cue.lines.some((line) => line.trim())).sort((a, b) => a.startMs - b.startMs);
  for (let index = 0; index < sorted.length; index += 1) {
    const cue = sorted[index];
    cue.endMs = Math.max(cue.endMs, cue.startMs + SRT_MIN_CUE_MS);
    const next = sorted[index + 1];
    if (next && cue.endMs > next.startMs) cue.endMs = Math.max(cue.startMs + 200, next.startMs);
  }
  return sorted
    .map((cue) => ({ ...cue, startMs: cue.startMs + offsetMs, endMs: cue.endMs + offsetMs }))
    .filter((cue) => cue.endMs > 0)
    .map((cue) => ({ ...cue, startMs: Math.max(0, cue.startMs) }));
}

function formatCues(cues) {
  if (cues.length === 0) return "";
  return (
    cues
      .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.lines.join("\n")}`)
      .join("\n\n") + "\n"
  );
}
