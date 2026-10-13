// Text helpers shared by live captions, the transcript and exporters. No DOM access.

const CJK_CHAR = /[぀-ヿ㐀-鿿豈-﫿]/;
const SENTENCE_END = /[。！？!?]|\.(?=\s|$)|…(?=\s|$)/g;

export function isCjkText(text) {
  return CJK_CHAR.test(text);
}

export function normalizeSpaces(text) {
  return text.replace(/\s+/g, " ");
}

export function normalizeTranscriptText(text) {
  return normalizeSpaces(text)
    .replace(/\s+([,.!?;:，。！？；：、])/g, "$1")
    .replace(/([㐀-鿿぀-ヿ，。！？；：、])\s+(?=[㐀-鿿぀-ヿ])/g, "$1")
    .trim();
}

// Joins utterances: CJK languages don't use spaces between sentences.
export function joinText(parts, cjk) {
  const separator = cjk ? "" : " ";
  return normalizeSpaces(parts.filter(Boolean).map((part) => part.trim()).join(separator)).trim();
}

// Keeps the end of a long live caption. For space-separated languages the cut moves to a word boundary.
export function tailText(text, maxChars, cjk) {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  if (cjk) return tail;
  const space = tail.indexOf(" ");
  return space >= 0 && space < 40 ? tail.slice(space + 1) : tail;
}

// Half-width punctuation next to Chinese text, or ending it ("工具,能" from the translation model) →
// full-width.
// Numbers such as 3,000 and 3:00 are left alone.
export function fullwidthPunctuation(text) {
  return text.replace(/\s*([,;:?!])\s*/g, (match, mark, offset) => {
    const before = text[offset - 1] ?? "";
    const after = text[offset + match.length] ?? "";
    if (/[0-9]/.test(before) && /[0-9]/.test(after)) return match;
    if (!HAN.test(before) && !HAN.test(after) && !(after === "" && HAN.test(text))) return match;
    return FULLWIDTH[mark];
  });
}

const HAN = /\p{Script=Han}/u;
const FULLWIDTH = { ",": "，", ";": "；", ":": "：", "?": "？", "!": "！" };

// A caption line: the line break replaces a trailing comma.
export function captionText(text) {
  return text.trim().replace(/[，、；：\s]+$/u, "");
}

export function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

// Position just after the last *confirmed* sentence end. A terminator at the very end of the text is not
// confirmed yet ("3." may continue as "3.14"), so the caller waits for the next delta.
export function lastSentenceBoundary(text) {
  let boundary = -1;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end < text.length) boundary = end;
  }
  return boundary;
}

// Characters that must not start a line (CJK line-breaking rules).
const NO_LINE_START = /^[，。、；：！？）」』〉》】,.;:!?)\]…]$/;

export function wrapLines(text, limit, cjk) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const tokens = cjk ? Array.from(trimmed) : trimmed.split(/(\s+)/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const token of tokens) {
    if (current && (current + token).trim().length > limit && !NO_LINE_START.test(token)) {
      lines.push(current.trim());
      current = token.trimStart();
    } else {
      current += token;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

// Splits text into `count` pieces of similar length, preferring sentence, then clause, then word boundaries.
export function chunkText(text, count, cjk) {
  const trimmed = text.trim();
  if (count <= 1 || !trimmed) return [trimmed];
  const units = splitUnits(trimmed, cjk);
  if (units.length <= 1) return [trimmed, ...Array(count - 1).fill("")].slice(0, count);
  const total = units.reduce((sum, unit) => sum + unit.length, 0);
  const target = total / count;
  const chunks = [];
  let current = [];
  let currentLength = 0;
  units.forEach((unit, index) => {
    current.push(unit);
    currentLength += unit.length;
    const remainingUnits = units.length - index - 1;
    const remainingChunks = count - chunks.length - 1;
    if (remainingChunks > 0 && (currentLength >= target || remainingUnits === remainingChunks)) {
      chunks.push(joinText(current, cjk));
      current = [];
      currentLength = 0;
    }
  });
  if (current.length) chunks.push(joinText(current, cjk));
  while (chunks.length < count) chunks.push("");
  return chunks;
}

function splitUnits(text, cjk) {
  const sentences = splitSentences(text);
  if (sentences.length > 1) return sentences;
  const clauses = text.split(/(?<=[,，、;；:：])\s*/).filter(Boolean);
  if (clauses.length > 1) return clauses;
  return cjk ? Array.from(text) : text.split(/\s+/).filter(Boolean);
}

export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export function formatSrtTime(ms) {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}
