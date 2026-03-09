#!/usr/bin/env bun
/**
 * Benchmark: recall code search vs grep on turso/core/translate (45 Rust files, 753 chunks)
 *
 * Measures:
 *  - Top-1 accuracy: Is the best result in the expected file?
 *  - Top-3 recall: Is any of top-3 in the expected file?
 *  - Top-5 recall: Is any of top-5 in the expected file?
 *  - Mean Reciprocal Rank (MRR): 1/rank of first correct result
 *  - Search latency
 */

import { CodeIndex } from "../src/index.ts";

interface BenchmarkQuery {
  query: string;
  /** Files that count as correct (relative paths from turso/core/translate/) */
  expectedFiles: string[];
  /** Optional: specific function/struct names that count as correct */
  expectedNames?: string[];
  category: string;
}

const QUERIES: BenchmarkQuery[] = [
  // Category 1: Access Method Selection
  {
    query: "How does the query optimizer decide whether to use a table scan or an index scan?",
    expectedFiles: ["optimizer/access_method.rs", "optimizer/mod.rs"],
    expectedNames: [
      "find_best_access_method_for_join_order",
      "AccessMethod",
      "optimize_table_access",
    ],
    category: "access-method",
  },
  {
    query: "What is the cost model used to compare index seek vs full table scan?",
    expectedFiles: ["optimizer/cost.rs", "optimizer/access_method.rs"],
    expectedNames: ["estimate_cost_for_scan_or_seek", "Cost", "IndexInfo"],
    category: "access-method",
  },
  {
    query: "How does the optimizer choose between multiple indexes on the same table?",
    expectedFiles: ["optimizer/access_method.rs", "optimizer/mod.rs"],
    expectedNames: ["find_best_access_method_for_join_order", "optimize_table_access"],
    category: "access-method",
  },

  // Category 2: Join Order Optimization
  {
    query: "How does the query optimizer determine the optimal order to join multiple tables?",
    expectedFiles: ["optimizer/join.rs"],
    expectedNames: ["compute_best_join_order", "join_lhs_and_rhs", "JoinN"],
    category: "join-order",
  },
  {
    query: "What algorithm is used for computing join order - dynamic programming or greedy?",
    expectedFiles: ["optimizer/join.rs"],
    expectedNames: [
      "compute_best_join_order",
      "compute_greedy_join_order",
      "compute_naive_left_deep_plan",
    ],
    category: "join-order",
  },
  {
    query: "How are hash joins evaluated as an alternative to nested-loop joins?",
    expectedFiles: ["optimizer/access_method.rs", "optimizer/join.rs"],
    expectedNames: ["try_hash_join_access_method", "HashJoin"],
    category: "join-order",
  },

  // Category 3: WHERE Clause Analysis
  {
    query: "How does the optimizer extract usable predicates from a WHERE clause for index seeks?",
    expectedFiles: ["optimizer/constraints.rs", "planner.rs"],
    expectedNames: [
      "constraints_from_where_clause",
      "usable_constraints_for_join_order",
      "parse_where",
    ],
    category: "where-clause",
  },
  {
    query: "How does the optimizer handle OR conditions in WHERE clauses?",
    expectedFiles: ["optimizer/constraints.rs", "optimizer/access_method.rs"],
    expectedNames: ["analyze_or_term_for_multi_index", "consider_multi_index_union"],
    category: "where-clause",
  },
  {
    query: "How are AND conditions optimized with multi-index intersection?",
    expectedFiles: ["optimizer/constraints.rs", "optimizer/access_method.rs"],
    expectedNames: ["analyze_and_terms_for_multi_index", "consider_multi_index_intersection"],
    category: "where-clause",
  },

  // Category 4: Query Planning & Execution
  {
    query:
      "How does the query planner determine which WHERE clauses can be evaluated early in the join?",
    expectedFiles: ["planner.rs"],
    expectedNames: ["determine_where_to_eval_term", "parse_where"],
    category: "planning",
  },
  {
    query: "How are aggregate functions compiled in the presence of GROUP BY?",
    expectedFiles: ["aggregation.rs", "group_by.rs"],
    expectedNames: [
      "emit_ungrouped_aggregation",
      "group_by_process_single_group",
      "translate_aggregation_step",
      "group_by_agg_phase",
    ],
    category: "planning",
  },
  {
    query: "How does ORDER BY interact with index selection to avoid sorting?",
    expectedFiles: ["optimizer/order.rs"],
    expectedNames: ["compute_order_target", "plan_satisfies_order_target", "EliminatesSortBy"],
    category: "planning",
  },

  // Category 5: Code Generation & Bytecode
  {
    query: "How is a SELECT query translated from AST to VDBE bytecode?",
    expectedFiles: ["select.rs", "emitter.rs"],
    expectedNames: ["translate_select", "emit_program_for_select", "emit_query"],
    category: "codegen",
  },
  {
    query: "How are subqueries materialized during query execution?",
    expectedFiles: ["subquery.rs"],
    expectedNames: [
      "emit_from_clause_subqueries",
      "emit_non_from_clause_subquery",
      "plan_subqueries_from_select_plan",
    ],
    category: "codegen",
  },
  {
    query: "How are nested loops structured in bytecode generation?",
    expectedFiles: ["main_loop.rs"],
    expectedNames: ["init_loop", "open_loop", "emit_loop", "close_loop"],
    category: "codegen",
  },
  {
    query: "How does the translator handle INSERT with foreign key validation?",
    expectedFiles: ["insert.rs", "fkeys.rs"],
    expectedNames: ["translate_insert", "emit_fk_child_insert_checks"],
    category: "codegen",
  },

  // Category 6: Specific Features
  {
    query: "How are window functions like ROW_NUMBER and RANK implemented?",
    expectedFiles: ["window.rs"],
    expectedNames: ["plan_windows", "init_window", "emit_window_results", "WindowMetadata"],
    category: "features",
  },
  {
    query: "How does UNION and INTERSECT work for compound SELECT statements?",
    expectedFiles: ["compound_select.rs"],
    expectedNames: ["emit_program_for_compound_select"],
    category: "features",
  },
  {
    query: "How are foreign key cascade actions like ON DELETE CASCADE enforced?",
    expectedFiles: ["fkeys.rs"],
    expectedNames: ["fire_fk_delete_actions", "emit_parent_key_change_checks"],
    category: "features",
  },
  {
    query: "How does CREATE INDEX generate bytecode to populate the index?",
    expectedFiles: ["index.rs"],
    expectedNames: ["translate_create_index", "resolve_sorted_columns"],
    category: "features",
  },
];

function isCorrectFile(resultFile: string, expectedFiles: string[]): boolean {
  return expectedFiles.some((ef) => resultFile.endsWith(ef));
}

function isCorrectName(resultName: string, expectedNames?: string[]): boolean {
  if (!expectedNames) return false;
  return expectedNames.some((en) => resultName === en || resultName.includes(en));
}

async function main() {
  const dbPath = process.argv[2] || "/tmp/recall-test.db";
  console.log(`Benchmark: recall code search on turso/core/translate`);
  console.log(`Database: ${dbPath}`);
  console.log(`Queries: ${QUERIES.length}`);
  console.log(`---`);

  const db = new CodeIndex({ dbPath });

  let top1Hits = 0;
  let top3Hits = 0;
  let top5Hits = 0;
  let mrrSum = 0;
  let totalLatency = 0;
  const categoryStats = new Map<string, { top1: number; top3: number; total: number }>();

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const start = performance.now();
    const results = await db.search(q.query, { limit: 5, includeSnippet: false });
    const latency = Math.round(performance.now() - start);
    totalLatency += latency;

    // Check results against expected
    let firstCorrectRank = 0;
    const top1Correct =
      results.length > 0 &&
      (isCorrectFile(results[0].filePath, q.expectedFiles) ||
        isCorrectName(results[0].name, q.expectedNames));

    const top3Correct = results
      .slice(0, 3)
      .some(
        (r) => isCorrectFile(r.filePath, q.expectedFiles) || isCorrectName(r.name, q.expectedNames),
      );

    const top5Correct = results.some(
      (r) => isCorrectFile(r.filePath, q.expectedFiles) || isCorrectName(r.name, q.expectedNames),
    );

    // Find rank of first correct result for MRR
    for (let j = 0; j < results.length; j++) {
      if (
        isCorrectFile(results[j].filePath, q.expectedFiles) ||
        isCorrectName(results[j].name, q.expectedNames)
      ) {
        firstCorrectRank = j + 1;
        break;
      }
    }

    if (top1Correct) top1Hits++;
    if (top3Correct) top3Hits++;
    if (top5Correct) top5Hits++;
    if (firstCorrectRank > 0) mrrSum += 1 / firstCorrectRank;

    // Category tracking
    const cat = categoryStats.get(q.category) || { top1: 0, top3: 0, total: 0 };
    cat.total++;
    if (top1Correct) cat.top1++;
    if (top3Correct) cat.top3++;
    categoryStats.set(q.category, cat);

    // Print per-query result
    const mark = top1Correct ? "HIT" : top3Correct ? "top3" : top5Correct ? "top5" : "MISS";
    const resultSummary = results
      .slice(0, 3)
      .map((r) => `${r.name || r.kind}@${r.filePath}`)
      .join(", ");
    console.log(
      `[${String(i + 1).padStart(2)}] ${mark.padEnd(4)} (${latency}ms) ${q.query.slice(0, 70)}...`,
    );
    console.log(`       → ${resultSummary}`);
    if (mark === "MISS") {
      console.log(`       expected: ${q.expectedFiles.join(", ")}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULTS (${QUERIES.length} queries)`);
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
  console.log(`Total latency:   ${totalLatency}ms`);

  console.log(`\nBy category:`);
  for (const [cat, stats] of categoryStats) {
    console.log(
      `  ${cat.padEnd(16)} top1=${stats.top1}/${stats.total} top3=${stats.top3}/${stats.total}`,
    );
  }

  await db.close();
}

main().catch(console.error);
