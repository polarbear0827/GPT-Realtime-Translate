// Caption entry operations, shared by the relay (src/room-state.js) and the viewer page (viewer.js) so
// both sides apply the host's changes identically.
//
// An entry is { i: id, k: "t" (translation) | "s" (source), x: text, f: 1 when final, l: BCP 47 tag }.
// Operations: { i, k, x } sets the text, { i, a } appends to it, { i, f: 1 } marks it final,
// { i, d: 1 } deletes it.

export const LIMITS = {
  entries: 300,
  entryChars: 2000,
  idChars: 48,
};

const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Returns a sanitized operation, or null when it is malformed.
export function cleanOp(value) {
  if (!value || typeof value.i !== "string" || !value.i || value.i.length > LIMITS.idChars) return null;
  if (value.d) return { i: value.i, d: 1 };
  const op = { i: value.i };
  if (value.k === "s" || value.k === "t") op.k = value.k;
  if (typeof value.x === "string") op.x = value.x.slice(0, LIMITS.entryChars);
  else if (typeof value.a === "string") op.a = value.a.slice(0, LIMITS.entryChars);
  if (value.f) op.f = 1;
  if (typeof value.l === "string" && LANG_TAG.test(value.l)) op.l = value.l;
  if (op.x === undefined && op.a === undefined && !op.f) return null;
  return op;
}

// Applies one operation to an ordered Map of entries. Returns false when it can't be applied (an append
// or a final mark for an entry this side doesn't have), which means the two sides are out of sync.
export function applyOp(entries, op, maxEntries = LIMITS.entries) {
  if (op.d) {
    entries.delete(op.i);
    return true;
  }
  let entry = entries.get(op.i);
  if (!entry) {
    if (op.x === undefined || !op.k) return false;
    entry = { i: op.i, k: op.k, x: "" };
    entries.set(op.i, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  if (op.x !== undefined) entry.x = op.x;
  if (op.a !== undefined) entry.x = (entry.x + op.a).slice(0, LIMITS.entryChars);
  if (op.f) entry.f = 1;
  if (op.l) entry.l = op.l;
  return true;
}

