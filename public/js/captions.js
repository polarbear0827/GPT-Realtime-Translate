// Live caption buffers and their on-screen rendering.
// Raw text is kept as received; Chinese conversion runs on the visible tail at render time, and
// rendering is batched to one update per animation frame no matter how many deltas arrive.

import { joinText, tailText } from "./text.js";
import { displayText } from "./zh.js";

const LIVE_CHAR_LIMIT = 4000;
const DISPLAY_CHAR_LIMIT = 900;

export class LiveTrack {
  constructor() {
    this.clear();
  }

  clear() {
    this.items = new Map();
    this.stream = "";
  }

  setItem(id, text) {
    this.items.set(id, text);
    this.prune();
  }

  appendItem(id, delta) {
    this.items.set(id, (this.items.get(id) ?? "") + delta);
    this.prune();
  }

  append(delta) {
    this.stream += delta;
    this.prune();
  }

  text(cjk) {
    return joinText([...this.items.values(), this.stream], cjk);
  }

  prune() {
    let total = this.stream.length;
    for (const text of this.items.values()) total += text.length;
    for (const key of this.items.keys()) {
      if (total <= LIVE_CHAR_LIMIT || this.items.size <= 1) break;
      total -= this.items.get(key).length;
      this.items.delete(key);
    }
    if (this.stream.length > LIVE_CHAR_LIMIT) this.stream = this.stream.slice(-LIVE_CHAR_LIMIT);
  }
}

export class CaptionView {
  constructor(element, placeholder) {
    this.element = element;
    this.content = document.createElement("span");
    this.content.className = "caption-content";
    this.textNode = document.createTextNode("");
    this.content.append(this.textNode);
    this.placeholderElement = document.createElement("span");
    this.placeholderElement.className = "placeholder";
    this.element.replaceChildren(this.content, this.placeholderElement);
    this.setPlaceholder(placeholder);
  }

  setPlaceholder(text) {
    this.placeholderElement.textContent = text;
  }

  // Returns the text that was rendered (also sent to the caption display window).
  render(track, language, info) {
    const text = displayText(tailText(track.text(info.cjk), DISPLAY_CHAR_LIMIT, info.cjk), language);
    if (this.textNode.data !== text) this.textNode.data = text;
    if (this.element.lang !== info.lang) this.element.lang = info.lang;
    this.element.classList.toggle("is-empty", !text);
    return text;
  }
}
