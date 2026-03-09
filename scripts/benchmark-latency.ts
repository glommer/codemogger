#!/usr/bin/env bun
/**
 * Quick latency breakdown: semantic vs keyword vs grep
 */
import { CodeIndex } from "../src/index.ts";
import { execSync } from "child_process";

const BASE_DIR = "/Users/glaubercosta/recall/ripgrep";

const SEMANTIC_QUERIES = [
  "How does ripgrep detect binary files during search?",
  "How does the searcher choose between memory mapping and buffered IO?",
  "How does gitignore filtering work during directory traversal?",
  "How does ripgrep search files in parallel across threads?",
  "How does the glob pattern matching engine work?",
];

const KEYWORD_QUERIES = ["Searcher", "RegexMatcher", "WalkBuilder", "GlobSet", "LineStep"];

async function main() {
  const db = new CodeIndex({ dbPath: "/tmp/rg.db" });

  // Warm up embedding model
  await db.search("warmup", { limit: 1, mode: "semantic" });

  // Semantic latency
  let semTotal = 0;
  for (const q of SEMANTIC_QUERIES) {
    const t = performance.now();
    await db.search(q, { limit: 5, mode: "semantic" });
    semTotal += performance.now() - t;
  }

  // Keyword latency
  let kwTotal = 0;
  for (const q of KEYWORD_QUERIES) {
    const t = performance.now();
    await db.search(q, { limit: 5, mode: "keyword" });
    kwTotal += performance.now() - t;
  }

  // Grep latency
  let grepTotal = 0;
  for (const q of KEYWORD_QUERIES) {
    const t = performance.now();
    execSync(`grep -rl "${q}" "${BASE_DIR}" --include="*.rs" 2>/dev/null | head -5 || true`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    grepTotal += performance.now() - t;
  }

  console.log(`Latency breakdown (5 queries each, warmed up):`);
  console.log(`  semantic search:  ${Math.round(semTotal / SEMANTIC_QUERIES.length)}ms avg`);
  console.log(`  keyword search:   ${Math.round(kwTotal / KEYWORD_QUERIES.length)}ms avg`);
  console.log(`  grep:             ${Math.round(grepTotal / KEYWORD_QUERIES.length)}ms avg`);

  await db.close();
}

main().catch(console.error);
