#!/usr/bin/env bun
/**
 * Full benchmark: recall code search vs grep on turso/core (173 Rust files, ~3500 chunks)
 * Covers: storage/pager, WAL, B-tree, VDBE, I/O, schema, types, MVCC, JSON, translate
 */

import { CodeIndex } from "../src/index.ts";
import { execSync } from "child_process";

interface BenchmarkQuery {
  query: string;
  expectedFiles: string[];
  expectedNames?: string[];
  grepPatterns: string[];
  category: string;
}

const QUERIES: BenchmarkQuery[] = [
  // Storage / Pager
  {
    query: "How does the pager read a page from disk or cache?",
    expectedFiles: ["storage/pager.rs"],
    expectedNames: ["read_page", "Pager", "PageRef"],
    grepPatterns: ["fn read_page", "PageRef", "PageCache"],
    category: "storage",
  },
  {
    query: "What happens during a WAL checkpoint?",
    expectedFiles: ["storage/wal.rs", "storage/pager.rs"],
    expectedNames: ["checkpoint", "CheckpointResult", "CheckpointMode"],
    grepPatterns: ["fn checkpoint", "CheckpointResult", "CheckpointMode"],
    category: "storage",
  },
  {
    query: "How does the page cache eviction work when memory is full?",
    expectedFiles: ["storage/page_cache.rs"],
    expectedNames: ["PageCache", "needs_spill", "CacheResizeResult"],
    grepPatterns: ["needs_spill", "PageCache", "cache.*evict"],
    category: "storage",
  },
  {
    query: "How does the buffer pool allocate memory for pages?",
    expectedFiles: ["storage/buffer_pool.rs"],
    expectedNames: ["BufferPool", "alloc", "ArenaBuffer", "Arena"],
    grepPatterns: ["BufferPool", "fn alloc", "ArenaBuffer"],
    category: "storage",
  },

  // B-tree
  {
    query: "How does B-tree cursor seeking work with binary search?",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: [
      "BTreeCursor",
      "CursorSeekState",
      "InteriorPageBinarySearchState",
      "LeafPageBinarySearchState",
    ],
    grepPatterns: ["CursorSeekState", "BinarySearchState", "BTreeCursor"],
    category: "btree",
  },
  {
    query: "How are overflow cells handled when a record is too large for a page?",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: [
      "payload_overflow_threshold_max",
      "payload_overflow_threshold_min",
      "OverwriteCellState",
    ],
    grepPatterns: ["overflow_threshold", "OverflowCell", "payload_overflow"],
    category: "btree",
  },
  {
    query: "How does B-tree integrity checking verify page consistency?",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: ["integrity_check", "IntegrityCheckError", "CheckFreelist"],
    grepPatterns: ["integrity_check", "IntegrityCheckError", "CheckFreelist"],
    category: "btree",
  },

  // VDBE
  {
    query: "How does the VDBE execute an OpenRead instruction to open a cursor?",
    expectedFiles: ["vdbe/execute.rs"],
    expectedNames: ["op_open_read", "op_open_write"],
    grepPatterns: ["op_open_read", "OpenRead", "fn op_open"],
    category: "vdbe",
  },
  {
    query: "How does the hash table handle join probe operations?",
    expectedFiles: ["vdbe/hash_table.rs"],
    expectedNames: ["HashTable", "probe", "finalize_build", "HashEntry"],
    grepPatterns: ["fn probe", "HashTable", "HashEntry"],
    category: "vdbe",
  },
  {
    query: "How does the external sorter handle sorting large result sets?",
    expectedFiles: ["vdbe/sorter.rs"],
    expectedNames: ["Sorter", "sort", "next"],
    grepPatterns: ["struct Sorter", "fn sort", "Sorter::new"],
    category: "vdbe",
  },
  {
    query: "How does the VDBE compare two register values?",
    expectedFiles: ["vdbe/execute.rs"],
    expectedNames: ["op_compare"],
    grepPatterns: ["op_compare", "fn op_compare"],
    category: "vdbe",
  },

  // Types / Schema
  {
    query: "How does value comparison work across different SQLite types?",
    expectedFiles: ["types.rs"],
    expectedNames: ["compare_immutable", "compare_records_generic", "ValueRef"],
    grepPatterns: ["compare_immutable", "compare_records", "fn compare"],
    category: "types",
  },
  {
    query: "What is the schema representation for database tables and indexes?",
    expectedFiles: ["schema.rs"],
    expectedNames: ["BTreeTable", "Index", "Column", "Schema"],
    grepPatterns: ["struct BTreeTable", "struct Index", "struct Schema"],
    category: "types",
  },

  // I/O
  {
    query: "How does the async I/O completion model work?",
    expectedFiles: ["io/completions.rs", "io/mod.rs"],
    expectedNames: ["Completion", "CompletionGroup", "IOResult"],
    grepPatterns: ["CompletionGroup", "IOResult", "struct Completion"],
    category: "io",
  },

  // MVCC
  {
    query: "How does MVCC track row versions across transactions?",
    expectedFiles: ["mvcc/database/mod.rs", "mvcc/database/cursor.rs"],
    expectedNames: ["RowVersion", "RowVersionState", "Transaction", "MvccLazyCursor"],
    grepPatterns: ["RowVersion", "RowVersionState", "MvccLazyCursor"],
    category: "mvcc",
  },

  // JSON
  {
    query: "How are JSONB values serialized and traversed?",
    expectedFiles: ["json/jsonb.rs"],
    expectedNames: ["Jsonb", "ElementType", "JsonTraversalResult"],
    grepPatterns: ["struct Jsonb", "ElementType", "JsonTraversal"],
    category: "json",
  },

  // Translate (a few from the full codebase to test at scale)
  {
    query: "How does the query optimizer determine join order?",
    expectedFiles: ["translate/optimizer/join.rs"],
    expectedNames: ["compute_best_join_order", "join_lhs_and_rhs"],
    grepPatterns: ["compute_best_join_order", "join_lhs_and_rhs"],
    category: "translate",
  },
  {
    query: "How does the cost model estimate index scan vs table scan?",
    expectedFiles: ["translate/optimizer/cost.rs", "translate/optimizer/access_method.rs"],
    expectedNames: ["estimate_cost_for_scan_or_seek", "estimate_index_cost", "Cost"],
    grepPatterns: ["estimate_cost", "estimate_index_cost", "estimate_scan_cost"],
    category: "translate",
  },
  {
    query: "How are foreign key cascade actions enforced on delete?",
    expectedFiles: ["translate/fkeys.rs"],
    expectedNames: ["fire_fk_delete_actions", "fire_fk_cascade_delete"],
    grepPatterns: ["fk_cascade_delete", "fire_fk_delete", "ON DELETE"],
    category: "translate",
  },
  {
    query: "How does the bytecode emitter generate nested loop joins?",
    expectedFiles: ["translate/main_loop.rs"],
    expectedNames: ["emit_loop", "open_loop", "close_loop", "LoopLabels"],
    grepPatterns: ["emit_loop", "open_loop", "close_loop", "LoopLabels"],
    category: "translate",
  },
];

const BASE_DIR = "/Users/glaubercosta/recall/turso/core";

function isCorrectFile(resultFile: string, expectedFiles: string[]): boolean {
  return expectedFiles.some((ef) => resultFile.endsWith(ef));
}

function isCorrectName(resultName: string, expectedNames?: string[]): boolean {
  if (!expectedNames) return false;
  return expectedNames.some((en) => resultName === en || resultName.includes(en));
}

function isHit(resultFile: string, resultName: string, q: BenchmarkQuery): boolean {
  return isCorrectFile(resultFile, q.expectedFiles) || isCorrectName(resultName, q.expectedNames);
}

function grepForPatterns(patterns: string[]): string[] {
  const fileHits = new Map<string, number>();
  for (const pattern of patterns) {
    try {
      const output = execSync(
        `grep -rl "${pattern}" "${BASE_DIR}" --include="*.rs" 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (!output) continue;
      for (const file of output.split("\n")) {
        const relPath = file.replace(BASE_DIR + "/", "");
        fileHits.set(relPath, (fileHits.get(relPath) ?? 0) + 1);
      }
    } catch {
      /* grep failed */
    }
  }
  return [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file)
    .slice(0, 5);
}

async function main() {
  const dbPath = process.argv[2] || "/tmp/recall-full.db";
  console.log(`Full benchmark: turso/core (${QUERIES.length} queries)`);
  console.log(`Database: ${dbPath}\n`);

  const db = new CodeIndex({ dbPath });

  // Run recall benchmark
  let recallTop1 = 0,
    recallTop3 = 0,
    recallTop5 = 0,
    recallMRR = 0,
    recallLatency = 0;
  // Run grep benchmark
  let grepTop1 = 0,
    grepTop3 = 0,
    grepTop5 = 0,
    grepMRR = 0,
    grepLatency = 0;

  let recallWins = 0,
    grepWins = 0,
    ties = 0;

  console.log("ID  recall  grep    query");
  console.log("-".repeat(90));

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];

    // recall search
    const rs = performance.now();
    const recallResults = await db.search(q.query, { limit: 5, includeSnippet: false });
    const rLatency = Math.round(performance.now() - rs);
    recallLatency += rLatency;

    // grep search
    const gs = performance.now();
    const grepResults = grepForPatterns(q.grepPatterns);
    const gLatency = Math.round(performance.now() - gs);
    grepLatency += gLatency;

    // Score recall
    const rTop1 =
      recallResults.length > 0 && isHit(recallResults[0].filePath, recallResults[0].name, q);
    const rTop3 = recallResults.slice(0, 3).some((r) => isHit(r.filePath, r.name, q));
    const rTop5 = recallResults.some((r) => isHit(r.filePath, r.name, q));
    let rRank = 0;
    for (let j = 0; j < recallResults.length; j++) {
      if (isHit(recallResults[j].filePath, recallResults[j].name, q)) {
        rRank = j + 1;
        break;
      }
    }
    if (rTop1) recallTop1++;
    if (rTop3) recallTop3++;
    if (rTop5) recallTop5++;
    if (rRank > 0) recallMRR += 1 / rRank;

    // Score grep
    const gTop1 = grepResults.length > 0 && isCorrectFile(grepResults[0], q.expectedFiles);
    const gTop3 = grepResults.slice(0, 3).some((r) => isCorrectFile(r, q.expectedFiles));
    const gTop5 = grepResults.some((r) => isCorrectFile(r, q.expectedFiles));
    let gRank = 0;
    for (let j = 0; j < grepResults.length; j++) {
      if (isCorrectFile(grepResults[j], q.expectedFiles)) {
        gRank = j + 1;
        break;
      }
    }
    if (gTop1) grepTop1++;
    if (gTop3) grepTop3++;
    if (gTop5) grepTop5++;
    if (gRank > 0) grepMRR += 1 / gRank;

    // Head-to-head
    const rScore = rTop1 ? 3 : rTop3 ? 2 : rTop5 ? 1 : 0;
    const gScore = gTop1 ? 3 : gTop3 ? 2 : gTop5 ? 1 : 0;
    if (rScore > gScore) recallWins++;
    else if (gScore > rScore) grepWins++;
    else ties++;

    const rMark = rTop1 ? "HIT " : rTop3 ? "top3" : rTop5 ? "top5" : "MISS";
    const gMark = gTop1 ? "HIT " : gTop3 ? "top3" : gTop5 ? "top5" : "MISS";
    const winner = rScore > gScore ? " ← recall" : gScore > rScore ? " ← grep" : "";
    console.log(
      `${String(i + 1).padStart(2)}  ${rMark}    ${gMark}    ${q.query.slice(0, 55)}...${winner}`,
    );
  }

  await db.close();

  const n = QUERIES.length;
  console.log(`\n${"=".repeat(90)}`);
  console.log(`RESULTS: ${n} queries across turso/core (173 files, ~3500 chunks)`);
  console.log(`${"=".repeat(90)}`);
  console.log(`                    recall (vector)    grep (keywords)`);
  console.log(
    `Top-1 accuracy:     ${((recallTop1 / n) * 100).toFixed(0)}% (${recallTop1}/${n})${" ".repeat(12)}${((grepTop1 / n) * 100).toFixed(0)}% (${grepTop1}/${n})`,
  );
  console.log(
    `Top-3 recall:       ${((recallTop3 / n) * 100).toFixed(0)}% (${recallTop3}/${n})${" ".repeat(12)}${((grepTop3 / n) * 100).toFixed(0)}% (${grepTop3}/${n})`,
  );
  console.log(
    `Top-5 recall:       ${((recallTop5 / n) * 100).toFixed(0)}% (${recallTop5}/${n})${" ".repeat(12)}${((grepTop5 / n) * 100).toFixed(0)}% (${grepTop5}/${n})`,
  );
  console.log(
    `MRR:                ${(recallMRR / n).toFixed(3)}${" ".repeat(16)}${(grepMRR / n).toFixed(3)}`,
  );
  console.log(
    `Avg latency:        ${Math.round(recallLatency / n)}ms${" ".repeat(17)}${Math.round(grepLatency / n)}ms`,
  );
  console.log(
    `\nHead-to-head:       recall wins ${recallWins}, grep wins ${grepWins}, ties ${ties}`,
  );
}

main().catch(console.error);
