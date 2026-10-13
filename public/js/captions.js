// Live captions as lines. Each phrase of the live transcript (an entry, see transcript.js) is shown on
// its own line, split further at sentence ends; the newest line is at the bottom and older lines fade.
// Chinese is converted per phrase at render time, never per streaming delta.

import { splitSentences } from "./text.js";
import { displayText, zhConverterVersion } from "./zh.js";

export const CAPTION_LINES = 12;

const converted = new WeakMap();

function displayed(entry, display) {
  const version = zhConverterVersion();
  const cached = converted.get(entry);
  if (cached && cached.raw === entry.text && cached.display === display && cached.version === version) return cached.text;
  const text = display(entry.text, entry.language).trim();
  converted.set(entry, { raw: entry.text, display, version, text });
  return text;
}

// The newest `limit` lines of one track, oldest first. Entries before `from` (a sequence number,
// see TranscriptStore) were cleared from the screen.
export function captionLines(store, track, { from = 0, limit = CAPTION_LINES, display = displayText } = {}) {
  const lines = [];
  for (let index = store.entries.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const entry = store.entries[index];
    if (entry.seq < from) break;
    if (entry.track !== track) continue;
    const text = displayed(entry, display);
    if (!text) continue;
    const sentences = splitSentences(text);
    for (let sentence = sentences.length - 1; sentence >= 0 && lines.length < limit; sentence -= 1) lines.push(sentences[sentence]);
  }
  return lines.reverse();
}

export class CaptionView {
  constructor(element, placeholder) {
    this.element = element;
    this.lines = [];
    this.content = document.createElement("div");
    this.content.className = "caption-content";
    this.placeholderElement = document.createElement("span");
    this.placeholderElement.className = "placeholder";
    this.element.replaceChildren(this.content, this.placeholderElement);
    this.setPlaceholder(placeholder);
  }

  setPlaceholder(text) {
    this.placeholderElement.textContent = text;
  }

  // One element per line, reused between renders.
  render(lines, lang) {
    this.lines = lines;
    const nodes = this.content.children;
    while (nodes.length > lines.length) this.content.lastElementChild.remove();
    while (nodes.length < lines.length) {
      const line = document.createElement("span");
      line.className = "caption-line";
      this.content.append(line);
    }
    lines.forEach((text, index) => {
      if (nodes[index].textContent !== text) nodes[index].textContent = text;
    });
    if (this.element.lang !== lang) this.element.lang = lang;
    this.element.classList.toggle("is-empty", lines.length === 0);
  }
}
