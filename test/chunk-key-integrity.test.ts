import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkFile } from '../src/chunk/treesitter.ts'
import { detectLanguage } from '../src/chunk/languages.ts'
import { Store } from '../src/db/store.ts'
import { connect } from '@tursodatabase/database'

test('distinct same-line variables retain separate retrieval identities', async () => {
  const path = '/inert/same-line.js'
  const chunks = await chunkFile(path, 'const first = 1; const second = 2; const third = 3;\n', 'fixture-hash', detectLanguage(path)!)
  expect(chunks.length).toBe(3)
  expect(new Set(chunks.map(chunk => chunk.chunkKey)).size).toBe(3)
})

test('same-line functions survive actual Store writes with accurate coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemogger-key-integrity-'))
  const store = await Store.open(join(dir, 'inert.db'))
  try {
    const path = join(dir, 'functions.js')
    const chunks = await chunkFile(path, 'function first() {} function second() {}\n', 'fixture-hash', detectLanguage(path)!)
    const id = await store.getOrCreateCodebase(dir)
    await store.batchUpsertAllFileChunks(id, [{ filePath: path, fileHash: 'fixture-hash', chunks }])
    const coverage = await store.listFiles(id)
    const persisted = await store.getStaleEmbeddings(id, 'all-MiniLM-L6-v2')
    expect(persisted.map(chunk => chunk.name).sort()).toEqual(['first', 'second'])
    expect(coverage[0]!.chunkCount).toBe(persisted.length)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('ordinary identities stay compatible and collision identities are deterministic', async () => {
  const path = '/inert/identity.js'
  const source = 'function ordinary() {}\nconst first = "λ"; const second = 2;\n'
  const chunks = await chunkFile(path, source, 'fixture-hash', detectLanguage(path)!)
  expect(chunks[0]!.chunkKey).toBe(`${path}:1:1`)
  expect(new Set(chunks.map(chunk => chunk.chunkKey)).size).toBe(chunks.length)
  const repeated = await chunkFile(path, source, 'fixture-hash', detectLanguage(path)!)
  expect(repeated.map(chunk => chunk.chunkKey)).toEqual(chunks.map(chunk => chunk.chunkKey))
})

test('an unchanged legacy collision is reparsed; a repaired or empty file stays cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemogger-legacy-integrity-'))
  const store = await Store.open(join(dir, 'inert.db'))
  try {
    const path = join(dir, 'legacy.js')
    const chunks = await chunkFile(path, 'function first() {} function second() {}\n', 'same-source-hash', detectLanguage(path)!)
    const id = await store.getOrCreateCodebase(dir)
    const legacy = chunks.map(chunk => ({ ...chunk, chunkKey: `${path}:1:1` }))
    await store.batchUpsertAllFileChunks(id, [{ filePath: path, fileHash: 'same-source-hash', chunks: legacy }])
    expect(await store.getFileHash(id, path)).toBeNull()
    await store.batchUpsertAllFileChunks(id, [{ filePath: path, fileHash: 'same-source-hash', chunks }])
    expect(await store.getFileHash(id, path)).toBe('same-source-hash')
    expect((await store.getStaleEmbeddings(id, 'all-MiniLM-L6-v2')).length).toBe(2)
    const empty = join(dir, 'empty.js')
    await store.batchUpsertAllFileChunks(id, [{ filePath: empty, fileHash: 'empty-hash', chunks: [] }])
    expect(await store.getFileHash(id, empty)).toBe('empty-hash')
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the chunk-count index is provisioned by writes rather than an ordinary open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemogger-index-provision-'))
  const dbPath = join(dir, 'inert.db')
  const store = await Store.open(dbPath)
  const connection = await connect(dbPath, { readonly: true, fileMustExist: true, experimental: ['index_method', 'multiprocess_wal'] })
  try {
    const count = async () => Number((await (await connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_chunks_codebase_file'")).get()).n)
    expect(await count()).toBe(0)
    await store.getOrCreateCodebase(dir)
    expect(await count()).toBe(1)
  } finally {
    await connection.close()
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
