/** A function that takes texts and returns their embedding vectors */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface EmbedderConfig {
  embedder?: Embedder;
  embeddingModel?: string;
}
