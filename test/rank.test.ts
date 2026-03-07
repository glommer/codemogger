import { describe, it, expect } from "bun:test";
import { rrfMerge } from "../src/search/rank.ts";
import type { SearchResult } from "../src/db/store.ts";

function result(name: string, score = 1): SearchResult {
  return {
    chunkKey: name,
    filePath: `/src/${name}.ts`,
    name,
    kind: "function",
    signature: `function ${name}()`,
    snippet: `function ${name}() { /* ... */ }`,
    startLine: 1,
    endLine: 5,
    score,
  };
}

describe("rrfMerge", () => {
  it("boosts skills that appear in both lists", () => {
    const fts = [result("a"), result("b"), result("c")];
    const vec = [result("b"), result("a"), result("d")];

    const merged = rrfMerge(fts, vec, 5);

    // a and b appear in both → highest RRF scores (above c and d)
    // With default weights (0.4 fts, 0.6 vec):
    //   b: 0.4/62 + 0.6/61 (vec rank 1 is worth more)
    //   a: 0.4/61 + 0.6/62
    // b wins because vector weight is higher and b is vec #1
    const topTwo = new Set([merged[0]!.name, merged[1]!.name]);
    expect(topTwo.has("a")).toBe(true);
    expect(topTwo.has("b")).toBe(true);
    expect(merged[0]!.score).toBeGreaterThan(merged[2]!.score);
    expect(merged.length).toBe(4);
  });

  it("respects limit", () => {
    const fts = [result("a"), result("b"), result("c")];
    const vec = [result("d"), result("e"), result("f")];

    const merged = rrfMerge(fts, vec, 2);
    expect(merged.length).toBe(2);
  });

  it("handles empty FTS results", () => {
    const vec = [result("a"), result("b")];
    const merged = rrfMerge([], vec, 5);

    expect(merged.length).toBe(2);
    expect(merged[0]!.name).toBe("a");
  });

  it("handles empty vector results", () => {
    const fts = [result("a"), result("b")];
    const merged = rrfMerge(fts, [], 5);

    expect(merged.length).toBe(2);
    expect(merged[0]!.name).toBe("a");
  });

  it("handles both empty", () => {
    expect(rrfMerge([], [], 5)).toEqual([]);
  });
});
