#!/usr/bin/env bun
/**
 * "Smart agent" benchmark: the agent picks semantic vs keyword mode per query.
 * Compares: recall (smart mode selection) vs grep (hand-crafted patterns)
 *
 * This simulates how a real agent would use recall:
 * - Conceptual questions → semantic search
 * - Known identifiers → keyword search
 */

import { CodeIndex, type SearchMode } from "../src/index.ts";
import { execSync } from "child_process";

interface BenchmarkQuery {
  query: string;
  mode: SearchMode; // what a smart agent would pick
  expectedFiles: string[];
  expectedNames?: string[];
  grepPatterns: string[];
  category: string;
}

const QUERIES: BenchmarkQuery[] = [
  // --- SEMANTIC: conceptual / "how does X work" questions ---
  {
    query: "How does the pager read a page from disk or cache?",
    mode: "semantic",
    expectedFiles: ["storage/pager.rs"],
    expectedNames: ["read_page", "Pager", "PageRef"],
    grepPatterns: ["fn read_page", "PageRef", "PageCache"],
    category: "storage",
  },
  {
    query: "What happens during a WAL checkpoint?",
    mode: "semantic",
    expectedFiles: ["storage/wal.rs", "storage/pager.rs"],
    expectedNames: ["checkpoint", "CheckpointResult", "CheckpointMode"],
    grepPatterns: ["fn checkpoint", "CheckpointResult", "CheckpointMode"],
    category: "storage",
  },
  {
    query: "How does the page cache decide what to evict when memory is full?",
    mode: "semantic",
    expectedFiles: ["storage/page_cache.rs"],
    expectedNames: ["PageCache", "needs_spill", "CacheResizeResult"],
    grepPatterns: ["needs_spill", "PageCache", "cache.*evict"],
    category: "storage",
  },
  {
    query: "How are overflow cells handled when a record is too large for a page?",
    mode: "semantic",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: ["payload_overflow_threshold_max", "payload_overflow_threshold_min"],
    grepPatterns: ["overflow_threshold", "OverflowCell", "payload_overflow"],
    category: "btree",
  },
  {
    query: "How does the query optimizer determine join order?",
    mode: "semantic",
    expectedFiles: ["translate/optimizer/join.rs"],
    expectedNames: ["compute_best_join_order", "join_lhs_and_rhs"],
    grepPatterns: ["compute_best_join_order", "join_lhs_and_rhs"],
    category: "translate",
  },
  {
    query: "How does the async I/O completion model work?",
    mode: "semantic",
    expectedFiles: ["io/completions.rs", "io/mod.rs"],
    expectedNames: ["Completion", "CompletionGroup", "IOResult"],
    grepPatterns: ["CompletionGroup", "IOResult", "struct Completion"],
    category: "io",
  },
  {
    query: "How does MVCC track row versions across transactions?",
    mode: "semantic",
    expectedFiles: ["mvcc/database/mod.rs", "mvcc/database/cursor.rs"],
    expectedNames: ["RowVersion", "RowVersionState", "Transaction", "MvccLazyCursor"],
    grepPatterns: ["RowVersion", "RowVersionState", "MvccLazyCursor"],
    category: "mvcc",
  },
  {
    query: "How are JSONB values serialized and traversed?",
    mode: "semantic",
    expectedFiles: ["json/jsonb.rs"],
    expectedNames: ["Jsonb", "ElementType", "JsonTraversalResult"],
    grepPatterns: ["struct Jsonb", "ElementType", "JsonTraversal"],
    category: "json",
  },
  {
    query: "How does the bytecode emitter generate nested loop joins?",
    mode: "semantic",
    expectedFiles: ["translate/main_loop.rs"],
    expectedNames: ["emit_loop", "open_loop", "close_loop", "LoopLabels"],
    grepPatterns: ["emit_loop", "open_loop", "close_loop", "LoopLabels"],
    category: "translate",
  },
  {
    query: "How does the cost model estimate whether to use an index or full scan?",
    mode: "semantic",
    expectedFiles: ["translate/optimizer/cost.rs", "translate/optimizer/access_method.rs"],
    expectedNames: ["estimate_cost_for_scan_or_seek", "estimate_index_cost", "Cost"],
    grepPatterns: ["estimate_cost", "estimate_index_cost", "estimate_scan_cost"],
    category: "translate",
  },

  // --- KEYWORD: precise identifier lookups ---
  {
    query: "BTreeCursor",
    mode: "keyword",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: ["BTreeCursor"],
    grepPatterns: ["BTreeCursor"],
    category: "btree",
  },
  {
    query: "compare_immutable",
    mode: "keyword",
    expectedFiles: ["types.rs"],
    expectedNames: ["compare_immutable"],
    grepPatterns: ["compare_immutable"],
    category: "types",
  },
  {
    query: "op_open_read",
    mode: "keyword",
    expectedFiles: ["vdbe/execute.rs"],
    expectedNames: ["op_open_read"],
    grepPatterns: ["op_open_read"],
    category: "vdbe",
  },
  {
    query: "HashTable probe",
    mode: "keyword",
    expectedFiles: ["vdbe/hash_table.rs"],
    expectedNames: ["HashTable", "probe"],
    grepPatterns: ["fn probe", "struct HashTable"],
    category: "vdbe",
  },
  {
    query: "Sorter",
    mode: "keyword",
    expectedFiles: ["vdbe/sorter.rs"],
    expectedNames: ["Sorter"],
    grepPatterns: ["struct Sorter"],
    category: "vdbe",
  },
  {
    query: "fire_fk_cascade_delete",
    mode: "keyword",
    expectedFiles: ["translate/fkeys.rs"],
    expectedNames: ["fire_fk_cascade_delete", "fire_fk_delete_actions"],
    grepPatterns: ["fire_fk_cascade_delete"],
    category: "translate",
  },
  {
    query: "BufferPool alloc",
    mode: "keyword",
    expectedFiles: ["storage/buffer_pool.rs"],
    expectedNames: ["BufferPool", "alloc", "ArenaBuffer"],
    grepPatterns: ["BufferPool", "fn alloc"],
    category: "storage",
  },
  {
    query: "integrity_check",
    mode: "keyword",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: ["integrity_check", "IntegrityCheckError"],
    grepPatterns: ["integrity_check", "IntegrityCheckError"],
    category: "btree",
  },
  {
    query: "ProgramBuilder",
    mode: "keyword",
    expectedFiles: ["vdbe/builder.rs"],
    expectedNames: ["ProgramBuilder"],
    grepPatterns: ["struct ProgramBuilder"],
    category: "vdbe",
  },
  {
    query: "CheckpointMode",
    mode: "keyword",
    expectedFiles: ["storage/wal.rs"],
    expectedNames: ["CheckpointMode", "CheckpointResult"],
    grepPatterns: ["enum CheckpointMode"],
    category: "storage",
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

function scoreResult(
  results: { filePath: string; name: string }[],
  q: BenchmarkQuery,
): { top1: boolean; top3: boolean; top5: boolean; rank: number } {
  const top1 = results.length > 0 && isHit(results[0].filePath, results[0].name, q);
  const top3 = results.slice(0, 3).some((r) => isHit(r.filePath, r.name, q));
  const top5 = results.some((r) => isHit(r.filePath, r.name, q));
  let rank = 0;
  for (let j = 0; j < results.length; j++) {
    if (isHit(results[j].filePath, results[j].name, q)) {
      rank = j + 1;
      break;
    }
  }
  return { top1, top3, top5, rank };
}

async function main() {
  const dbPath = process.argv[2] || "/tmp/recall-full.db";
  const semanticCount = QUERIES.filter((q) => q.mode === "semantic").length;
  const keywordCount = QUERIES.filter((q) => q.mode === "keyword").length;
  console.log(
    `Smart agent benchmark: ${QUERIES.length} queries (${semanticCount} semantic, ${keywordCount} keyword)`,
  );
  console.log(`Database: ${dbPath}\n`);

  const db = new CodeIndex({ dbPath });

  let recallTop1 = 0,
    recallTop3 = 0,
    recallMRR = 0,
    recallLatency = 0;
  let grepTop1 = 0,
    grepTop3 = 0,
    grepMRR = 0,
    grepLatency = 0;
  let recallWins = 0,
    grepWins = 0,
    ties = 0;

  // Per-mode stats
  const modeStats = { semantic: { top1: 0, top3: 0, n: 0 }, keyword: { top1: 0, top3: 0, n: 0 } };

  console.log("ID  mode      recall  grep    query");
  console.log("-".repeat(95));

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];

    // recall: use the mode the agent would pick
    const rs = performance.now();
    const recallResults = await db.search(q.query, {
      limit: 5,
      includeSnippet: false,
      mode: q.mode,
    });
    const rLatency = Math.round(performance.now() - rs);
    recallLatency += rLatency;
    const rScore = scoreResult(recallResults, q);

    // grep
    const gs = performance.now();
    const grepResults = grepForPatterns(q.grepPatterns);
    const gLatency = Math.round(performance.now() - gs);
    grepLatency += gLatency;
    const gScore = scoreResult(
      grepResults.map((f) => ({ filePath: f, name: "" })),
      q,
    );

    if (rScore.top1) recallTop1++;
    if (rScore.top3) recallTop3++;
    if (rScore.rank > 0) recallMRR += 1 / rScore.rank;
    if (gScore.top1) grepTop1++;
    if (gScore.top3) grepTop3++;
    if (gScore.rank > 0) grepMRR += 1 / gScore.rank;

    const rVal = rScore.top1 ? 3 : rScore.top3 ? 2 : rScore.top5 ? 1 : 0;
    const gVal = gScore.top1 ? 3 : gScore.top3 ? 2 : gScore.top5 ? 1 : 0;
    if (rVal > gVal) recallWins++;
    else if (gVal > rVal) grepWins++;
    else ties++;

    const ms = modeStats[q.mode as "semantic" | "keyword"];
    ms.n++;
    if (rScore.top1) ms.top1++;
    if (rScore.top3) ms.top3++;

    const rMark = rScore.top1 ? "HIT " : rScore.top3 ? "top3" : rScore.top5 ? "top5" : "MISS";
    const gMark = gScore.top1 ? "HIT " : gScore.top3 ? "top3" : gScore.top5 ? "top5" : "MISS";
    const winner = rVal > gVal ? " ← recall" : gVal > rVal ? " ← grep" : "";
    console.log(
      `${String(i + 1).padStart(2)}  ${q.mode.padEnd(9)} ${rMark}    ${gMark}    ${q.query.slice(0, 48)}...${winner}`,
    );
  }

  await db.close();

  const n = QUERIES.length;
  console.log(`\n${"=".repeat(95)}`);
  console.log(`RESULTS: ${n} queries — agent picks semantic vs keyword per query`);
  console.log(`${"=".repeat(95)}`);
  console.log(`                    recall (smart)     grep (keywords)`);
  console.log(
    `Top-1 accuracy:     ${((recallTop1 / n) * 100).toFixed(0)}% (${recallTop1}/${n})${" ".repeat(12)}${((grepTop1 / n) * 100).toFixed(0)}% (${grepTop1}/${n})`,
  );
  console.log(
    `Top-3 recall:       ${((recallTop3 / n) * 100).toFixed(0)}% (${recallTop3}/${n})${" ".repeat(12)}${((grepTop3 / n) * 100).toFixed(0)}% (${grepTop3}/${n})`,
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

  console.log(`\nBy mode (recall):`);
  console.log(
    `  semantic:  top1=${modeStats.semantic.top1}/${modeStats.semantic.n} (${((modeStats.semantic.top1 / modeStats.semantic.n) * 100).toFixed(0)}%)  top3=${modeStats.semantic.top3}/${modeStats.semantic.n} (${((modeStats.semantic.top3 / modeStats.semantic.n) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  keyword:   top1=${modeStats.keyword.top1}/${modeStats.keyword.n} (${((modeStats.keyword.top1 / modeStats.keyword.n) * 100).toFixed(0)}%)  top3=${modeStats.keyword.top3}/${modeStats.keyword.n} (${((modeStats.keyword.top3 / modeStats.keyword.n) * 100).toFixed(0)}%)`,
  );
}

main().catch(console.error);
