import {
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';
import type { Embedder } from './types.ts';

export const LOCAL_MODEL_NAME = 'all-MiniLM-L6-v2';
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let _pipe: FeatureExtractionPipeline | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!_pipe) {
    _pipe = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    });
  }
  return _pipe;
}

/**
 * Embed texts using the local all-MiniLM-L6-v2 model (384 dims).
 * The model is downloaded on first use (~22MB) and cached.
 * Batches are processed sequentially to avoid OOM.
 */
export const localEmbed: Embedder = async (
  texts: string[]
): Promise<number[][]> => {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const results: number[][] = [];

  // Process in batches to balance throughput and memory
  const BATCH = 128;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const output = await pipe(batch, { pooling: 'mean', normalize: true });
    // output.tolist() returns number[][] for batched input
    const vectors = output.tolist() as number[][];
    results.push(...vectors);
  }

  return results;
};
