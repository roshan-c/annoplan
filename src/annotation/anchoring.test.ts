import { describe, it, expect } from "vitest";
import { createSelector, reanchor } from "./anchoring";
describe("W3C text selectors", () => {
  it("captures exact text and bounded surrounding context", () => {
    const text = "a".repeat(40) + "passage" + "b".repeat(40);
    const s = createSelector(text, 40, 47);
    expect(s).toEqual({
      quote: "passage",
      prefix: "a".repeat(32),
      suffix: "b".repeat(32),
      start_offset: 40,
      end_offset: 47,
    });
  });
  it("prefers matching position even when the quote occurs twice", () => {
    expect(reanchor("one one", createSelector("one one", 4, 7))).toEqual({
      start: 4,
      end: 7,
      method: "position",
    });
  });
  it("recovers from inserted text using quote and context", () => {
    const s = createSelector("intro target ending", 6, 12);
    expect(reanchor("new intro target ending", s)).toEqual({
      start: 10,
      end: 16,
      method: "quote",
    });
  });
  it("uses surrounding context to choose a duplicate after offsets shift", () => {
    const s = createSelector("alpha same omega; beta same delta", 23, 27);
    expect(reanchor("preface alpha same omega; beta same delta", s)).toEqual({
      start: 31,
      end: 35,
      method: "quote",
    });
  });
  it("distinguishes repeated quotes when Markdown block whitespace changes", () => {
    const rendered =
      "alpha heading\ntarget end\nnext\nbeta heading\ntarget end\nlast";
    const source =
      "# alpha heading\n\ntarget end\n\nnext\n\n## beta heading\n\ntarget end\n\nlast";
    const selector = createSelector(rendered, 14, 20);
    expect(reanchor(source, selector)).toEqual({
      start: 17,
      end: 23,
      method: "quote",
    });
  });
  it("reports missing and ambiguous quotes as orphaned", () => {
    const s = {
      quote: "lost",
      prefix: "",
      suffix: "",
      start_offset: 50,
      end_offset: 54,
    };
    expect(reanchor("nothing here", s)).toBeNull();
    expect(reanchor("lost and lost", s)).toBeNull();
  });
  it("handles emoji, non-Latin text, and selection boundaries using DOM offsets", () => {
    const s = createSelector("📚 日本語 fin", 3, 6);
    expect(s.quote).toBe("日本語");
    expect(reanchor("📚 日本語 fin", s)).toEqual({
      start: 3,
      end: 6,
      method: "position",
    });
    expect(createSelector("word", 0, 4).prefix).toBe("");
    expect(() => createSelector("word", 2, 2)).toThrow(RangeError);
  });
});
