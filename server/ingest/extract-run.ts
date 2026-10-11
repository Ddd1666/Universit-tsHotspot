import { findExtractor } from './extractors/registry.ts';
import { chunkBlocks } from './chunker.ts';
import type { ChunkDraft, ExtractInput, ExtractLimits } from './types.ts';

export interface ExtractOutput {
  chunks: ChunkDraft[];
  pages: number | null;
  warnings: string[];
}

/** Extraktion + Chunking (CPU-lastig) – läuft im Worker-Thread. */
export async function runExtraction(input: ExtractInput, limits: ExtractLimits): Promise<ExtractOutput> {
  const extractor = findExtractor(input);
  if (!extractor) throw new Error(`Kein Extractor für ${input.kind}`);
  const result = await extractor.extract(input, limits);
  const chunks = chunkBlocks(result.blocks);
  return { chunks, pages: result.meta?.pages ?? null, warnings: result.warnings ?? [] };
}
