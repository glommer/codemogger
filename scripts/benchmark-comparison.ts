#!/usr/bin/env bun
/**
 * Head-to-head comparison: recall vs grep on the same queries.
 * Shows where each approach wins and loses.
 */

// Manually compiled from both benchmark runs:
const results = [
  {
    id: 1,
    query: "optimizer: table scan vs index scan",
    recall: "MISS",
    grep: "top5",
    recallTop1: "select.rs",
    grepTop1: "fkeys.rs",
  },
  {
    id: 2,
    query: "cost model: index seek vs table scan",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "optimizer/cost.rs",
    grepTop1: "optimizer/access_method.rs",
  },
  {
    id: 3,
    query: "choose between multiple indexes",
    recall: "HIT",
    grep: "top3",
    recallTop1: "optimizer/access_method.rs",
    grepTop1: "optimizer/join.rs",
  },
  {
    id: 4,
    query: "optimal join order for tables",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "optimizer/join.rs",
    grepTop1: "optimizer/join.rs",
  },
  {
    id: 5,
    query: "join order: DP or greedy?",
    recall: "top3",
    grep: "HIT",
    recallTop1: "optimizer/order.rs",
    grepTop1: "optimizer/join.rs",
  },
  {
    id: 6,
    query: "hash joins vs nested-loop joins",
    recall: "top3",
    grep: "HIT",
    recallTop1: "plan.rs",
    grepTop1: "optimizer/join.rs",
  },
  {
    id: 7,
    query: "extract WHERE predicates for index",
    recall: "HIT",
    grep: "top3",
    recallTop1: "optimizer/constraints.rs",
    grepTop1: "optimizer/join.rs",
  },
  {
    id: 8,
    query: "OR conditions in WHERE",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "optimizer/constraints.rs",
    grepTop1: "optimizer/access_method.rs",
  },
  {
    id: 9,
    query: "AND + multi-index intersection",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "optimizer/access_method.rs",
    grepTop1: "optimizer/access_method.rs",
  },
  {
    id: 10,
    query: "WHERE eval early in join",
    recall: "MISS",
    grep: "top3",
    recallTop1: "plan.rs",
    grepTop1: "plan.rs",
  },
  {
    id: 11,
    query: "aggregate + GROUP BY",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "group_by.rs",
    grepTop1: "group_by.rs",
  },
  {
    id: 12,
    query: "ORDER BY + index to avoid sort",
    recall: "MISS",
    grep: "HIT",
    recallTop1: "order_by.rs",
    grepTop1: "optimizer/order.rs",
  },
  {
    id: 13,
    query: "SELECT → VDBE bytecode",
    recall: "HIT",
    grep: "top3",
    recallTop1: "select.rs",
    grepTop1: "mod.rs",
  },
  {
    id: 14,
    query: "subquery materialization",
    recall: "top3",
    grep: "top5",
    recallTop1: "plan.rs",
    grepTop1: "main_loop.rs",
  },
  {
    id: 15,
    query: "nested loops in bytecode",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "main_loop.rs",
    grepTop1: "main_loop.rs",
  },
  {
    id: 16,
    query: "INSERT + foreign key",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "insert.rs",
    grepTop1: "insert.rs",
  },
  {
    id: 17,
    query: "window functions ROW_NUMBER",
    recall: "top3",
    grep: "MISS",
    recallTop1: "plan.rs",
    grepTop1: "plan.rs",
  },
  {
    id: 18,
    query: "UNION/INTERSECT compound",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "compound_select.rs",
    grepTop1: "compound_select.rs",
  },
  {
    id: 19,
    query: "ON DELETE CASCADE",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "fkeys.rs",
    grepTop1: "fkeys.rs",
  },
  {
    id: 20,
    query: "CREATE INDEX bytecode",
    recall: "HIT",
    grep: "HIT",
    recallTop1: "index.rs",
    grepTop1: "index.rs",
  },
];

console.log("HEAD-TO-HEAD: recall (vector) vs grep (keywords)");
console.log("=".repeat(70));
console.log();

// Cases where recall wins
const recallWins = results.filter((r) => {
  const recallScore =
    r.recall === "HIT" ? 3 : r.recall === "top3" ? 2 : r.recall === "top5" ? 1 : 0;
  const grepScore = r.grep === "HIT" ? 3 : r.grep === "top3" ? 2 : r.grep === "top5" ? 1 : 0;
  return recallScore > grepScore;
});

const grepWins = results.filter((r) => {
  const recallScore =
    r.recall === "HIT" ? 3 : r.recall === "top3" ? 2 : r.recall === "top5" ? 1 : 0;
  const grepScore = r.grep === "HIT" ? 3 : r.grep === "top3" ? 2 : r.grep === "top5" ? 1 : 0;
  return grepScore > recallScore;
});

const ties = results.filter((r) => {
  const recallScore =
    r.recall === "HIT" ? 3 : r.recall === "top3" ? 2 : r.recall === "top5" ? 1 : 0;
  const grepScore = r.grep === "HIT" ? 3 : r.grep === "top3" ? 2 : r.grep === "top5" ? 1 : 0;
  return recallScore === grepScore;
});

console.log(`recall wins: ${recallWins.length}`);
for (const r of recallWins) {
  console.log(`  [${r.id}] ${r.query} — recall=${r.recall} grep=${r.grep}`);
  console.log(`       recall→${r.recallTop1}  grep→${r.grepTop1}`);
}

console.log(`\ngrep wins: ${grepWins.length}`);
for (const r of grepWins) {
  console.log(`  [${r.id}] ${r.query} — recall=${r.recall} grep=${r.grep}`);
  console.log(`       recall→${r.recallTop1}  grep→${r.grepTop1}`);
}

console.log(`\nties: ${ties.length}`);
for (const r of ties) {
  console.log(`  [${r.id}] ${r.query} — both=${r.recall}`);
}

console.log(`\n${"=".repeat(70)}`);
console.log(`KEY INSIGHT: grep uses hand-crafted patterns that require knowing the code.`);
console.log(`recall uses raw natural language — no domain knowledge required.`);
console.log(`On a 45-file codebase, they perform similarly.`);
console.log(`The value gap should widen on larger codebases (500+ files)`);
console.log(`where grep patterns produce too many false positives.`);
