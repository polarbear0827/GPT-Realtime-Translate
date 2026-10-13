// Phrase boundaries for live captions. Pure text functions, no DOM.
// - alignBreaks: maps the line breaks chosen by the language model (see segmenter.js) back onto the
//   original text, which is never changed.
// - clauseBreak / ruleBreak: the fallback used when the model isn't available: clause marks,
//   connectives and sentence-final particles, never inside a word.

const SPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
// Marks that stay with the phrase before a break.
const CLOSING = /[，,。.、；;：:！!？?…」』）)\]】》〉"'”’]/;
const CLAUSE_END = /[，、；：—,;:]$/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Cut positions in `text` after each of the model's lines but the last, or null when the lines
// don't spell out the text. Whitespace, case and punctuation the model added or dropped are tolerated.
export function alignBreaks(text, lines) {
  if (!Array.isArray(lines)) return null;
  const breaks = [];
  let index = 0;
  const matches = (char) => text.slice(index, index + char.length).toLowerCase() === char.toLowerCase();
  for (let line = 0; line < lines.length; line += 1) {
    for (const char of String(lines[line])) {
      if (SPACE.test(char)) continue;
      while (index < text.length && SPACE.test(text[index])) index += 1;
      while (index < text.length && !matches(char) && PUNCTUATION.test(text[index])) index += 1;
      if (matches(char)) {
        index += char.length;
      } else if (!PUNCTUATION.test(char)) {
        return null;
      }
    }
    if (line < lines.length - 1) {
      let cut = index;
      while (cut < text.length && (SPACE.test(text[cut]) || CLOSING.test(text[cut]))) cut += 1;
      if (cut > (breaks.at(-1) ?? 0) && text.slice(cut).trim()) breaks.push(cut);
    }
  }
  return breaks;
}

// The phrases before each cut, trimmed.
export function headsAt(text, breaks) {
  const heads = [];
  let start = 0;
  for (const cut of breaks) {
    const head = text.slice(start, cut).trim();
    if (head) heads.push(head);
    start = cut;
  }
  return heads;
}

// Position after the first clause mark that ends a phrase of at least `minChars`, or -1.
// A mark at the very end isn't confirmed yet ("3," may continue as "3,000").
export function clauseBreak(text, minChars) {
  for (const match of text.matchAll(/[，、；：—]|[,;:](?=\s|\p{Script=Han})/gu)) {
    let cut = match.index + match[0].length;
    while (cut < text.length && (SPACE.test(text[cut]) || CLOSING.test(text[cut]))) cut += 1;
    if (cut < text.length && text.slice(0, match.index).trim().length >= minChars) return cut;
  }
  return -1;
}

const CJK_CONNECTIVES = [
  "所以", "但是", "可是", "不過", "不过", "然後", "然后", "因為", "因为", "因此", "如果", "要是", "假如",
  "而且", "並且", "并且", "還有", "还有", "接著", "接着", "雖然", "虽然", "儘管", "尽管", "即使", "就算",
  "只要", "只有", "除非", "否則", "否则", "於是", "于是", "結果", "结果", "另外", "同時", "同时", "甚至",
  "畢竟", "毕竟", "其實", "其实", "不然", "那麼", "那么", "然而", "或者", "或是", "以及", "尤其", "例如",
  "比如", "總之", "总之", "接下來", "接下来",
];
const CJK_SUBJECTS = ["我們", "我们", "你們", "你们", "他們", "他们", "她們", "她们", "咱們", "咱们", "大家"];
const CJK_FINAL_PARTICLE = /^[了吧呢啊嗎吗啦喔哦呀耶嘛囉啰]$/;
// A break right after these splits a phrase…
const CJK_BINDS_NEXT = /[的之在把被和跟與与對对給给從从向往讓让將将很最太更都也還还就才又再不沒没是個个這这那]$/;
// …and right before these.
const CJK_BINDS_PREVIOUS = /^[的了著着過过們们嗎吗呢吧啊地得]/;
const EN_CONNECTIVES = new Set([
  "and", "but", "or", "so", "because", "although", "though", "while", "whereas", "unless", "until", "since", "if",
  "when", "whenever", "where", "which", "who", "whose", "then", "yet", "nor", "whether", "once", "after", "before",
]);
const EN_PREPOSITIONS = new Set([
  "to", "in", "on", "at", "for", "with", "from", "by", "into", "onto", "about", "over", "under", "through",
  "without", "like", "than", "between", "during", "against", "around", "as",
]);
const EN_BINDS_NEXT = new Set([
  "a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those", "to",
  "of", "very", "more", "most", "not", "no",
]);

// Boundaries at least this natural: a connective, a particle or a clause mark.
const STRONG = 60;

const segmenters = new Map();

function words(text, language) {
  const Segmenter = globalThis.Intl?.Segmenter;
  if (!Segmenter) return fallbackWords(text);
  let segmenter = segmenters.get(language);
  if (!segmenter) {
    try {
      segmenter = new Segmenter(language || undefined, { granularity: "word" });
    } catch {
      segmenter = new Segmenter(undefined, { granularity: "word" });
    }
    segmenters.set(language, segmenter);
  }
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({ segment, index }));
}

function fallbackWords(text) {
  const result = [];
  for (const match of text.matchAll(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
    result.push({ segment: match[0], index: match.index });
  }
  return result;
}

// Where to cut a phrase that ran long: the most natural boundary (clause mark, then a connective,
// then after a sentence-final particle, then any word boundary that doesn't split a phrase). Among
// equally strong ones the first, so each clause gets its own line; among plain word boundaries the
// last. Keeps at least `minChars` before the cut; text.length when there's no boundary.
export function ruleBreak(text, { language = "", minChars = 4 } = {}) {
  const cjk = CJK.test(text);
  const parts = words(text, language);
  let best = { score: 0, cut: text.length };
  for (let part = 1; part < parts.length; part += 1) {
    const { segment, index } = parts[part];
    if (SPACE.test(segment)) continue;
    const head = text.slice(0, index).trim();
    if (head.length < minChars) continue;
    const previous = parts[part - 1].segment.trim() || parts[part - 2]?.segment || "";
    const score = cjk ? cjkScore(text, index, previous) : wordScore(segment, previous, head);
    if (score > best.score || (score > 0 && score === best.score && score < STRONG)) best = { score, cut: index };
  }
  return best.cut;
}

function cjkScore(text, index, previous) {
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index);
  if (/[。！？!?]$/.test(before)) return 100;
  if (CLAUSE_END.test(before)) return 90;
  if (CJK_CONNECTIVES.some((word) => after.startsWith(word))) return 70;
  if (CJK_FINAL_PARTICLE.test(previous)) return 60;
  if (CJK_SUBJECTS.some((word) => after.startsWith(word))) return 35;
  if (CJK_BINDS_NEXT.test(before) || CJK_BINDS_PREVIOUS.test(after)) return 0;
  return 10;
}

function wordScore(segment, previous, head) {
  const word = segment.toLowerCase();
  if (/[.!?]$/.test(head)) return 100;
  if (/[,;:—]$/.test(head)) return 90;
  if (EN_CONNECTIVES.has(word)) return 70;
  if (EN_BINDS_NEXT.has(previous.toLowerCase())) return 0;
  if (EN_PREPOSITIONS.has(word)) return 30;
  return /\w/.test(segment) ? 10 : 0;
}
