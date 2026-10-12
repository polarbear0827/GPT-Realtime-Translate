// Transcript side panel. Updates are incremental: only changed entries are touched, at most once per
// animation frame, and nothing is rendered while the panel is closed. The view only auto-scrolls when
// the reader is already at the bottom.

import { formatClock } from "./text.js";
import { displayText } from "./zh.js";

export class TranscriptView {
  constructor({ store, scroll, empty, jumpButton, languageInfo }) {
    this.store = store;
    this.scroll = scroll;
    this.empty = empty;
    this.jumpButton = jumpButton;
    this.languageInfo = languageInfo;
    this.nodes = new Map();
    this.pending = new Set();
    this.needsFullRender = true;
    this.open = false;
    this.frame = 0;
    store.subscribe((change) => this.onChange(change));
    scroll.addEventListener("scroll", () => {
      if (this.isNearBottom()) this.jumpButton.hidden = true;
    });
    jumpButton.addEventListener("click", () => this.scrollToBottom());
  }

  setOpen(open) {
    this.open = open;
    if (open) {
      this.flush();
      this.scrollToBottom();
    }
  }

  invalidate() {
    this.needsFullRender = true;
    if (this.open) this.schedule();
  }

  onChange(change) {
    if (change.type === "reset") this.needsFullRender = true;
    else this.pending.add(change.entry);
    if (this.open) this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  flush() {
    const stick = this.isNearBottom();
    if (this.needsFullRender) {
      this.renderAll();
    } else {
      for (const entry of this.pending) this.renderEntry(entry);
      this.pending.clear();
    }
    this.empty.hidden = this.nodes.size > 0;
    if (stick) this.scrollToBottom();
    else if (this.nodes.size > 0) this.jumpButton.hidden = false;
  }

  renderAll() {
    this.needsFullRender = false;
    this.pending.clear();
    this.nodes.clear();
    const fragment = document.createDocumentFragment();
    for (const entry of this.store.entries) {
      if (entry.text.trim()) fragment.append(this.createNode(entry));
    }
    this.scroll.replaceChildren(this.empty, fragment);
  }

  renderEntry(entry) {
    let node = this.nodes.get(entry.id);
    const visible = this.store.byId.has(entry.id) && entry.text.trim();
    if (!visible) {
      node?.remove();
      this.nodes.delete(entry.id);
      return;
    }
    if (node) this.updateNode(node, entry);
    else this.scroll.append(this.createNode(entry));
  }

  createNode(entry) {
    const node = document.createElement("article");
    node.className = entry.track === "translation" ? "entry is-translation" : "entry";
    const header = document.createElement("header");
    const time = document.createElement("time");
    const tag = document.createElement("span");
    tag.className = "tag";
    header.append(time, tag);
    const paragraph = document.createElement("p");
    const text = document.createTextNode("");
    paragraph.append(text);
    node.append(header, paragraph);
    node.parts = { time, tag, paragraph, text };
    this.nodes.set(entry.id, node);
    this.updateNode(node, entry);
    return node;
  }

  updateNode(node, entry) {
    const info = this.languageInfo(entry.language);
    node.parts.time.textContent = formatClock(entry.startMs);
    node.parts.tag.textContent = info.short;
    node.parts.paragraph.lang = info.lang;
    const text = displayText(entry.text, entry.language);
    if (node.parts.text.data !== text) node.parts.text.data = text;
    node.classList.toggle("is-live", !entry.final);
  }

  isNearBottom() {
    const { scrollTop, scrollHeight, clientHeight } = this.scroll;
    return scrollHeight - scrollTop - clientHeight < 48;
  }

  scrollToBottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    this.jumpButton.hidden = true;
  }
}
