#!/usr/bin/env bun
import { program } from "commander"
import { CodeIndex, projectDbPath, type SearchMode, type IndexProgress } from "../src/index.ts"
import { localEmbed, LOCAL_MODEL_NAME } from "../src/embed/local.ts"
import { formatJson } from "../src/format/json.ts"
import { formatText } from "../src/format/text.ts"

const isTTY = process.stderr.isTTY

/** OSC 9;4 terminal progress — works in Ghostty, Windows Terminal, Konsole, WezTerm, kitty, etc. */
function oscProgress(state: 0 | 1 | 2 | 3, percent?: number) {
  if (!isTTY) return
  const p = percent != null ? `;${Math.round(Math.min(100, Math.max(0, percent)))}` : ""
  process.stderr.write(`\x1b]9;4;${state}${p}\x07`)
}

const phaseLabel: Record<string, string> = {
  scan: "Scanning files",
  hash: "Checking for changes",
  chunk: "Chunking files",
  embed: "Embedding chunks",
  cleanup: "Removing stale files",
  fts: "Rebuilding search index",
}

function formatEta(ms: number): string {
  if (ms < 1000) return "<1s"
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

let phaseStart = 0
let lastPhase = ""

function renderProgress(p: IndexProgress) {
  if (p.phase !== lastPhase) {
    lastPhase = p.phase
    phaseStart = performance.now()
  }
  const label = phaseLabel[p.phase] ?? p.phase
  if (p.total > 0) {
    const pct = Math.round((p.current / p.total) * 100)
    oscProgress(1, pct)
    if (isTTY) {
      let eta = ""
      if (p.current > 1) {
        const elapsed = performance.now() - phaseStart
        const remaining = (elapsed / p.current) * (p.total - p.current)
        eta = ` ~${formatEta(remaining)}`
      }
      process.stderr.write(`\r\x1b[K${label}  ${pct}% (${p.current}/${p.total})${eta}`)
    }
  } else {
    oscProgress(3)
    if (isTTY) {
      process.stderr.write(`\r\x1b[K${label}...`)
    }
  }
}

function clearProgress() {
  oscProgress(0)
  if (isTTY) process.stderr.write(`\r\x1b[K`)
}

/** Resolve DB path: --db flag overrides, otherwise per-project default */
function resolveDbPath(dir?: string): string {
  const explicit = program.opts().db;
  if (explicit) return explicit;
  return projectDbPath(dir ?? process.cwd());
}

program
  .name("codemogger")
  .description("Code indexing library for AI coding agents - semantic search over codebases")
  .version("0.2.0")
  .option("--db <path>", "database file path (default: <project>/.codemogger/index.db)");

program
  .command("index")
  .description("Index a directory of source code")
  .argument("<dir>", "directory to index")
  .option("--language <lang>", "filter by language (e.g. rust, typescript)")
  .option("--verbose", "show detailed indexing progress")
  .action(async (dir: string, opts: { language?: string; verbose?: boolean }) => {
    const dbPath = resolveDbPath(dir);
    const db = new CodeIndex({ dbPath, embedder: localEmbed, embeddingModel: LOCAL_MODEL_NAME });
    try {
      const result = await db.index(dir, {
        languages: opts.language ? [opts.language] : undefined,
        verbose: opts.verbose,
        onProgress: renderProgress,
      })

      clearProgress()

      if (opts.verbose || result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`warning: ${err}`);
        }
      }

      console.log(
        `Indexed ${result.files} file${result.files !== 1 ? "s" : ""} → ` +
        `${result.chunks} chunks, ` +
        `embedded ${result.embedded}, ` +
        `skipped ${result.skipped} unchanged, ` +
        `removed ${result.removed} stale ` +
        `(${result.duration}ms)`
      )
    } catch (e) {
      clearProgress()
      throw e
    } finally {
      await db.close();
    }
  });

program
  .command("search")
  .description("Search indexed code semantically")
  .argument("<query>", "natural language query or search terms")
  .option("--limit <n>", "maximum results to return", "5")
  .option("--threshold <score>", "minimum score to include", "0")
  .option("--format <fmt>", "output format: json|text", "json")
  .option("--snippet", "include code snippet in output")
  .option("--mode <mode>", "search mode: semantic|keyword|hybrid", "semantic")
  .action(
    async (
      query: string,
      opts: { limit: string; threshold: string; format: string; snippet?: boolean; mode: string },
    ) => {
      const dbPath = resolveDbPath();
      const db = new CodeIndex({ dbPath, embedder: localEmbed, embeddingModel: LOCAL_MODEL_NAME });
      try {
        const start = performance.now();
        const results = await db.search(query, {
          limit: parseInt(opts.limit, 10),
          threshold: parseFloat(opts.threshold),
          includeSnippet: opts.snippet,
          mode: opts.mode as SearchMode,
        });
        const elapsed = Math.round(performance.now() - start);

        switch (opts.format) {
          case "text":
            console.log(formatText(query, results, elapsed));
            break;
          case "json":
          default:
            console.log(formatJson(query, results, elapsed));
            break;
        }
      } finally {
        await db.close();
      }
    },
  );

program
  .command("list")
  .description("List all indexed files")
  .option("--format <fmt>", "output format: json|text", "text")
  .action(async (opts: { format: string }) => {
    const dbPath = resolveDbPath();
    const db = new CodeIndex({ dbPath, embedder: localEmbed, embeddingModel: LOCAL_MODEL_NAME });
    try {
      const files = await db.listFiles();

      if (opts.format === "json") {
        console.log(JSON.stringify(files, null, 2));
      } else {
        if (files.length === 0) {
          console.log("No files indexed. Run `codemogger index <dir>` first.");
          return;
        }
        const totalChunks = files.reduce((sum, f) => sum + f.chunkCount, 0);
        console.log(
          `${files.length} file${files.length !== 1 ? "s" : ""} indexed (${totalChunks} chunks):\n`,
        );
        for (const f of files) {
          console.log(`  ${f.filePath} (${f.chunkCount} chunks)`);
        }
      }
    } finally {
      await db.close();
    }
  });

program
  .command("mcp")
  .description("Start the MCP server (for Claude Code, OpenCode, etc.)")
  .action(async () => {
    const { startMcpServer } = await import("../src/mcp.ts");
    await startMcpServer(program.opts().db);
  });

program.parse();
