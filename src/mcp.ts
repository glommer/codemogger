/**
 * codemogger MCP server - exposes code search and indexing as MCP tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CodeIndex, projectDbPath } from './index.ts';
import { localEmbed, LOCAL_MODEL_NAME } from './embed/local.ts';
import type { Codebase } from './db/store.ts';

const cwd = process.cwd();

/** Check if cwd is inside (or equal to) any indexed codebase */
function findCurrentCodebase(codebases: Codebase[]): Codebase | undefined {
  return codebases
    .filter((c) => cwd === c.rootPath || cwd.startsWith(c.rootPath + '/'))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
}

/** Build the codemogger_search description dynamically based on index state */
function buildSearchDescription(current: Codebase | undefined): string {
  const base = `Search an indexed codebase for relevant code. Two modes:
- "semantic": natural language queries like "how does authentication work?" - uses vector embeddings
- "keyword": precise identifier lookup like "BTreeCursor" or "handleRequest" - uses full-text search on function/type names

Returns matching code chunks with file path, name, kind, signature, and line numbers.`;

  const usage = `Use this tool FIRST when exploring or navigating a codebase, before falling back to Grep or Glob. It is especially effective for:
- Finding where a function, class, type, or variable is defined (keyword mode)
- Understanding how a feature or concept is implemented across many files (semantic mode)
- Discovering relevant code when you don't know exact filenames or identifiers (semantic mode)

Use includeSnippet=true to get the full source code of each result, eliminating the need for a separate Read call.`;

  if (current) {
    return `This project (${current.rootPath}) is indexed and searchable - ${current.chunkCount} chunks from ${current.fileCount} files.

${base}

${usage}`;
  }

  return `${base}

${usage}`;
}

/** Start the MCP server. Called from the CLI `mcp` subcommand. */
export async function startMcpServer(dbPath?: string): Promise<void> {
  const codeIndex = new CodeIndex({
    dbPath: dbPath ?? projectDbPath(cwd),
    embedder: localEmbed,
    embeddingModel: LOCAL_MODEL_NAME,
  });

  // Query indexed codebases at startup so the initial description reflects actual state
  const initialCodebases = await codeIndex.listCodebases();
  const initialCurrent = findCurrentCodebase(initialCodebases);

  const server = new McpServer({
    name: 'codemogger',
    version: '0.1.0',
  });

  const searchTool = server.registerTool(
    'codemogger_search',
    {
      title: 'Search Code Index',
      description: buildSearchDescription(initialCurrent),
      inputSchema: {
        query: z
          .string()
          .describe(
            'The search query - natural language for semantic mode, identifier/keyword for keyword mode'
          ),
        mode: z
          .enum(['semantic', 'keyword'])
          .default('semantic')
          .describe(
            "Search mode: 'semantic' for conceptual queries, 'keyword' for exact identifier lookup"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum number of results to return'),
        includeSnippet: z
          .boolean()
          .default(true)
          .describe('Include the full code snippet in results (can be large)'),
      },
    },
    async ({ query, mode, limit, includeSnippet }) => {
      const results = await codeIndex.search(query, {
        mode,
        limit,
        includeSnippet,
      });

      if (results.length === 0) {
        const codebases = await codeIndex.listCodebases();
        if (codebases.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No codebases are indexed yet. Use codemogger_index to index the codebase directory first, then retry this search. Indexing is a one-time operation.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `No results found for "${query}" (mode: ${mode}). Indexed codebases: ${codebases.map((c) => c.rootPath).join(', ')}`,
            },
          ],
        };
      }

      const text = results
        .map((r, i) => {
          let entry = `${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}  [${r.kind}] ${r.name}`;
          if (r.signature) entry += `\n   ${r.signature}`;
          if (r.snippet) entry += `\n\`\`\`\n${r.snippet}\n\`\`\``;
          return entry;
        })
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  server.registerTool(
    'codemogger_index',
    {
      title: 'Index Codebase',
      description: `Index a directory of source code for later searching. Scans files, parses them with tree-sitter (AST-aware chunking), computes embeddings, and stores everything in a local SQLite database. Supports Rust, C, C++, Go, Python, Zig, Java, Scala, JavaScript, TypeScript, TSX, PHP, and Ruby. Incremental: only re-indexes changed files.

Call this tool before using codemogger_search if the codebase has not been indexed yet. Once indexed, codemogger_search will be available for fast code navigation.`,
      inputSchema: {
        directory: z
          .string()
          .describe('Absolute path to the directory to index'),
      },
    },
    async ({ directory }) => {
      const result = await codeIndex.index(directory);

      // After indexing, update the search tool description to reflect the new state
      const codebases = await codeIndex.listCodebases();
      const current = findCurrentCodebase(codebases);
      searchTool.update({ description: buildSearchDescription(current) });
      server.sendToolListChanged();

      const text = [
        `Indexed ${result.files} files → ${result.chunks} chunks`,
        `Embedded: ${result.embedded}, Skipped: ${result.skipped} unchanged, Removed: ${result.removed} stale`,
        `Duration: ${result.duration}ms`,
        result.errors.length > 0 ? `Errors: ${result.errors.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  server.registerTool(
    'codemogger_reindex',
    {
      title: 'Reindex Codebase',
      description: `Update the code index after modifying files. Only re-processes changed files - fast for typical edits.

IMPORTANT: Call this tool at the end of every task that creates, modifies, or deletes source files. This keeps the search index fresh for future sessions.`,
      inputSchema: {
        directory: z
          .string()
          .describe('Absolute path to the directory to reindex'),
      },
    },
    async ({ directory }) => {
      const result = await codeIndex.index(directory);

      const codebases = await codeIndex.listCodebases();
      const current = findCurrentCodebase(codebases);
      searchTool.update({ description: buildSearchDescription(current) });
      server.sendToolListChanged();

      const parts = [
        `Reindexed: ${result.files} changed files, ${result.skipped} unchanged`,
      ];
      if (result.removed > 0) parts.push(`Removed: ${result.removed} stale`);
      parts.push(`Duration: ${result.duration}ms`);
      if (result.errors.length > 0)
        parts.push(`Errors: ${result.errors.join(', ')}`);

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    }
  );

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
