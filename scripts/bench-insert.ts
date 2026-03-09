#!/usr/bin/env bun
/**
 * Quick benchmark: per-statement vs exec() for bulk inserts in Turso SDK
 */
import { connect } from "@tursodatabase/database";

async function main() {
  const db = await connect("/tmp/bench-insert-test.db", { experimental: ["index_method"] });
  await db.exec("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, val TEXT)");
  await db.exec("DELETE FROM test");

  const N = 500;

  // Method 1: individual prepared statement runs in a transaction
  const t1 = performance.now();
  await db.exec("BEGIN");
  const stmt = await db.prepare("INSERT INTO test (val) VALUES (?)");
  for (let i = 0; i < N; i++) {
    await stmt.run(`value_${i}`);
  }
  await db.exec("COMMIT");
  const method1 = Math.round(performance.now() - t1);
  console.log(
    `Method 1 (prepared + txn): ${method1}ms for ${N} inserts = ${(method1 / N).toFixed(1)}ms/insert`,
  );

  await db.exec("DELETE FROM test");

  // Method 2: exec() with multi-statement string
  const t2 = performance.now();
  let sql = "BEGIN;\n";
  for (let i = 0; i < N; i++) {
    const escaped = `value_${i}`.replace(/'/g, "''");
    sql += `INSERT INTO test (val) VALUES ('${escaped}');\n`;
  }
  sql += "COMMIT;";
  await db.exec(sql);
  const method2 = Math.round(performance.now() - t2);
  console.log(
    `Method 2 (exec multi-stmt): ${method2}ms for ${N} inserts = ${(method2 / N).toFixed(1)}ms/insert`,
  );

  await db.exec("DELETE FROM test");

  // Method 3: single multi-row INSERT
  const t3 = performance.now();
  let multiRow = "INSERT INTO test (val) VALUES ";
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(`('value_${i}')`);
  }
  multiRow += rows.join(", ");
  await db.exec(multiRow);
  const method3 = Math.round(performance.now() - t3);
  console.log(
    `Method 3 (multi-row VALUES): ${method3}ms for ${N} inserts = ${(method3 / N).toFixed(1)}ms/insert`,
  );

  db.close();
}

main().catch(console.error);
