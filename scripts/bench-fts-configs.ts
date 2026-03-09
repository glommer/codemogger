#!/usr/bin/env bun
/**
 * Benchmark FTS index configurations on ripgrep (100 files, ~1272 chunks)
 *
 * Tests:
 * 1. No FTS — baseline insert + embedding speed
 * 2. FTS on name + signature only
 * 3. FTS on name + signature + snippet (full code)
 *
 * For each: measure insert time, FTS index build time, and keyword search quality
 */

import { connect } from "@tursodatabase/database";
import { CodeIndex } from "../src/index.ts";

const KEYWORD_QUERIES = [
  { query: "Searcher", expectedFile: "searcher" },
  { query: "Printer", expectedFile: "printer" },
  { query: "RegexMatcher", expectedFile: "regex" },
  { query: "walk_parallel", expectedFile: "walk" },
  { query: "grep", expectedFile: "grep" },
  { query: "parse_count", expectedFile: "count" },
  { query: "ignore", expectedFile: "ignore" },
  { query: "Config", expectedFile: "config" },
  { query: "Args", expectedFile: "args" },
  { query: "read_stdin", expectedFile: "stdin" },
];

async function testFtsSearch(dbPath: string, label: string) {
  const db = await connect(dbPath, { experimental: ["index_method"] });
  let hits = 0;
  for (const q of KEYWORD_QUERIES) {
    try {
      const rows = (await db
        .prepare(
          `SELECT file_path, name, kind FROM chunks
         WHERE fts_match(name, signature, snippet, ?)
         ORDER BY fts_score(name, signature, snippet, ?) DESC
         LIMIT 3`,
        )
        .all(q.query, q.query)) as any[];
      const found = rows.some((r: any) => r.file_path.includes(q.expectedFile));
      if (found) hits++;
    } catch {
      // FTS not available
    }
  }
  console.log(`  ${label} keyword search: ${hits}/${KEYWORD_QUERIES.length} top-3 hits`);
  db.close();
}

async function testSlimFtsSearch(dbPath: string) {
  const db = await connect(dbPath, { experimental: ["index_method"] });
  let hits = 0;
  for (const q of KEYWORD_QUERIES) {
    try {
      const rows = (await db
        .prepare(
          `SELECT file_path, name, kind FROM chunks
         WHERE fts_match(name, signature, ?)
         ORDER BY fts_score(name, signature, ?) DESC
         LIMIT 3`,
        )
        .all(q.query, q.query)) as any[];
      const found = rows.some((r: any) => r.file_path.includes(q.expectedFile));
      if (found) hits++;
    } catch (e: any) {
      console.log(`  error: ${e.message}`);
    }
  }
  console.log(`  slim FTS keyword search: ${hits}/${KEYWORD_QUERIES.length} top-3 hits`);
  db.close();
}

async function main() {
  const ripgrepDir = "/Users/glaubercosta/recall/ripgrep";

  // Config 1: No FTS
  console.log("=== Config 1: No FTS ===");
  {
    // Temporarily remove FTS from schema
    const { ALL_SCHEMA } = await import("../src/db/schema.ts");
    // We'll just index and then measure
    const db = new CodeIndex({ dbPath: "/tmp/rg-nofts2.db" });
    // Drop FTS after init
    const t = performance.now();
    const result = await db.index(ripgrepDir, { languages: ["rust"], verbose: true });
    console.log(`  Total: ${result.duration}ms (${result.chunks} chunks)`);
    await db.close();
  }

  // Config 2: FTS on name + signature only — build index AFTER inserts
  console.log("\n=== Config 2: FTS on name + signature (post-build) ===");
  {
    const db = await connect("/tmp/rg-nofts2.db", { experimental: ["index_method"] });
    await db.exec("DROP INDEX IF EXISTS idx_chunks_fts");
    const t = performance.now();
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_fts_slim ON chunks
      USING fts (name, signature)
      WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0')`);
    const buildTime = Math.round(performance.now() - t);
    console.log(`  FTS index build (name+sig): ${buildTime}ms`);
    db.close();
    await testSlimFtsSearch("/tmp/rg-nofts2.db");
  }

  // Config 3: FTS on name + signature + snippet — build index AFTER inserts
  console.log("\n=== Config 3: FTS on name + signature + snippet (post-build) ===");
  {
    const db = await connect("/tmp/rg-nofts2.db", { experimental: ["index_method"] });
    await db.exec("DROP INDEX IF EXISTS idx_chunks_fts_slim");
    const t = performance.now();
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_fts_full ON chunks
      USING fts (name, signature, snippet)
      WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0,snippet=1.0')`);
    const buildTime = Math.round(performance.now() - t);
    console.log(`  FTS index build (name+sig+snippet): ${buildTime}ms`);
    db.close();
    await testFtsSearch("/tmp/rg-nofts2.db", "full");
  }
}

main().catch(console.error);
