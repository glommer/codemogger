import { connect } from "@tursodatabase/database"
import {
  ALL_SCHEMA,
  CREATE_CHUNKS_FILE_INDEX,
  ftsTableName,
  createFtsTableSQL,
  createFtsIndexSQL,
  populateFtsForFileSQL,
} from "./schema.ts"
import type { CodeChunk } from "../chunk/types.ts"

// Private row types for database query results — keeps column renames type-safe.
type CodebaseRow = { id: number; root_path: string; name: string; indexed_at: number; file_count: number; chunk_count: number }
type StaleEmbeddingRow = { chunk_key: string; name: string; signature: string; file_path: string; kind: string; snippet: string }
type VectorSearchRow = { chunk_key: string; file_path: string; name: string; kind: string; signature: string; snippet: string; start_line: number; end_line: number; distance: number }
type ChunkDataRow = { chunk_key: string; file_path: string; name: string; kind: string; signature: string; start_line: number; end_line: number }
type IndexedFileRow = { file_path: string; file_hash: string; chunk_count: number; indexed_at: number }

export interface SearchResult {
  chunkKey: string
  filePath: string
  name: string
  kind: string
  signature: string
  snippet: string
  startLine: number
  endLine: number
  score: number
}

export interface IndexedFile {
  filePath: string
  fileHash: string
  chunkCount: number
  indexedAt: number
}

export interface Codebase {
  id: number
  rootPath: string
  name: string
  indexedAt: number
  fileCount: number
  chunkCount: number
}

export class Store {
  private db: Awaited<ReturnType<typeof connect>>
  private initialized = false

  private constructor(db: Awaited<ReturnType<typeof connect>>) {
    this.db = db
  }

  static async open(dbPath: string): Promise<Store> {
    const db = await connect(dbPath, {
      experimental: ["index_method", "multiprocess_wal"],
    })
    const store = new Store(db)
    await store.init()
    return store
  }

  private async init(): Promise<void> {
    if (this.initialized) return
    for (const sql of ALL_SCHEMA) {
      await this.db.exec(sql)
    }
    this.initialized = true
  }

  // ── Codebase management ──────────────────────────────────────────

  /** Get or create a codebase entry, returns its id */
  async getOrCreateCodebase(rootPath: string, name?: string): Promise<number> {
    // Index provision belongs to the indexing/write route, not ordinary reads.
    await this.db.exec(CREATE_CHUNKS_FILE_INDEX)
    const row = await (await this.db.prepare("SELECT id FROM codebases WHERE root_path = ?")).get(rootPath) as { id: number } | undefined

    if (row) return row.id

    await (await this.db.prepare("INSERT INTO codebases (root_path, name, indexed_at) VALUES (?, ?, ?)")).run(rootPath, name ?? rootPath.split("/").pop() ?? "", Date.now())

    const inserted = await (await this.db.prepare("SELECT id FROM codebases WHERE root_path = ?")).get(rootPath) as { id: number }
    return inserted.id
  }

  /** List all codebases */
  async listCodebases(): Promise<Codebase[]> {
    const rows = await (await this.db.prepare(`SELECT c.id, c.root_path, c.name, c.indexed_at,
              COUNT(DISTINCT f.file_path) as file_count,
              COALESCE(SUM(f.chunk_count), 0) as chunk_count
       FROM codebases c
       LEFT JOIN indexed_files f ON f.codebase_id = c.id
       GROUP BY c.id
       ORDER BY c.root_path`)).all() as CodebaseRow[]
    return rows.map(r => ({
      id: r.id,
      rootPath: r.root_path,
      name: r.name,
      indexedAt: r.indexed_at,
      fileCount: r.file_count,
      chunkCount: r.chunk_count,
    }))
  }

  /** Update codebase indexed_at timestamp */
  async touchCodebase(codebaseId: number): Promise<void> {
    await (await this.db.prepare("UPDATE codebases SET indexed_at = ? WHERE id = ?")).run(Date.now(), codebaseId)
  }

  // ── File hash management ─────────────────────────────────────────

  /** Get stored hash only when its persisted chunk count is consistent. */
  async getFileHash(codebaseId: number, filePath: string): Promise<string | null> {
    // Older line-only identities could overwrite distinct chunks. Returning null
    // reparses affected files even when the source itself has not changed.
    const row = await (await this.db.prepare(`
      SELECT f.file_hash FROM indexed_files f
      WHERE f.codebase_id = ? AND f.file_path = ?
        AND f.chunk_count = (
          SELECT COUNT(*) FROM chunks c
          WHERE c.codebase_id = f.codebase_id AND c.file_path = f.file_path
        )
    `)).get(codebaseId, filePath) as { file_hash: string } | undefined
    return row?.file_hash ?? null
  }

  // ── Chunk writes ─────────────────────────────────────────────────

  /** Batch insert chunks for multiple files in one transaction */
  async batchUpsertAllFileChunks(
    codebaseId: number,
    fileChunks: { filePath: string; fileHash: string; chunks: CodeChunk[] }[],
  ): Promise<void> {
    await this.db.exec("BEGIN")
    try {
      const now = Date.now()
      const deleteStmt = await this.db.prepare(
        "DELETE FROM chunks WHERE codebase_id = ? AND file_path = ?"
      )
      const insertStmt = await this.db.prepare(`
        INSERT INTO chunks (codebase_id, file_path, chunk_key, language, kind, name, signature, snippet, start_line, end_line, file_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_key) DO UPDATE SET
          codebase_id = excluded.codebase_id,
          language = excluded.language,
          kind = excluded.kind,
          name = excluded.name,
          signature = excluded.signature,
          snippet = excluded.snippet,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          file_hash = excluded.file_hash,
          indexed_at = excluded.indexed_at,
          embedding = NULL,
          embedding_model = ''
      `)
      const fileStmt = await this.db.prepare(`
        INSERT INTO indexed_files (codebase_id, file_path, file_hash, chunk_count, indexed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(codebase_id, file_path) DO UPDATE SET
          file_hash = excluded.file_hash,
          chunk_count = excluded.chunk_count,
          indexed_at = excluded.indexed_at
      `)

      for (const { filePath, fileHash, chunks } of fileChunks) {
        await deleteStmt.run(codebaseId, filePath)
        for (const chunk of chunks) {
          await insertStmt.run(
            codebaseId,
            chunk.filePath,
            chunk.chunkKey,
            chunk.language,
            chunk.kind,
            chunk.name,
            chunk.signature,
            chunk.snippet,
            chunk.startLine,
            chunk.endLine,
            chunk.fileHash,
            now,
          )
        }
        await fileStmt.run(codebaseId, filePath, fileHash, chunks.length, now)
      }
      await this.db.exec("COMMIT")
    } catch (e) {
      await this.db.exec("ROLLBACK")
      throw e
    }
  }

  /** Remove all chunks and file records for a codebase */
  async removeCodebaseChunks(codebaseId: number): Promise<void> {
    await (await this.db.prepare("DELETE FROM chunks WHERE codebase_id = ?")).run(codebaseId)
    await (await this.db.prepare("DELETE FROM indexed_files WHERE codebase_id = ?")).run(codebaseId)
  }

  /** Remove files that are no longer on disk (scoped to codebase) */
  async removeStaleFiles(codebaseId: number, activeFiles: Set<string>): Promise<number> {
    const all = await (await this.db.prepare("SELECT file_path FROM indexed_files WHERE codebase_id = ?")).all(codebaseId) as { file_path: string }[]
    let removed = 0
    await this.db.exec("BEGIN")
    try {
      for (const row of all) {
        if (!activeFiles.has(row.file_path)) {
          await (await this.db.prepare("DELETE FROM chunks WHERE codebase_id = ? AND file_path = ?")).run(codebaseId, row.file_path)
          await (await this.db.prepare("DELETE FROM indexed_files WHERE codebase_id = ? AND file_path = ?")).run(codebaseId, row.file_path)
          removed++
        }
      }
      await this.db.exec("COMMIT")
    } catch (e) {
      await this.db.exec("ROLLBACK")
      throw e
    }
    return removed
  }

  // ── Embedding management ─────────────────────────────────────────

  /** Batch store embeddings */
  async batchUpsertEmbeddings(items: { chunkKey: string; embedding: number[]; modelName: string }[]): Promise<void> {
    if (items.length === 0) return
    await this.db.exec("BEGIN")
    try {
      for (const item of items) {
        const json = JSON.stringify(item.embedding)
        await (await this.db.prepare(`UPDATE chunks SET embedding = vector8(?), embedding_model = ? WHERE chunk_key = ?`)).run(json, item.modelName, item.chunkKey)
      }
      await this.db.exec("COMMIT")
    } catch (e) {
      await this.db.exec("ROLLBACK")
      throw e
    }
  }

  async countStaleEmbeddings(codebaseId: number, modelName: string): Promise<number> {
    const row = await (await this.db.prepare(`SELECT COUNT(*) as cnt FROM chunks WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)`)).get(codebaseId, modelName) as { cnt: number }
    return Number(row.cnt)
  }

  /** Get chunks that need (re-)embedding (scoped to codebase) */
  async getStaleEmbeddings(codebaseId: number, modelName: string, limit?: number): Promise<{ chunkKey: string; name: string; signature: string; filePath: string; kind: string; snippet: string }[]> {
    const sql = limit
      ? `SELECT chunk_key, name, signature, file_path, kind, snippet FROM chunks
         WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)
         LIMIT ?`
      : `SELECT chunk_key, name, signature, file_path, kind, snippet FROM chunks
         WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)`

    const rows = limit
      ? await (await this.db.prepare(sql)).all(codebaseId, modelName, limit) as StaleEmbeddingRow[]
      : await (await this.db.prepare(sql)).all(codebaseId, modelName) as StaleEmbeddingRow[]
    return rows.map(r => ({
      chunkKey: r.chunk_key,
      name: r.name,
      signature: r.signature,
      filePath: r.file_path,
      kind: r.kind,
      snippet: r.snippet,
    }))
  }

  // ── Per-codebase FTS lifecycle ───────────────────────────────────

  /** Drop FTS table for a codebase if it doesn't exist yet (idempotent) */
  async ensureFtsTable(codebaseId: number): Promise<void> {
    await this.db.exec(createFtsTableSQL(codebaseId))
    try {
      await this.db.exec(createFtsIndexSQL(codebaseId))
    } catch {
      // Index already exists — ignore
    }
  }

  /** Insert FTS entries for all chunks belonging to the given file paths */
  async populateFtsForFiles(codebaseId: number, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return
    const stmt = await this.db.prepare(populateFtsForFileSQL(codebaseId))
    for (const fp of filePaths) {
      await stmt.run(codebaseId, fp)
    }
  }

  /** Optimize the FTS index (call once after a batch of changes) */
  async optimizeFts(codebaseId: number): Promise<void> {
    await this.db.exec(`OPTIMIZE INDEX idx_${ftsTableName(codebaseId)}`)
  }

  // ── Search ───────────────────────────────────────────────────────

  /** Vector search across all codebases (global) */
  async vectorSearch(queryEmbedding: number[], limit: number, includeSnippet: boolean): Promise<SearchResult[]> {
    const json = JSON.stringify(queryEmbedding)
    const sql = includeSnippet
      ? `SELECT chunk_key, file_path, name, kind, signature, snippet, start_line, end_line,
                vector_distance_cos(embedding, vector8(?)) AS distance
         FROM chunks
         WHERE embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT ?`
      : `SELECT chunk_key, file_path, name, kind, signature, start_line, end_line,
                vector_distance_cos(embedding, vector8(?)) AS distance
         FROM chunks
         WHERE embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT ?`

    const rows = await (await this.db.prepare(sql)).all(json, limit) as VectorSearchRow[]

    return rows.map((row) => ({
      chunkKey: row.chunk_key,
      filePath: row.file_path,
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      snippet: includeSnippet ? row.snippet : "",
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - (row.distance ?? 1),
    }))
  }

  /** FTS search across all codebases (queries each FTS table, merges results) */
  async ftsSearch(query: string, limit: number, includeSnippet: boolean): Promise<SearchResult[]> {
    // Discover existing FTS tables in a single query instead of checking each codebase
    const ftsTables = await (await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fts_*'")).all() as { name: string }[]

    const allResults: SearchResult[] = []

    for (const { name: table } of ftsTables) {
      try {
        // Join FTS scores with chunk data in a single query (avoids per-row lookups)
        const snippetCol = includeSnippet ? "c.snippet," : ""
        const rows = await (await this.db.prepare(`SELECT c.chunk_key, c.file_path, c.name, c.kind, c.signature,
                  ${snippetCol} c.start_line, c.end_line,
                  fts_score(f.name, f.signature, ?1) AS score
           FROM ${table} f
           JOIN chunks c ON c.id = f.chunk_id
           WHERE fts_match(f.name, f.signature, ?1)
           ORDER BY score DESC
           LIMIT ?`)).all(query, limit) as (ChunkDataRow & { score: number; snippet?: string })[]

        for (const row of rows) {
          allResults.push({
            chunkKey: row.chunk_key,
            filePath: row.file_path,
            name: row.name,
            kind: row.kind,
            signature: row.signature,
            snippet: includeSnippet ? (row.snippet ?? "") : "",
            startLine: row.start_line,
            endLine: row.end_line,
            score: row.score,
          })
        }
      } catch (e: unknown) {
        // Ignore stale FTS tables (no such table / no such index); rethrow others
        const msg = String((e as Error)?.message ?? e)
        if (!msg.includes("no such table") && !msg.includes("no such index")) {
          throw e
        }
      }
    }

    // Merge across codebases: sort by score descending, take top limit
    allResults.sort((a, b) => b.score - a.score)
    return allResults.slice(0, limit)
  }

  /** Count chunks that have embeddings (i.e., are searchable) */
  async countEmbeddedChunks(): Promise<number> {
    const row = await (await this.db.prepare("SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NOT NULL")).get() as { cnt: number }
    return row.cnt
  }

  /** List all indexed files (optionally scoped to codebase) */
  async listFiles(codebaseId?: number): Promise<IndexedFile[]> {
    const sql = codebaseId != null
      ? "SELECT file_path, file_hash, chunk_count, indexed_at FROM indexed_files WHERE codebase_id = ? ORDER BY file_path"
      : "SELECT file_path, file_hash, chunk_count, indexed_at FROM indexed_files ORDER BY file_path"

    const rows = codebaseId != null
      ? await (await this.db.prepare(sql)).all(codebaseId) as IndexedFileRow[]
      : await (await this.db.prepare(sql)).all() as IndexedFileRow[]

    return rows.map((row) => ({
      filePath: row.file_path,
      fileHash: row.file_hash,
      chunkCount: row.chunk_count,
      indexedAt: row.indexed_at,
    }))
  }

  close(): void {
    this.db.close()
  }
}
