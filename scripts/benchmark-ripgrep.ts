#!/usr/bin/env bun
/**
 * Smart agent benchmark on ripgrep (100 files, 1272 chunks)
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
  // --- SEMANTIC ---
  {
    query: "How does ripgrep detect binary files during search?",
    mode: "semantic",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["BinaryDetection"],
    grepPatterns: ["BinaryDetection", "binary_detection"],
    category: "searcher",
  },
  {
    query: "How does the searcher choose between memory mapping and buffered IO?",
    mode: "semantic",
    expectedFiles: ["crates/searcher/src/searcher/mmap.rs"],
    expectedNames: ["MmapChoice"],
    grepPatterns: ["MmapChoice", "mmap"],
    category: "searcher",
  },
  {
    query: "How are context lines before and after matches handled?",
    mode: "semantic",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["before_context", "after_context", "SearcherBuilder"],
    grepPatterns: ["before_context", "after_context"],
    category: "searcher",
  },
  {
    query: "How does the Sink trait connect the searcher to the printer?",
    mode: "semantic",
    expectedFiles: ["crates/searcher/src/sink.rs"],
    expectedNames: ["Sink", "SinkMatch", "SinkContext"],
    grepPatterns: ["trait Sink", "SinkMatch", "SinkContext"],
    category: "printer",
  },
  {
    query: "How does gitignore filtering work during directory traversal?",
    mode: "semantic",
    expectedFiles: ["crates/ignore/src/walk.rs", "crates/ignore/src/lib.rs"],
    expectedNames: ["WalkBuilder", "Walk"],
    grepPatterns: ["gitignore", "WalkBuilder", "ignore_hidden"],
    category: "ignore",
  },
  {
    query: "How does multi-line search handle buffer boundaries?",
    mode: "semantic",
    expectedFiles: ["crates/searcher/src/searcher/glue.rs"],
    expectedNames: ["MultiLine"],
    grepPatterns: ["MultiLine", "multi_line", "fn glue"],
    category: "searcher",
  },
  {
    query: "How does ripgrep search files in parallel across threads?",
    mode: "semantic",
    expectedFiles: ["crates/core/main.rs"],
    expectedNames: ["search_parallel"],
    grepPatterns: ["search_parallel", "parallel"],
    category: "core",
  },
  {
    query: "What optimizations does the regex matcher apply during compilation?",
    mode: "semantic",
    expectedFiles: ["crates/regex/src/matcher.rs"],
    expectedNames: ["RegexMatcher", "RegexMatcherBuilder"],
    grepPatterns: ["RegexMatcherBuilder", "build"],
    category: "regex",
  },
  {
    query: "How are capture groups extracted and used for replacement patterns?",
    mode: "semantic",
    expectedFiles: ["crates/matcher/src/lib.rs", "crates/matcher/src/interpolate.rs"],
    expectedNames: ["Captures", "interpolate"],
    grepPatterns: ["Captures", "interpolate", "capture"],
    category: "matcher",
  },
  {
    query: "How does the glob pattern matching engine work?",
    mode: "semantic",
    expectedFiles: ["crates/globset/src/lib.rs", "crates/globset/src/glob.rs"],
    expectedNames: ["GlobSet", "Glob", "GlobMatcher"],
    grepPatterns: ["struct GlobSet", "GlobMatcher"],
    category: "globset",
  },

  // --- KEYWORD ---
  {
    query: "Searcher",
    mode: "keyword",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["Searcher"],
    grepPatterns: ["struct Searcher"],
    category: "searcher",
  },
  {
    query: "SearcherBuilder",
    mode: "keyword",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["SearcherBuilder"],
    grepPatterns: ["struct SearcherBuilder"],
    category: "searcher",
  },
  {
    query: "RegexMatcher",
    mode: "keyword",
    expectedFiles: ["crates/regex/src/matcher.rs"],
    expectedNames: ["RegexMatcher"],
    grepPatterns: ["struct RegexMatcher"],
    category: "regex",
  },
  {
    query: "Standard printer",
    mode: "keyword",
    expectedFiles: ["crates/printer/src/standard.rs"],
    expectedNames: ["Standard"],
    grepPatterns: ["struct Standard"],
    category: "printer",
  },
  {
    query: "JSON printer",
    mode: "keyword",
    expectedFiles: ["crates/printer/src/json.rs"],
    expectedNames: ["JSON"],
    grepPatterns: ["struct JSON"],
    category: "printer",
  },
  {
    query: "Summary printer",
    mode: "keyword",
    expectedFiles: ["crates/printer/src/summary.rs"],
    expectedNames: ["Summary"],
    grepPatterns: ["struct Summary"],
    category: "printer",
  },
  {
    query: "WalkBuilder",
    mode: "keyword",
    expectedFiles: ["crates/ignore/src/walk.rs"],
    expectedNames: ["WalkBuilder"],
    grepPatterns: ["struct WalkBuilder"],
    category: "ignore",
  },
  {
    query: "DirEntry",
    mode: "keyword",
    expectedFiles: ["crates/ignore/src/walk.rs", "crates/ignore/src/dir.rs"],
    expectedNames: ["DirEntry"],
    grepPatterns: ["struct DirEntry"],
    category: "ignore",
  },
  {
    query: "GlobSet",
    mode: "keyword",
    expectedFiles: ["crates/globset/src/lib.rs"],
    expectedNames: ["GlobSet"],
    grepPatterns: ["struct GlobSet"],
    category: "globset",
  },
  {
    query: "LineStep",
    mode: "keyword",
    expectedFiles: ["crates/searcher/src/lines.rs", "crates/searcher/src/line_buffer.rs"],
    expectedNames: ["LineStep"],
    grepPatterns: ["LineStep"],
    category: "searcher",
  },
];

const BASE_DIR = "/Users/glaubercosta/recall/ripgrep";

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
  const dbPath = process.argv[2] || "/tmp/rg.db";
  const semN = QUERIES.filter((q) => q.mode === "semantic").length;
  const kwN = QUERIES.filter((q) => q.mode === "keyword").length;
  console.log(`Ripgrep benchmark: ${QUERIES.length} queries (${semN} semantic, ${kwN} keyword)`);
  console.log(`Database: ${dbPath}\n`);

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
    rLat += performance.now() - t1;

    const t2 = performance.now();
    const gResults = grepSearch(q.grepPatterns);
    gLat += performance.now() - t2;

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
  console.log(`RESULTS: ${n} queries on ripgrep (100 files, 1272 chunks)`);
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
