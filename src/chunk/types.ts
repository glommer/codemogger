export interface CodeChunk {
  chunkKey: string; // file_path:startLine:endLine
  filePath: string;
  language: string;
  kind: string; // "function", "struct", "impl", "class", "module", "block"
  name: string;
  signature: string; // first line or function signature
  snippet: string; // actual code
  startLine: number;
  endLine: number;
  fileHash: string; // SHA-256 of source file
}
