import { connect } from '@tursodatabase/database';
import {
  ALL_SCHEMA,
  ftsTableName,
  createFtsTableSQL,
  createFtsIndexSQL,
  dropFtsTableSQL,
  populateFtsSQL,
} from './schema.ts';
import type { CodeChunk } from '../chunk/types.ts';

export interface SearchResult {
  chunkKey: string;
  filePath: string;
  name: string;
  kind: string;
  signature: string;
  snippet: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface IndexedFile {
  filePath: string;
  fileHash: string;
  chunkCount: number;
  indexedAt: number;
}

export interface Codebase {
  id: number;
  rootPath: string;
  name: string;
  indexedAt: number;
  fileCount: number;
  chunkCount: number;
}

export class Store {
  private db: Awaited<ReturnType<typeof connect>>;
  private initialized = false;

  private constructor(db: Awaited<ReturnType<typeof connect>>) {
    this.db = db;
  }

  static async open(dbPath: string): Promise<Store> {
    const db = await connect(dbPath, {
      experimental: ['index_method'],
    });
    const store = new Store(db);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    for (const sql of ALL_SCHEMA) {
      await this.db.exec(sql);
    }
    this.initialized = true;
  }

  // ── Codebase management ──────────────────────────────────────────

  /** Get or create a codebase entry, returns its id */
  async getOrCreateCodebase(rootPath: string, name?: string): Promise<number> {
    const row = (await this.db
      .prepare('SELECT id FROM codebases WHERE root_path = ?')
      .get(rootPath)) as { id: number } | undefined;

    if (row) return row.id;

    await this.db
      .prepare(
        'INSERT INTO codebases (root_path, name, indexed_at) VALUES (?, ?, ?)'
      )
      .run(rootPath, name ?? rootPath.split('/').pop() ?? '', Date.now());

    const inserted = (await this.db
      .prepare('SELECT id FROM codebases WHERE root_path = ?')
      .get(rootPath)) as { id: number };
    return inserted.id;
  }

  /** List all codebases */
  async listCodebases(): Promise<Codebase[]> {
    const rows = (await this.db
      .prepare(
        `SELECT c.id, c.root_path, c.name, c.indexed_at,
              COUNT(DISTINCT f.file_path) as file_count,
              COALESCE(SUM(f.chunk_count), 0) as chunk_count
       FROM codebases c
       LEFT JOIN indexed_files f ON f.codebase_id = c.id
       GROUP BY c.id
       ORDER BY c.root_path`
      )
      .all()) as any[];
    return rows.map((r) => ({
      id: r.id,
      rootPath: r.root_path,
      name: r.name,
      indexedAt: r.indexed_at,
      fileCount: r.file_count,
      chunkCount: r.chunk_count,
    }));
  }

  /** Update codebase indexed_at timestamp */
  async touchCodebase(codebaseId: number): Promise<void> {
    await this.db
      .prepare('UPDATE codebases SET indexed_at = ? WHERE id = ?')
      .run(Date.now(), codebaseId);
  }

  // ── File hash management ─────────────────────────────────────────

  /** Get stored file hash, or null if not indexed */
  async getFileHash(
    codebaseId: number,
    filePath: string
  ): Promise<string | null> {
    const row = (await this.db
      .prepare(
        'SELECT file_hash FROM indexed_files WHERE codebase_id = ? AND file_path = ?'
      )
      .get(codebaseId, filePath)) as { file_hash: string } | undefined;
    return row?.file_hash ?? null;
  }

  // ── Chunk writes ─────────────────────────────────────────────────

  /** Batch insert chunks for multiple files in one transaction */
  async batchUpsertAllFileChunks(
    codebaseId: number,
    fileChunks: { filePath: string; fileHash: string; chunks: CodeChunk[] }[]
  ): Promise<void> {
    await this.db.exec('BEGIN');
    try {
      const now = Date.now();
      const deleteStmt = await this.db.prepare(
        'DELETE FROM chunks WHERE codebase_id = ? AND file_path = ?'
      );
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
      `);
      const fileStmt = await this.db.prepare(`
        INSERT INTO indexed_files (codebase_id, file_path, file_hash, chunk_count, indexed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(codebase_id, file_path) DO UPDATE SET
          file_hash = excluded.file_hash,
          chunk_count = excluded.chunk_count,
          indexed_at = excluded.indexed_at
      `);

      for (const { filePath, fileHash, chunks } of fileChunks) {
        await deleteStmt.run(codebaseId, filePath);
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
            now
          );
        }
        await fileStmt.run(codebaseId, filePath, fileHash, chunks.length, now);
      }
      await this.db.exec('COMMIT');
    } catch (e) {
      await this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Remove all chunks and file records for a codebase */
  async removeCodebaseChunks(codebaseId: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM chunks WHERE codebase_id = ?')
      .run(codebaseId);
    await this.db
      .prepare('DELETE FROM indexed_files WHERE codebase_id = ?')
      .run(codebaseId);
  }

  /** Remove files that are no longer on disk (scoped to codebase) */
  async removeStaleFiles(
    codebaseId: number,
    activeFiles: Set<string>
  ): Promise<number> {
    const all = (await this.db
      .prepare('SELECT file_path FROM indexed_files WHERE codebase_id = ?')
      .all(codebaseId)) as { file_path: string }[];
    let removed = 0;
    await this.db.exec('BEGIN');
    try {
      for (const row of all) {
        if (!activeFiles.has(row.file_path)) {
          await this.db
            .prepare(
              'DELETE FROM chunks WHERE codebase_id = ? AND file_path = ?'
            )
            .run(codebaseId, row.file_path);
          await this.db
            .prepare(
              'DELETE FROM indexed_files WHERE codebase_id = ? AND file_path = ?'
            )
            .run(codebaseId, row.file_path);
          removed++;
        }
      }
      await this.db.exec('COMMIT');
    } catch (e) {
      await this.db.exec('ROLLBACK');
      throw e;
    }
    return removed;
  }

  // ── Embedding management ─────────────────────────────────────────

  /** Batch store embeddings */
  async batchUpsertEmbeddings(
    items: { chunkKey: string; embedding: number[]; modelName: string }[]
  ): Promise<void> {
    if (items.length === 0) return;
    await this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const json = JSON.stringify(item.embedding);
        await this.db
          .prepare(
            `UPDATE chunks SET embedding = vector8(?), embedding_model = ? WHERE chunk_key = ?`
          )
          .run(json, item.modelName, item.chunkKey);
      }
      await this.db.exec('COMMIT');
    } catch (e) {
      await this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async countStaleEmbeddings(codebaseId: number, modelName: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) as cnt FROM chunks WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)`
    ).get(codebaseId, modelName) as { cnt: number }
    return Number(row.cnt)
  }

  /** Get chunks that need (re-)embedding (scoped to codebase) */
  async getStaleEmbeddings(
    codebaseId: number,
    modelName: string,
    limit?: number
  ): Promise<
    {
      chunkKey: string;
      name: string;
      signature: string;
      filePath: string;
      kind: string;
      snippet: string;
    }[]
  > {
    const sql = limit
      ? `SELECT chunk_key, name, signature, file_path, kind, snippet FROM chunks
         WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)
         LIMIT ${limit}`
      : `SELECT chunk_key, name, signature, file_path, kind, snippet FROM chunks
         WHERE codebase_id = ? AND (embedding IS NULL OR embedding_model != ?)`;

    const rows = (await this.db
      .prepare(sql)
      .all(codebaseId, modelName)) as any[];
    return rows.map((r) => ({
      chunkKey: r.chunk_key,
      name: r.name,
      signature: r.signature,
      filePath: r.file_path,
      kind: r.kind,
      snippet: r.snippet,
    }));
  }

  // ── Per-codebase FTS lifecycle ───────────────────────────────────

  /** Drop and rebuild FTS table for a codebase */
  async rebuildFtsTable(codebaseId: number): Promise<void> {
    // Drop old table (and its index)
    await this.db.exec(dropFtsTableSQL(codebaseId));
    // Create fresh table
    await this.db.exec(createFtsTableSQL(codebaseId));
    // Populate from chunks
    await this.db.prepare(populateFtsSQL(codebaseId)).run(codebaseId);
    // Build FTS index
    await this.db.exec(createFtsIndexSQL(codebaseId));
    // Optimize FTS index for faster queries
    await this.db.exec(`OPTIMIZE INDEX idx_${ftsTableName(codebaseId)}`);
  }

  // ── Search ───────────────────────────────────────────────────────

  /** Vector search across all codebases (global) */
  async vectorSearch(
    queryEmbedding: number[],
    limit: number,
    includeSnippet: boolean
  ): Promise<SearchResult[]> {
    const json = JSON.stringify(queryEmbedding);
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
         LIMIT ?`;

    const rows = (await this.db.prepare(sql).all(json, limit)) as any[];

    return rows.map((row) => ({
      chunkKey: row.chunk_key,
      filePath: row.file_path,
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      snippet: includeSnippet ? row.snippet : '',
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - (row.distance ?? 1),
    }));
  }

  /** FTS search across all codebases (queries each FTS table, merges results) */
  async ftsSearch(
    query: string,
    limit: number,
    includeSnippet: boolean
  ): Promise<SearchResult[]> {
    // Find all codebase IDs that have FTS tables
    const codebases = (await this.db
      .prepare('SELECT id FROM codebases')
      .all()) as { id: number }[];

    const allResults: SearchResult[] = [];

    for (const { id } of codebases) {
      const table = ftsTableName(id);
      // Check if FTS table exists
      const exists = (await this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)) as { name: string } | undefined;
      if (!exists) continue;

      try {
        const scores = (await this.db
          .prepare(
            `SELECT chunk_id, fts_score(name, signature, ?1) AS score
           FROM ${table}
           WHERE fts_match(name, signature, ?1)
           ORDER BY score DESC
           LIMIT ?`
          )
          .all(query, limit)) as { chunk_id: number; score: number }[];

        if (scores.length === 0) continue;

        for (const { chunk_id, score } of scores) {
          const dataSql = includeSnippet
            ? `SELECT chunk_key, file_path, name, kind, signature, snippet, start_line, end_line FROM chunks WHERE id = ?`
            : `SELECT chunk_key, file_path, name, kind, signature, start_line, end_line FROM chunks WHERE id = ?`;

          const row = (await this.db.prepare(dataSql).get(chunk_id)) as any;
          if (!row) continue;

          allResults.push({
            chunkKey: row.chunk_key,
            filePath: row.file_path,
            name: row.name,
            kind: row.kind,
            signature: row.signature,
            snippet: includeSnippet ? row.snippet : '',
            startLine: row.start_line,
            endLine: row.end_line,
            score,
          });
        }
      } catch (e: any) {
        // Only ignore "no such table" / "no such index" errors (FTS not built yet)
        const msg = String(e?.message ?? e);
        if (!msg.includes('no such table') && !msg.includes('no such index')) {
          throw e;
        }
      }
    }

    // Sort by score descending, take top limit
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /** Count chunks that have embeddings (i.e., are searchable) */
  async countEmbeddedChunks(): Promise<number> {
    const row = (await this.db
      .prepare('SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NOT NULL')
      .get()) as { cnt: number };
    return row.cnt;
  }

  /** List all indexed files (optionally scoped to codebase) */
  async listFiles(codebaseId?: number): Promise<IndexedFile[]> {
    const sql =
      codebaseId != null
        ? 'SELECT file_path, file_hash, chunk_count, indexed_at FROM indexed_files WHERE codebase_id = ? ORDER BY file_path'
        : 'SELECT file_path, file_hash, chunk_count, indexed_at FROM indexed_files ORDER BY file_path';

    const rows =
      codebaseId != null
        ? ((await this.db.prepare(sql).all(codebaseId)) as any[])
        : ((await this.db.prepare(sql).all()) as any[]);

    return rows.map((row) => ({
      filePath: row.file_path,
      fileHash: row.file_hash,
      chunkCount: row.chunk_count,
      indexedAt: row.indexed_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
