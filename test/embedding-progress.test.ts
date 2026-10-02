import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndex, type Embedder } from "../src/index.ts";
import { Store } from "../src/db/store.ts";

// Use the real Store stale/count selectors with an inert SQL connection. Rows
// remain stale after an embed/write failure, exactly as in the persistent store.
function fixtureStore(count: number, rejectWrites = false) {
  const rows = Array.from({ length: count }, (_, i) => ({
    chunk_key: `chunk-${i}`, name: `symbol${i}`, signature: "function fixture()",
    file_path: "/synthetic/fixture.ts", kind: "function", snippet: String(i),
    embedding: null as number[] | null, embedding_model: null as string | null,
  }));
  let reads = 0;
  let finalized = false;
  const db = { prepare: async (sql: string) => ({
    get: async (_codebase: number, model: string) => {
      expect(sql).toContain("COUNT(*)");
      return { cnt: rows.filter(r => r.embedding === null || r.embedding_model !== model).length };
    },
    all: async (_codebase: number, model: string, limit: number) => {
      expect(sql).toContain("embedding IS NULL OR embedding_model != ?");
      expect(sql).toContain("LIMIT ?");
      expect(limit).toBe(1000);
      if (++reads > 4) throw new Error("unbounded stale-row reread detected");
      return rows.filter(r => r.embedding === null || r.embedding_model !== model).slice(0, limit);
    },
  }) };
  const receiver = { db } as unknown as Store;
  return {
    getOrCreateCodebase: async () => 1,
    ensureFtsTable: async () => {},
    countStaleEmbeddings: (id: number, model: string) => Store.prototype.countStaleEmbeddings.call(receiver, id, model),
    getStaleEmbeddings: (id: number, model: string, limit: number) => Store.prototype.getStaleEmbeddings.call(receiver, id, model, limit),
    batchUpsertEmbeddings: async (items: { chunkKey: string; embedding: number[]; modelName: string }[]) => {
      if (rejectWrites) throw new Error("synthetic persistence failure");
      for (const item of items) {
        const row = rows.find(r => r.chunk_key === item.chunkKey)!;
        row.embedding = item.embedding;
        row.embedding_model = item.modelName;
      }
    },
    // Empty temporary scan; cleanup is inert so preseeded synthetic chunks stay.
    removeStaleFiles: async () => 0,
    optimizeFts: async () => {},
    touchCodebase: async () => { finalized = true; },
    remaining: () => rows.filter(r => r.embedding === null).length,
    reads: () => reads,
    finalized: () => finalized,
  };
}

async function run(count: number, embedder: Embedder, rejectWrites = false) {
  const dir = await mkdtemp(join(tmpdir(), "codemogger-progress-"));
  const store = fixtureStore(count, rejectWrites);
  const index = new CodeIndex({ dbPath: ":unused:", embedder, embeddingModel: "synthetic" });
  // Private-store injection avoids opening a DB, initializing parsers or models.
  (index as unknown as { getStore(): Promise<unknown> }).getStore = async () => store;
  try {
    return { result: await index.index(dir), store };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const count of [1000, 1200]) {
  test(`persistent failure terminates with ${count} stale chunks`, async () => {
    let calls = 0;
    const { result, store } = await run(count, async () => {
      calls++;
      throw new Error("synthetic embed failure");
    });
    expect(calls).toBe(16);
    expect(store.reads()).toBe(1);
    expect(store.remaining()).toBe(count);
    expect(result.embedded).toBe(0);
    expect(result.errors.filter(e => e.includes("synthetic embed failure"))).toHaveLength(16);
    expect(result.errors.some(e => e.includes("no progress"))).toBe(true);
    expect(store.finalized()).toBe(true);
  });
}

test("successful pagination embeds all 1200 chunks", async () => {
  const { result, store } = await run(1200, async texts => texts.map(() => [1]));
  expect(result.embedded).toBe(1200);
  expect(result.errors).toHaveLength(0);
  expect(store.remaining()).toBe(0);
  expect(store.reads()).toBe(2);
});

test("partial success is preserved before a permanently failing page stops", async () => {
  let calls = 0;
  const { result, store } = await run(1200, async texts => {
    if (++calls !== 1) throw new Error("synthetic partial failure");
    return texts.map(() => [1]);
  });
  expect(result.embedded).toBe(64);
  expect(store.remaining()).toBe(1136);
  expect(store.reads()).toBe(2);
  expect(result.errors.some(e => e.includes("synthetic partial failure"))).toBe(true);
  expect(result.errors.some(e => e.includes("no progress"))).toBe(true);
});

test("successful embedding with failed persistence also stops without false progress", async () => {
  const { result, store } = await run(1000, async texts => texts.map(() => [1]), true);
  expect(result.embedded).toBe(0);
  expect(store.remaining()).toBe(1000);
  expect(store.reads()).toBe(1);
  expect(result.errors.some(e => e.includes("synthetic persistence failure"))).toBe(true);
  expect(result.errors.some(e => e.includes("no progress"))).toBe(true);
});

test("a short failing page preserves existing error behavior", async () => {
  const { result, store } = await run(20, async () => { throw new Error("short failure"); });
  expect(result.errors).toEqual(["embed batch 1: short failure"]);
  expect(store.reads()).toBe(1);
  expect(store.remaining()).toBe(20);
});
