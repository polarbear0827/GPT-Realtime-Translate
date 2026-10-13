// Builds what the floating caption window shows: the latest caption lines (phrases) of the main track
// (translation, or the source in source-only mode) and of the original below it. The native window
// starts each line on a new row and decides how many fit.

export function buildOverlayPayload({ mode, sourceLines, translationLines, sourceInfo, targetInfo }) {
  const source = { sentences: sourceLines, cjk: sourceInfo.cjk, lang: sourceInfo.lang };
  if (mode === "source") return { primary: source, secondary: null };
  const translation = { sentences: translationLines, cjk: targetInfo.cjk, lang: targetInfo.lang };
  return { primary: translation, secondary: sourceLines.length ? source : null };
}
