#!/usr/bin/env bun
/**
 * Compare FTS configurations for keyword search quality + latency
 * Tests: FTS on name+signature+snippet vs FTS on name+signature only
 */

import { connect } from "@tursodatabase/database";

interface Query {
  query: string;
  expectedFiles: string[];
  expectedNames?: string[];
}

const KEYWORD_QUERIES: Query[] = [
  {
    query: "Searcher",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["Searcher"],
  },
  {
    query: "SearcherBuilder",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["SearcherBuilder"],
  },
  {
    query: "RegexMatcher",
    expectedFiles: ["crates/regex/src/matcher.rs"],
    expectedNames: ["RegexMatcher"],
  },
  {
    query: "Standard printer",
    expectedFiles: ["crates/printer/src/standard.rs"],
    expectedNames: ["Standard"],
  },
  { query: "JSON printer", expectedFiles: ["crates/printer/src/json.rs"], expectedNames: ["JSON"] },
  {
    query: "Summary printer",
    expectedFiles: ["crates/printer/src/summary.rs"],
    expectedNames: ["Summary"],
  },
  {
    query: "WalkBuilder",
    expectedFiles: ["crates/ignore/src/walk.rs"],
    expectedNames: ["WalkBuilder"],
  },
  {
    query: "DirEntry",
    expectedFiles: ["crates/ignore/src/walk.rs", "crates/ignore/src/dir.rs"],
    expectedNames: ["DirEntry"],
  },
  { query: "GlobSet", expectedFiles: ["crates/globset/src/lib.rs"], expectedNames: ["GlobSet"] },
  {
    query: "LineStep",
    expectedFiles: ["crates/searcher/src/lines.rs", "crates/searcher/src/line_buffer.rs"],
    expectedNames: ["LineStep"],
  },
  {
    query: "BinaryDetection",
    expectedFiles: ["crates/searcher/src/searcher/mod.rs"],
    expectedNames: ["BinaryDetection"],
  },
  {
    query: "MmapChoice",
    expectedFiles: ["crates/searcher/src/searcher/mmap.rs"],
    expectedNames: ["MmapChoice"],
  },
  { query: "Captures", expectedFiles: ["crates/matcher/src/lib.rs"], expectedNames: ["Captures"] },
  { query: "Sink", expectedFiles: ["crates/searcher/src/sink.rs"], expectedNames: ["Sink"] },
  {
    query: "MultiLine",
    expectedFiles: ["crates/searcher/src/searcher/glue.rs"],
    expectedNames: ["MultiLine"],
  },
];

function isHit(filePath: string, name: string, q: Query): boolean {
  const fileMatch = q.expectedFiles.some((ef) => filePath.endsWith(ef));
  const nameMatch = q.expectedNames?.some((en) => name === en || name.includes(en)) ?? false;
  return fileMatch || nameMatch;
}

async function runFtsTest(dbPath: string, ftsColumns: string, indexSql: string, label: string) {
  // Copy the DB and create the specific FTS index
  const testDb = `/tmp/rg-fts-test.db`;
  const { execSync } = await import("child_process");
  execSync(`cp "${dbPath}" "${testDb}"`);

  const db = await connect(testDb, { experimental: ["index_method"] });

  // Drop any existing FTS index
  await db.exec("DROP INDEX IF EXISTS idx_chunks_fts");
  await db.exec("DROP INDEX IF EXISTS idx_chunks_fts_slim");
  await db.exec("DROP INDEX IF EXISTS idx_chunks_fts_full");

  // Build new index
  const buildStart = performance.now();
  await db.exec(indexSql);
  const buildTime = Math.round(performance.now() - buildStart);

  // Run keyword queries
  let top1 = 0,
    top3 = 0,
    totalLatency = 0;

  for (const q of KEYWORD_QUERIES) {
    const t = performance.now();
    try {
      const rows = (await db
        .prepare(
          `SELECT file_path, name, kind FROM chunks
         WHERE fts_match(${ftsColumns}, ?)
         ORDER BY fts_score(${ftsColumns}, ?) DESC
         LIMIT 5`,
        )
        .all(q.query, q.query)) as any[];
      const latency = performance.now() - t;
      totalLatency += latency;

      const hit1 = rows.length > 0 && isHit(rows[0].file_path, rows[0].name, q);
      const hit3 = rows.slice(0, 3).some((r: any) => isHit(r.file_path, r.name, q));
      if (hit1) top1++;
      if (hit3) top3++;
    } catch (e: any) {
      totalLatency += performance.now() - t;
      // FTS query failed
    }
  }

  const n = KEYWORD_QUERIES.length;
  console.log(`${label}:`);
  console.log(`  Index build:  ${buildTime}ms`);
  console.log(`  Top-1:        ${top1}/${n} (${((top1 / n) * 100).toFixed(0)}%)`);
  console.log(`  Top-3:        ${top3}/${n} (${((top3 / n) * 100).toFixed(0)}%)`);
  console.log(`  Avg latency:  ${Math.round(totalLatency / n)}ms`);

  db.close();
  execSync(`rm -f "${testDb}"`);
}

async function main() {
  const dbPath = "/tmp/rg.db";

  console.log(`FTS keyword search comparison on ripgrep (${KEYWORD_QUERIES.length} queries)\n`);

  await runFtsTest(
    dbPath,
    "name, signature, snippet",
    `CREATE INDEX idx_chunks_fts_full ON chunks
     USING fts (name, signature, snippet)
     WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0,snippet=1.0')`,
    "FTS on name + signature + snippet",
  );

  console.log();

  await runFtsTest(
    dbPath,
    "name, signature",
    `CREATE INDEX idx_chunks_fts_slim ON chunks
     USING fts (name, signature)
     WITH (tokenizer = 'default', weights = 'name=5.0,signature=3.0')`,
    "FTS on name + signature only",
  );
}

main().catch(console.error);
