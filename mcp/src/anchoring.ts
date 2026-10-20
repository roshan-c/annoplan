/** Selectors use JavaScript UTF-16 code units, matching DOM Range offsets. */
export interface Selector {
  quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
}
export interface Anchor {
  start: number;
  end: number;
  method: "position" | "quote";
}
export function createSelector(
  text: string,
  start: number,
  end: number,
): Selector {
  if (start < 0 || end <= start || end > text.length)
    throw new RangeError("Invalid selection");
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32),
    start_offset: start,
    end_offset: end,
  };
}
export function reanchor(text: string, selector: Selector): Anchor | null {
  const {
    quote,
    prefix,
    suffix,
    start_offset: start,
    end_offset: end,
  } = selector;
  if (!quote) return null;
  if (start >= 0 && end > start && text.slice(start, end) === quote)
    return { start, end, method: "position" };
  let best: Anchor | null = null,
    bestScore = -1,
    tied = false;
  for (
    let at = text.indexOf(quote);
    at !== -1;
    at = text.indexOf(quote, at + 1)
  ) {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(
      at + quote.length,
      at + quote.length + suffix.length,
    );
    // Rendered HTML and Markdown source have different block whitespace. Keep
    // the quote exact, but let equivalent context distinguish repeated passages.
    const normalize = (value: string) => value.replace(/\s+/g, " ");
    const contextBefore = normalize(text.slice(Math.max(0, at - 256), at));
    const contextAfter = normalize(
      text.slice(at + quote.length, at + quote.length + 256),
    );
    const score =
      contextScore(before, after, prefix, suffix) +
      contextScore(
        contextBefore,
        contextAfter,
        normalize(prefix),
        normalize(suffix),
      );
    if (score > bestScore) {
      bestScore = score;
      best = { start: at, end: at + quote.length, method: "quote" };
      tied = false;
    } else if (score === bestScore) tied = true;
  }
  // Equally plausible duplicate quotes are unsafe to attach automatically.
  return tied ? null : best;
}

function contextScore(
  before: string,
  after: string,
  prefix: string,
  suffix: string,
): number {
  let score = 0;
  for (
    let i = 1;
    i <= Math.min(before.length, prefix.length) &&
    before.at(-i) === prefix.at(-i);
    i++
  )
    score++;
  for (
    let i = 0;
    i < Math.min(after.length, suffix.length) && after[i] === suffix[i];
    i++
  )
    score++;
  return score;
}
