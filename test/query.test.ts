import { describe, test, expect } from "bun:test";
import { extractKeywords, preprocessQuery } from "../src/search/query.ts";

describe("extractKeywords", () => {
  test("removes stopwords and short tokens", () => {
    const result = extractKeywords("I want to extract text from a PDF file");
    expect(result).toBe("extract text pdf");
  });

  test("preserves hyphenated terms", () => {
    const result = extractKeywords("set up a react-setup project with typescript");
    expect(result).toBe("set react-setup project typescript");
  });

  test("deduplicates tokens", () => {
    const result = extractKeywords("review the code review for code quality");
    expect(result).toBe("review quality");
  });

  test("caps at 12 terms", () => {
    const longPrompt =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const keywords = extractKeywords(longPrompt);
    expect(keywords.split(" ").length).toBeLessThanOrEqual(12);
  });

  test("handles empty input", () => {
    expect(extractKeywords("")).toBe("");
    expect(extractKeywords("the a an")).toBe("");
  });
});

describe("preprocessQuery", () => {
  test("raw mode passes through unchanged", () => {
    const query = "I want to extract text from a PDF";
    expect(preprocessQuery(query, "raw")).toBe(query);
  });

  test("keywords mode extracts keywords", () => {
    const query = "I want to extract text from a PDF";
    expect(preprocessQuery(query, "keywords")).toBe("extract text pdf");
  });
});
