#!/usr/bin/env bun
/**
 * Benchmark: FTS insert speed with full snippet vs name+signature only
 */
import { connect } from "@tursodatabase/database";

const longSnippet = `pub fn compute_best_join_order<'a>(
    tables: &'a [JoinedTable],
    where_terms: &'a [WhereTerm],
    schema: &'a Schema,
    order_target: &OrderTarget,
) -> BestJoinOrderResult<'a> {
    let n = tables.len();
    if n <= 1 {
        return BestJoinOrderResult::single(tables, where_terms, schema);
    }
    // Dynamic programming approach: enumerate subsets
    let mut memo: HashMap<u64, JoinN> = HashMap::new();
    for size in 1..=n {
        for subset in subsets_of_size(n, size) {
            let best = find_best_split(subset, &memo, tables, where_terms, schema);
            memo.insert(subset, best);
        }
    }
    let full_mask = (1u64 << n) - 1;
    memo.remove(&full_mask).unwrap()
}`.repeat(3);

async function main() {
  const N = 500;

  // Test 1: FTS on name + signature only (small strings)
  {
    const db = await connect("/tmp/bench-fts-slim.db", { experimental: ["index_method"] });
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_fts_slim ON chunks
      USING fts (name, signature)
      WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0')`);

    const t = performance.now();
    await db.exec("BEGIN");
    const stmt = await db.prepare(
      "INSERT INTO chunks (name, signature, snippet, file_path, kind) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < N; i++) {
      await stmt.run(
        `compute_best_join_order_${i}`,
        `pub fn compute_best_join_order_${i}(tables: &[JoinedTable]) -> Result`,
        longSnippet,
        `optimizer/join.rs`,
        "function",
      );
    }
    await db.exec("COMMIT");
    const ms = Math.round(performance.now() - t);
    console.log(`FTS on name+signature:  ${ms}ms for ${N} = ${(ms / N).toFixed(1)}ms/insert`);
    db.close();
  }

  // Test 2: FTS on name + signature + snippet (full code)
  {
    const db = await connect("/tmp/bench-fts-full.db", { experimental: ["index_method"] });
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_fts_full ON chunks
      USING fts (name, signature, snippet)
      WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0,snippet=1.0')`);

    const t = performance.now();
    await db.exec("BEGIN");
    const stmt = await db.prepare(
      "INSERT INTO chunks (name, signature, snippet, file_path, kind) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < N; i++) {
      await stmt.run(
        `compute_best_join_order_${i}`,
        `pub fn compute_best_join_order_${i}(tables: &[JoinedTable]) -> Result`,
        longSnippet,
        `optimizer/join.rs`,
        "function",
      );
    }
    await db.exec("COMMIT");
    const ms = Math.round(performance.now() - t);
    console.log(`FTS on name+sig+snippet: ${ms}ms for ${N} = ${(ms / N).toFixed(1)}ms/insert`);
    db.close();
  }

  // Test 3: No FTS, just a regular B-tree index on name
  {
    const db = await connect("/tmp/bench-btree-idx.db", { experimental: ["index_method"] });
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_name ON chunks(name)`);

    const t = performance.now();
    await db.exec("BEGIN");
    const stmt = await db.prepare(
      "INSERT INTO chunks (name, signature, snippet, file_path, kind) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < N; i++) {
      await stmt.run(
        `compute_best_join_order_${i}`,
        `pub fn compute_best_join_order_${i}(tables: &[JoinedTable]) -> Result`,
        longSnippet,
        `optimizer/join.rs`,
        "function",
      );
    }
    await db.exec("COMMIT");
    const ms = Math.round(performance.now() - t);
    console.log(`B-tree index on name:   ${ms}ms for ${N} = ${(ms / N).toFixed(1)}ms/insert`);
    db.close();
  }
}

main().catch(console.error);
