#!/usr/bin/env bun
/**
 * Smart agent benchmark on turso/core (173 files, 3578 chunks)
 * Agent picks semantic vs keyword mode per query.
 */

import { CodeIndex, type SearchMode } from "../src/index.ts";
import { execSync } from "child_process";

interface Query {
  query: string;
  mode: SearchMode;
  expectedFiles: string[];
  expectedNames?: string[];
  grepPatterns: string[];
  category: string;
}

const QUERIES: Query[] = [
  // --- SEMANTIC (10) ---
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
    query: "How are overflow cells handled when a record is too large for a B-tree page?",
    mode: "semantic",
    expectedFiles: ["storage/btree.rs"],
    expectedNames: ["payload_overflow_threshold_max", "payload_overflow_threshold_min"],
    grepPatterns: ["overflow_threshold", "OverflowCell", "payload_overflow"],
    category: "btree",
  },
  {
    query: "How does the query optimizer determine the optimal join order?",
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
    query: "How does the cost model estimate whether to use an index or full scan?",
    mode: "semantic",
    expectedFiles: ["translate/optimizer/cost.rs", "translate/optimizer/access_method.rs"],
    expectedNames: ["estimate_cost_for_scan_or_seek", "estimate_index_cost", "Cost"],
    grepPatterns: ["estimate_cost", "estimate_index_cost", "estimate_scan_cost"],
    category: "translate",
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
    query: "How does the external sorter handle large result sets that don't fit in memory?",
    mode: "semantic",
    expectedFiles: ["vdbe/sorter.rs"],
    expectedNames: ["Sorter"],
    grepPatterns: ["struct Sorter", "fn sort"],
    category: "vdbe",
  },

  // --- KEYWORD (10) ---
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
    query: "HashTable",
    mode: "keyword",
    expectedFiles: ["vdbe/hash_table.rs"],
    expectedNames: ["HashTable"],
    grepPatterns: ["struct HashTable"],
    category: "vdbe",
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
    expectedNames: ["CheckpointMode"],
    grepPatterns: ["enum CheckpointMode"],
    category: "storage",
  },
  {
    query: "PageCache",
    mode: "keyword",
    expectedFiles: ["storage/page_cache.rs"],
    expectedNames: ["PageCache"],
    grepPatterns: ["struct PageCache"],
    category: "storage",
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
    query: "BufferPool",
    mode: "keyword",
    expectedFiles: ["storage/buffer_pool.rs"],
    expectedNames: ["BufferPool"],
    grepPatterns: ["struct BufferPool"],
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
    query: "Delta",
    mode: "keyword",
    expectedFiles: ["incremental/dbsp.rs"],
    expectedNames: ["Delta"],
    grepPatterns: ["struct Delta"],
    category: "incremental",
  },
];

const BASE_DIR = "/Users/glaubercosta/recall/turso/core";

function isHit(filePath: string, name: string, q: Query): boolean {
  const fileMatch = q.expectedFiles.some((ef) => filePath.endsWith(ef));
  const nameMatch = q.expectedNames?.some((en) => name === en || name.includes(en)) ?? false;
  return fileMatch || nameMatch;
}

function grepSearch(patterns: string[]): string[] {
  const hits = new Map<string, number>();
  for (const p of patterns) {
    try {
      const out = execSync(`grep -rl "${p}" "${BASE_DIR}" --include="*.rs" 2>/dev/null || true`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (!out) continue;
      for (const f of out.split("\n")) {
        const rel = f.replace(BASE_DIR + "/", "");
        hits.set(rel, (hits.get(rel) ?? 0) + 1);
      }
    } catch {}
  }
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .slice(0, 5);
}

async function main() {
  const dbPath = process.argv[2] || "/tmp/recall-full.db";
  const semN = QUERIES.filter((q) => q.mode === "semantic").length;
  const kwN = QUERIES.filter((q) => q.mode === "keyword").length;
  console.log(`Turso/core benchmark: ${QUERIES.length} queries (${semN} semantic, ${kwN} keyword)`);
  console.log(`Database: ${dbPath} (173 files, 3578 chunks)\n`);

  const db = new CodeIndex({ dbPath });
  let rTop1 = 0,
    rTop3 = 0,
    rMRR = 0,
    rLat = 0;
  let gTop1 = 0,
    gTop3 = 0,
    gMRR = 0,
    gLat = 0;
  let rWins = 0,
    gWins = 0,
    tieCount = 0;
  const mode_s = { top1: 0, top3: 0, n: 0 };
  const mode_k = { top1: 0, top3: 0, n: 0 };

  console.log("ID  mode      recall  grep    query");
  console.log("-".repeat(95));

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];

    const t1 = performance.now();
    const results = await db.search(q.query, { limit: 5, includeSnippet: false, mode: q.mode });
    const rLatency = performance.now() - t1;
    rLat += rLatency;

    const t2 = performance.now();
    const gResults = grepSearch(q.grepPatterns);
    const gLatency = performance.now() - t2;
    gLat += gLatency;

    const r1 = results.length > 0 && isHit(results[0].filePath, results[0].name, q);
    const r3 = results.slice(0, 3).some((r) => isHit(r.filePath, r.name, q));
    let rRank = 0;
    for (let j = 0; j < results.length; j++) {
      if (isHit(results[j].filePath, results[j].name, q)) {
        rRank = j + 1;
        break;
      }
    }

    const g1 = gResults.length > 0 && q.expectedFiles.some((ef) => gResults[0].endsWith(ef));
    const g3 = gResults.slice(0, 3).some((r) => q.expectedFiles.some((ef) => r.endsWith(ef)));
    let gRank = 0;
    for (let j = 0; j < gResults.length; j++) {
      if (q.expectedFiles.some((ef) => gResults[j].endsWith(ef))) {
        gRank = j + 1;
        break;
      }
    }

    if (r1) rTop1++;
    if (r3) rTop3++;
    if (rRank > 0) rMRR += 1 / rRank;
    if (g1) gTop1++;
    if (g3) gTop3++;
    if (gRank > 0) gMRR += 1 / gRank;

    const rv = r1 ? 3 : r3 ? 2 : 0,
      gv = g1 ? 3 : g3 ? 2 : 0;
    if (rv > gv) rWins++;
    else if (gv > rv) gWins++;
    else tieCount++;

    const ms = q.mode === "semantic" ? mode_s : mode_k;
    ms.n++;
    if (r1) ms.top1++;
    if (r3) ms.top3++;

    const rm = r1 ? "HIT " : r3 ? "top3" : "MISS";
    const gm = g1 ? "HIT " : g3 ? "top3" : "MISS";
    const w = rv > gv ? " ← recall" : gv > rv ? " ← grep" : "";
    console.log(
      `${String(i + 1).padStart(2)}  ${q.mode.padEnd(9)} ${rm}    ${gm}    ${q.query.slice(0, 48)}...${w}`,
    );
  }

  await db.close();
  const n = QUERIES.length;
  console.log(`\n${"=".repeat(95)}`);
  console.log(`RESULTS: ${n} queries on turso/core (173 files, 3578 chunks)`);
  console.log(`${"=".repeat(95)}`);
  console.log(`                    recall (smart)     grep (keywords)`);
  console.log(
    `Top-1 accuracy:     ${((rTop1 / n) * 100).toFixed(0)}% (${rTop1}/${n})${" ".repeat(12)}${((gTop1 / n) * 100).toFixed(0)}% (${gTop1}/${n})`,
  );
  console.log(
    `Top-3 recall:       ${((rTop3 / n) * 100).toFixed(0)}% (${rTop3}/${n})${" ".repeat(12)}${((gTop3 / n) * 100).toFixed(0)}% (${gTop3}/${n})`,
  );
  console.log(
    `MRR:                ${(rMRR / n).toFixed(3)}${" ".repeat(16)}${(gMRR / n).toFixed(3)}`,
  );
  console.log(
    `Avg latency:        ${Math.round(rLat / n)}ms${" ".repeat(17)}${Math.round(gLat / n)}ms`,
  );
  console.log(`\nHead-to-head:       recall wins ${rWins}, grep wins ${gWins}, ties ${tieCount}`);
  console.log(`\nBy mode (recall):`);
  console.log(
    `  semantic:  top1=${mode_s.top1}/${mode_s.n} (${((mode_s.top1 / mode_s.n) * 100).toFixed(0)}%)  top3=${mode_s.top3}/${mode_s.n} (${((mode_s.top3 / mode_s.n) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  keyword:   top1=${mode_k.top1}/${mode_k.n} (${((mode_k.top1 / mode_k.n) * 100).toFixed(0)}%)  top3=${mode_k.top3}/${mode_k.n} (${((mode_k.top3 / mode_k.n) * 100).toFixed(0)}%)`,
  );
}

main().catch(console.error);
