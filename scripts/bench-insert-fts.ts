#!/usr/bin/env bun
/**
 * Benchmark: insert speed with and without FTS index
 */
import { connect } from "@tursodatabase/database";

async function main() {
  const N = 500;
  const longText =
    "fn translate_select_plan(plan: &SelectPlan, resolver: &Resolver, program: &mut ProgramBuilder) -> Result<()> { /* ... complex function body with lots of code that exercises the index ... */ }".repeat(
      3,
    );

  // Test 1: Table WITHOUT FTS
  {
    const db = await connect("/tmp/bench-no-fts.db", { experimental: ["index_method"] });
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_key TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      embedding BLOB,
      embedding_model TEXT DEFAULT ''
    )`);

    const t = performance.now();
    await db.exec("BEGIN");
    const stmt =
      await db.prepare(`INSERT INTO chunks (file_path, chunk_key, language, kind, name, signature, snippet, start_line, end_line, file_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < N; i++) {
      await stmt.run(
        `file_${i}.rs`,
        `file_${i}.rs:1:50`,
        "rust",
        "function",
        `func_${i}`,
        `fn func_${i}()`,
        longText,
        1,
        50,
        "abc123",
        Date.now(),
      );
    }
    await db.exec("COMMIT");
    const ms = Math.round(performance.now() - t);
    console.log(`WITHOUT FTS: ${ms}ms for ${N} inserts = ${(ms / N).toFixed(2)}ms/insert`);
    db.close();
  }

  // Test 2: Table WITH FTS index
  {
    const db = await connect("/tmp/bench-with-fts.db", { experimental: ["index_method"] });
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_key TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      embedding BLOB,
      embedding_model TEXT DEFAULT ''
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks
      USING fts (name, signature, snippet)
      WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0,snippet=1.0')`);

    const t = performance.now();
    await db.exec("BEGIN");
    const stmt =
      await db.prepare(`INSERT INTO chunks (file_path, chunk_key, language, kind, name, signature, snippet, start_line, end_line, file_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < N; i++) {
      await stmt.run(
        `file_${i}.rs`,
        `file_${i}.rs:1:50`,
        "rust",
        "function",
        `func_${i}`,
        `fn func_${i}()`,
        longText,
        1,
        50,
        "abc123",
        Date.now(),
      );
    }
    await db.exec("COMMIT");
    const ms = Math.round(performance.now() - t);
    console.log(`WITH FTS:    ${ms}ms for ${N} inserts = ${(ms / N).toFixed(2)}ms/insert`);
    db.close();
  }
}

main().catch(console.error);
