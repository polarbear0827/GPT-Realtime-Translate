// Builds what the floating caption window shows: the latest sentences of the main track (translation,
// or the source in source-only mode) and of the original below it. The native window decides how many
// whole sentences fit; this only converts text for display and splits it into sentences.

import { splitSentences, tailText } from "./text.js";

const TAIL_CHARS = 600;
const MAX_SENTENCES = 4;

function line(text, language, info, display) {
  const converted = display(tailText(text, TAIL_CHARS, info.cjk), language);
  return { sentences: splitSentences(converted).slice(-MAX_SENTENCES), cjk: info.cjk, lang: info.lang };
}

export function buildOverlayPayload({ mode, sourceText, translationText, sourceLanguage, targetLanguage, languageInfo, display }) {
  const source = line(sourceText, sourceLanguage, languageInfo(sourceLanguage), display);
  if (mode === "source") return { primary: source, secondary: null };
  const translation = line(translationText, targetLanguage, languageInfo(targetLanguage), display);
  return { primary: translation, secondary: source.sentences.length ? source : null };
}
