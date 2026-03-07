import type { SearchResult } from '../db/store.ts';

/**
 * Reciprocal Rank Fusion — combines two ranked result lists into one.
 *
 *   score(skill) = w_fts/(k + rank_fts) + w_vec/(k + rank_vec)
 *
 * k=60 is the standard constant. Skills that rank high in both
 * systems get the best combined score, without needing to normalize
 * different score scales (BM25 scores vs cosine distances).
 *
 * Weights default to fts=0.4, vec=0.6 — giving vector a slight edge
 * since it handles semantic queries better while BM25 still helps
 * with exact keyword matches.
 */
export function rrfMerge(
  ftsResults: SearchResult[],
  vecResults: SearchResult[],
  limit: number,
  k = 60,
  ftsWeight = 0.4,
  vecWeight = 0.6
): SearchResult[] {
  const scores = new Map<string, number>();
  const data = new Map<string, SearchResult>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i]!;
    scores.set(
      r.chunkKey,
      (scores.get(r.chunkKey) ?? 0) + ftsWeight / (k + i + 1)
    );
    data.set(r.chunkKey, r);
  }

  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i]!;
    scores.set(
      r.chunkKey,
      (scores.get(r.chunkKey) ?? 0) + vecWeight / (k + i + 1)
    );
    // Prefer FTS row data (has BM25 score) but fill in from vector if not present
    if (!data.has(r.chunkKey)) {
      data.set(r.chunkKey, r);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, score]) => {
      const row = data.get(key)!;
      return { ...row, score };
    });
}
