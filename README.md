<p align="center">
  <img src="codemogger.png" alt="codemogger" width="200">
</p>

# codemogger

Code indexing library for AI coding agents. Parses source code with tree-sitter, chunks it into semantic units (functions, structs, classes, impl blocks), embeds them locally, and stores everything in a single SQLite file with vector + full-text search.

No Docker, no server, no API keys. One `.db` file per codebase.

## Why

Coding agents need to understand codebases. They need to find where things are defined, discover how concepts are implemented across files, and navigate unfamiliar code quickly. This requires both keyword search (precise identifier lookup) and semantic search (natural language queries when you don't know the exact names).

As AI coding tools become more composable - agents calling agents, MCP servers plugging into different hosts - this capability needs to exist as a library that runs locally. No external servers, no API keys, no Docker containers. Just a function call that returns results.

codemogger is that library. Embedded SQLite (via [Turso](https://turso.tech)) with FTS + vector search in a single `.db` file.

## Install

```bash
npm install -g codemogger
```

Or use `npx` to run without installing.

## Quick start

```bash
# Index a project
codemogger index ./my-project

# Search
codemogger search "authentication middleware"
```

Add to your coding agent's MCP config (Claude Code, OpenCode, etc.):

```json
{
  "mcpServers": {
    "codemogger": {
      "command": "npx",
      "args": ["-y", "codemogger", "mcp"]
    }
  }
}
```

The MCP server exposes three tools:

- `codemogger_search` - semantic and keyword search over indexed code
- `codemogger_index` - index a codebase for the first time
- `codemogger_reindex` - update the index after modifying files


Add the local db to `.gitignore`:

```gitignore
# codemogger db
.codemogger/
```

## SDK

codemogger is also usable as a library. The SDK has no model dependency - you provide your own embedding function:

```typescript
import { CodeIndex } from "codemogger";
import { pipeline } from "@huggingface/transformers";

// Load embedding model (runs locally, no API keys)
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });

const embedder = async (texts: string[]): Promise<number[][]> => {
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
};

const db = new CodeIndex({
  dbPath: "./my-project.db",
  embedder,
  embeddingModel: "all-MiniLM-L6-v2",
});

await db.index("/path/to/project");

// Semantic: "what does this codebase do?"
const results = await db.search("authentication middleware", { mode: "semantic" });

// Keyword: precise identifier lookup
const results = await db.search("BTreeCursor", { mode: "keyword" });

await db.close();
```

The MCP server and CLI ship with `all-MiniLM-L6-v2` by default.

## CLI

```bash
# Install globally
npm install -g codemogger

# Index a directory
codemogger index ./my-project

# Search
codemogger search "authentication middleware"

# List indexed codebases
codemogger list
```

## How it works

1. **Scan** - walk directory, respect `.gitignore`, detect language from extension
2. **Chunk** - parse each file with tree-sitter (WASM), extract top-level definitions (functions, structs, classes, impl blocks). Items >150 lines are split into sub-items.
3. **Embed** - encode each chunk with the provided embedding model (runs locally, no API)
4. **Store** - write chunks + embeddings to SQLite with FTS index
5. **Search** - vector cosine similarity (semantic) or FTS with weighted fields (keyword)

Incremental: only changed files (by SHA-256 hash) are re-processed on subsequent runs.

## Languages

Rust, C, C++, Go, Python, Zig, Java, Scala, JavaScript, TypeScript, TSX, PHP, Ruby.

## Benchmarks

Benchmarked on 4 real-world codebases on an Apple M2 (8GB). Each project uses its own isolated database. Embeddings use `vector8` (int8 quantized, 395 bytes/chunk vs 1,536 for float32). Embedding model: `all-MiniLM-L6-v2` (q8 quantized, local CPU). Search times are p50 over 3 runs.

### Performance

| Project                                                | Language   |  Files | Semantic | Keyword |  ripgrep |
| ------------------------------------------------------ | ---------- | -----: | -------: | ------: | -------: |
| [Turso](https://github.com/tursodatabase/turso)        | Rust       |    748 |    35 ms |    1 ms |    25 ms |
| [Bun](https://github.com/oven-sh/bun)                  | Zig        |  9,255 |   137 ms |    2 ms |   166 ms |
| [TypeScript](https://github.com/microsoft/TypeScript)  | TypeScript | 39,298 |   242 ms |    4 ms | 1,500 ms |
| [Kubernetes](https://github.com/kubernetes/kubernetes) | Go         | 16,668 |   617 ms |   12 ms |   731 ms |

Keyword search is **25x-370x faster than ripgrep** and returns precise definitions instead of thousands of file matches.

Indexing is a one-time cost dominated by embedding (~97% of time). Subsequent runs only re-embed changed files.

### Search quality: semantic search vs ripgrep

The real advantage isn't speed - it's **finding the right code when you don't know the exact keywords**.

**"write-ahead log replication and synchronization"** (Turso)

| codemogger (top 5)                                                | ripgrep                  |
| ----------------------------------------------------------------- | ------------------------ |
| `impl LogicalLog` - core/mvcc/persistent_storage/logical_log.rs   | 3 files matched          |
| `enum CommitState` - core/mvcc/database/mod.rs                    | (keyword: "write-ahead") |
| `function new` - core/mvcc/database/checkpoint_state_machine.rs   |                          |
| `struct LogicalLog` - core/mvcc/persistent_storage/logical_log.rs |                          |
| `function checkpoint_shutdown` - core/storage/pager.rs            |                          |

**"SQL statement parsing and compilation"** (Turso)

| codemogger (top 5)                                             | ripgrep                |
| -------------------------------------------------------------- | ---------------------- |
| `function parse_and_build` - core/translate/logical.rs         | 139 files matched      |
| `macro compile_sql` - core/incremental/compiler.rs             | (keyword: "statement") |
| `function parse_from_clause_opt` - parser/src/parser.rs        |                        |
| `function parse_from_clause_table` - core/translate/planner.rs |                        |
| `function parse_table` - core/translate/planner.rs             |                        |

**"HTTP request parsing and response writing"** (Bun)

| codemogger (top 5)                                                                      | ripgrep           |
| --------------------------------------------------------------------------------------- | ----------------- |
| `function consumeRequestLine` - packages/bun-uws/src/HttpParser.h                       | 0 files matched   |
| `declaration ConsumeRequestLineResult` - packages/bun-uws/src/HttpParser.h              | (keyword: "HTTP") |
| `function llhttp__after_headers_complete` - src/bun.js/bindings/node/http/llhttp/http.c |                   |
| `function llhttp_message_needs_eof` - src/bun.js/bindings/node/http/llhttp/http.c       |                   |
| `function shortRead` - packages/bun-uws/src/HttpParser.h                                |                   |

**"scheduling pods to nodes based on resource requirements"** (Kubernetes)

| codemogger (top 5)                                                      | ripgrep                 |
| ----------------------------------------------------------------------- | ----------------------- |
| `type Scheduling` - staging/src/k8s.io/api/node/v1beta1/types.go        | 429 files matched       |
| `type Scheduling` - staging/src/k8s.io/api/node/v1/types.go             | (keyword: "scheduling") |
| `type SchedulingApplyConfiguration` - staging/.../node/v1/scheduling.go |                         |
| `function runPodAndGetNodeName` - test/e2e/scheduling/predicates.go     |                         |
| `type createPodsOp` - test/integration/scheduler_perf/scheduler_perf.go |                         |

**"container health check probes and restart policy"** (Kubernetes)

| codemogger (top 5)                                                                                   | ripgrep                |
| ---------------------------------------------------------------------------------------------------- | ---------------------- |
| `type ContainerFailures` - test/utils/conditions.go                                                  | 1,652 files matched    |
| `variable _` - test/e2e/common/node/container_probe.go                                               | (keyword: "container") |
| `function checkContainerStateTransition` - pkg/kubelet/status/status_manager.go                      |                        |
| `function TestDoProbe_TerminatedContainerWithRestartPolicyNever` - pkg/kubelet/prober/worker_test.go |                        |
| `function proveHealthCheckNodePortDeallocated` - pkg/registry/core/service/storage/storage_test.go   |                        |

ripgrep matches thousands of files on common keywords. codemogger returns the 5 most relevant definitions.

## Architecture

- **Bun/TypeScript** runtime
- **tree-sitter (WASM)** for AST-aware chunking - 13 language grammars
- **all-MiniLM-L6-v2** for local embeddings (384 dimensions, q8 quantized)
- **Turso** for storage - embedded SQLite with FTS + vector search extensions
- **Single DB file** stores multiple codebases with per-codebase FTS tables and global vector search

## License

MIT
