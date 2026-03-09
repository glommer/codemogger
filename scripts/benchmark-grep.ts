#!/usr/bin/env bun
/**
 * Baseline comparison: grep-based code search on turso/core/translate
 *
 * Simulates what AI coding agents do today: extract keywords from the query
 * and grep for them. Measures the same metrics as the recall benchmark.
 */

import { execSync } from "child_process";

interface BenchmarkQuery {
  query: string;
  /** Keywords an agent would realistically grep for */
  grepPatterns: string[];
  expectedFiles: string[];
  expectedNames?: string[];
  category: string;
}

const QUERIES: BenchmarkQuery[] = [
  {
    query: "How does the query optimizer decide whether to use a table scan or an index scan?",
    grepPatterns: ["table_scan", "index_scan", "fn.*scan", "TableScan"],
    expectedFiles: ["optimizer/access_method.rs", "optimizer/mod.rs"],
    category: "access-method",
  },
  {
    query: "What is the cost model used to compare index seek vs full table scan?",
    grepPatterns: ["cost", "estimate_cost", "fn.*cost"],
    expectedFiles: ["optimizer/cost.rs", "optimizer/access_method.rs"],
    category: "access-method",
  },
  {
    query: "How does the optimizer choose between multiple indexes on the same table?",
    grepPatterns: ["multi_index", "choose.*index", "best.*index"],
    expectedFiles: ["optimizer/access_method.rs", "optimizer/mod.rs"],
    category: "access-method",
  },
  {
    query: "How does the query optimizer determine the optimal order to join multiple tables?",
    grepPatterns: ["join_order", "best_join", "fn.*join"],
    expectedFiles: ["optimizer/join.rs"],
    category: "join-order",
  },
  {
    query: "What algorithm is used for computing join order - dynamic programming or greedy?",
    grepPatterns: ["greedy", "dynamic_program", "compute.*join_order"],
    expectedFiles: ["optimizer/join.rs"],
    category: "join-order",
  },
  {
    query: "How are hash joins evaluated as an alternative to nested-loop joins?",
    grepPatterns: ["hash_join", "HashJoin", "nested.*loop"],
    expectedFiles: ["optimizer/access_method.rs", "optimizer/join.rs"],
    category: "join-order",
  },
  {
    query: "How does the optimizer extract usable predicates from a WHERE clause for index seeks?",
    grepPatterns: ["constraints_from_where", "usable_constraints", "where.*clause"],
    expectedFiles: ["optimizer/constraints.rs", "planner.rs"],
    category: "where-clause",
  },
  {
    query: "How does the optimizer handle OR conditions in WHERE clauses?",
    grepPatterns: ["or_term", "OR.*clause", "multi_index_union"],
    expectedFiles: ["optimizer/constraints.rs", "optimizer/access_method.rs"],
    category: "where-clause",
  },
  {
    query: "How are AND conditions optimized with multi-index intersection?",
    grepPatterns: ["intersection", "multi_index_intersection", "and_terms"],
    expectedFiles: ["optimizer/constraints.rs", "optimizer/access_method.rs"],
    category: "where-clause",
  },
  {
    query:
      "How does the query planner determine which WHERE clauses can be evaluated early in the join?",
    grepPatterns: ["where_to_eval", "push.*down", "early.*eval"],
    expectedFiles: ["planner.rs"],
    category: "planning",
  },
  {
    query: "How are aggregate functions compiled in the presence of GROUP BY?",
    grepPatterns: ["group_by", "aggregate", "fn.*agg"],
    expectedFiles: ["aggregation.rs", "group_by.rs"],
    category: "planning",
  },
  {
    query: "How does ORDER BY interact with index selection to avoid sorting?",
    grepPatterns: ["order_target", "satisfies_order", "EliminatesSortBy"],
    expectedFiles: ["optimizer/order.rs"],
    category: "planning",
  },
  {
    query: "How is a SELECT query translated from AST to VDBE bytecode?",
    grepPatterns: ["translate_select", "emit_program", "VDBE"],
    expectedFiles: ["select.rs", "emitter.rs"],
    category: "codegen",
  },
  {
    query: "How are subqueries materialized during query execution?",
    grepPatterns: ["subquery", "materialize", "emit.*subquer"],
    expectedFiles: ["subquery.rs"],
    category: "codegen",
  },
  {
    query: "How are nested loops structured in bytecode generation?",
    grepPatterns: ["open_loop", "close_loop", "emit_loop", "LoopLabels"],
    expectedFiles: ["main_loop.rs"],
    category: "codegen",
  },
  {
    query: "How does the translator handle INSERT with foreign key validation?",
    grepPatterns: ["translate_insert", "fk.*insert", "foreign_key"],
    expectedFiles: ["insert.rs", "fkeys.rs"],
    category: "codegen",
  },
  {
    query: "How are window functions like ROW_NUMBER and RANK implemented?",
    grepPatterns: ["window", "ROW_NUMBER", "RANK", "WindowFunction"],
    expectedFiles: ["window.rs"],
    category: "features",
  },
  {
    query: "How does UNION and INTERSECT work for compound SELECT statements?",
    grepPatterns: ["compound_select", "UNION", "INTERSECT"],
    expectedFiles: ["compound_select.rs"],
    category: "features",
  },
  {
    query: "How are foreign key cascade actions like ON DELETE CASCADE enforced?",
    grepPatterns: ["cascade", "ON DELETE", "fk.*delete"],
    expectedFiles: ["fkeys.rs"],
    category: "features",
  },
  {
    query: "How does CREATE INDEX generate bytecode to populate the index?",
    grepPatterns: ["create_index", "translate_create_index"],
    expectedFiles: ["index.rs"],
    category: "features",
  },
];

const BASE_DIR = "/Users/glaubercosta/recall/turso/core/translate";

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
      // grep failed or timed out
    }
  }

  // Sort by number of pattern matches (most hits first)
  return [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file)
    .slice(0, 5);
}

function isCorrectFile(resultFile: string, expectedFiles: string[]): boolean {
  return expectedFiles.some((ef) => resultFile.endsWith(ef));
}

function main() {
  console.log(`Baseline: grep-based code search on turso/core/translate`);
  console.log(`Queries: ${QUERIES.length}`);
  console.log(`---`);

  let top1Hits = 0;
  let top3Hits = 0;
  let top5Hits = 0;
  let mrrSum = 0;
  let totalLatency = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const start = performance.now();
    const results = grepForPatterns(q.grepPatterns);
    const latency = Math.round(performance.now() - start);
    totalLatency += latency;

    const top1Correct = results.length > 0 && isCorrectFile(results[0], q.expectedFiles);
    const top3Correct = results.slice(0, 3).some((r) => isCorrectFile(r, q.expectedFiles));
    const top5Correct = results.some((r) => isCorrectFile(r, q.expectedFiles));

    let firstCorrectRank = 0;
    for (let j = 0; j < results.length; j++) {
      if (isCorrectFile(results[j], q.expectedFiles)) {
        firstCorrectRank = j + 1;
        break;
      }
    }

    if (top1Correct) top1Hits++;
    if (top3Correct) top3Hits++;
    if (top5Correct) top5Hits++;
    if (firstCorrectRank > 0) mrrSum += 1 / firstCorrectRank;

    const mark = top1Correct ? "HIT" : top3Correct ? "top3" : top5Correct ? "top5" : "MISS";
    console.log(
      `[${String(i + 1).padStart(2)}] ${mark.padEnd(4)} (${latency}ms) ${q.query.slice(0, 70)}...`,
    );
    console.log(`       → ${results.slice(0, 3).join(", ") || "(no results)"}`);
    if (mark === "MISS") {
      console.log(`       expected: ${q.expectedFiles.join(", ")}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULTS — GREP BASELINE (${QUERIES.length} queries)`);
  console.log(`${"=".repeat(70)}`);
  console.log(
    `Top-1 accuracy:  ${top1Hits}/${QUERIES.length} = ${((top1Hits / QUERIES.length) * 100).toFixed(0)}%`,
  );
  console.log(
    `Top-3 recall:    ${top3Hits}/${QUERIES.length} = ${((top3Hits / QUERIES.length) * 100).toFixed(0)}%`,
  );
  console.log(
    `Top-5 recall:    ${top5Hits}/${QUERIES.length} = ${((top5Hits / QUERIES.length) * 100).toFixed(0)}%`,
  );
  console.log(`MRR:             ${(mrrSum / QUERIES.length).toFixed(3)}`);
  console.log(`Avg latency:     ${Math.round(totalLatency / QUERIES.length)}ms`);
}

main();
