import type { SearchResult } from '../db/store.ts';

export function formatText(
  query: string,
  results: SearchResult[],
  elapsedMs: number
): string {
  if (results.length === 0) {
    return `0 results for "${query}" (${elapsedMs}ms)`;
  }

  const lines = [
    `${results.length} result${results.length === 1 ? '' : 's'} for "${query}" (${elapsedMs}ms)`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const nameLabel = r.name ? `${r.kind} ${r.name}` : r.kind;
    lines.push(`[${i + 1}] ${nameLabel} (score: ${r.score.toFixed(2)})`);
    lines.push(`    ${r.filePath}:${r.startLine}-${r.endLine}`);
    if (r.signature) lines.push(`    ${r.signature}`);
    if (i < results.length - 1) lines.push('');
  }

  return lines.join('\n');
}
