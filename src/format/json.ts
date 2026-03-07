import type { SearchResult } from '../db/store.ts';

export interface JsonOutput {
  query: string;
  results: SearchResult[];
  total: number;
  elapsed_ms: number;
}

export function formatJson(
  query: string,
  results: SearchResult[],
  elapsedMs: number
): string {
  const output: JsonOutput = {
    query,
    results,
    total: results.length,
    elapsed_ms: elapsedMs,
  };
  return JSON.stringify(output, null, 2);
}
