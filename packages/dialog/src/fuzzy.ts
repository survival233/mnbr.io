function ordinalOrNumber(text: string): number | null {
  const t = text.trim().toLowerCase();
  const bare = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\.?$/);
  if (bare) return parseInt(bare[1], 10);
  const word: Record<string, number> = {
    one: 1,
    first: 1,
    two: 2,
    second: 2,
    three: 3,
    third: 3,
    four: 4,
    fourth: 4,
    five: 5,
    fifth: 5,
  };
  if (word[t] != null) return word[t]!;
  const numbered = t.match(/\b(?:number|option|#)\s*(\d{1,2})\b/);
  if (numbered) return parseInt(numbered[1], 10);
  const leading = t.match(/^(\d{1,2})\b/);
  if (leading && t.length <= 4) return parseInt(leading[1], 10);
  return null;
}

export function fuzzyMatchIndex(
  text: string,
  candidates: Array<{ label: string; haystack?: string }>,
  opts?: { labelOnly?: boolean },
): number | null {
  const n = ordinalOrNumber(text);
  if (n != null && n >= 1 && n <= candidates.length) return n - 1;

  let needle = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(the|one|option|number|please|store|lets?|let|go|with|from)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (needle.length < 2) return null;

  const labelOnly = opts?.labelOnly ?? false;
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const label = c.label.toLowerCase();
    const hay = labelOnly ? label : `${label} ${c.haystack ?? ""}`.toLowerCase();

    if (label === needle || needle === label) {
      const score = 4;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (needle.includes(label) && label.length >= 3 && needle.length <= label.length + 12) {
      const score = 3.5;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (label.includes(needle) && needle.length >= 3) {
      const score = 3 + needle.length / 20;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (!labelOnly && hay.includes(needle) && needle.length >= 4) {
      const score = 3.6;
      if (!best || score > best.score) best = { i, score };
      continue;
    }
    if (labelOnly) continue;
    const tokens = needle.split(" ").filter((w) => w.length > 2);
    if (!tokens.length) continue;
    const labelHits = tokens.filter((w) => label.includes(w)).length;
    if (labelHits === 0) continue;
    const score = labelHits / tokens.length;
    if (!best || score > best.score) best = { i, score };
  }
  return best && best.score >= 0.5 ? best.i : null;
}
