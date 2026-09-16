import * as fs from 'fs';
import * as path from 'path';
import { containsHighRiskSecret, splitFileLines } from './profiler';

export interface Chunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ChunkResult {
  chunks: Chunk[];
  truncated: string[];
  skipped: string[];
  sensitive: string[];
}

/**
 * Split by character budget while preserving every source byte as far as the
 * configured file size allows. Long minified lines become several chunks that
 * all point to the same source line; they are never silently shortened.
 */
export function loadChunks(root: string, files: string[], maxCharsPerFile = 14000, maxChunksPerFile = 1000): ChunkResult {
  const chunks: Chunk[] = [];
  const truncated: string[] = [];
  const skipped: string[] = [];
  const sensitive: string[] = [];
  const rootAbs = path.resolve(root);
  for (const rel of files) {
    const abs = path.resolve(rootAbs, rel);
    if (abs !== rootAbs && !abs.toLowerCase().startsWith(`${rootAbs.toLowerCase()}${path.sep}`)) {
      skipped.push(rel);
      continue;
    }
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { skipped.push(rel); continue; }
    if (containsHighRiskSecret(content)) {
      sensitive.push(rel);
      continue;
    }
    const lines = splitFileLines(content);
    if (!lines.length) { skipped.push(rel); continue; }
    const pieces: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.length) { pieces.push({ line: i + 1, text: '' }); continue; }
      for (let start = 0; start < line.length; start += maxCharsPerFile) {
        pieces.push({ line: i + 1, text: line.slice(start, start + maxCharsPerFile) });
      }
    }
    const blocks: Array<{ startLine: number; endLine: number; text: string[] }> = [];
    let current: { startLine: number; endLine: number; text: string[]; size: number } | undefined;
    for (const piece of pieces) {
      const add = piece.text.length + 1;
      if (current && current.size + add > maxCharsPerFile) {
        blocks.push({ startLine: current.startLine, endLine: current.endLine, text: current.text });
        current = undefined;
      }
      if (!current) current = { startLine: piece.line, endLine: piece.line, text: [], size: 0 };
      current.text.push(piece.text);
      current.endLine = piece.line;
      current.size += add;
    }
    if (current) blocks.push({ startLine: current.startLine, endLine: current.endLine, text: current.text });
    const made = blocks.slice(0, Math.max(1, maxChunksPerFile));
    made.forEach((block) => chunks.push({ file: rel, startLine: block.startLine, endLine: block.endLine, content: block.text.join('\n') }));
    if (made.length < blocks.length) truncated.push(`${rel}(已读 ${made.length}/${blocks.length} 块)`);
  }
  return { chunks, truncated, skipped, sensitive };
}

export function renderChunks(chunks: Chunk[]): string {
  return chunks
    .map((c) => `### 文件:${c.file}(第 ${c.startLine}-${c.endLine} 行)\n\`\`\`\n${c.content}\n\`\`\``)
    .join('\n\n');
}
