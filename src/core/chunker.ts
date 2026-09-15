import * as fs from 'fs';
import * as path from 'path';
import { splitFileLines } from './profiler';

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
}

/** 超长单行(压缩代码/超长注释)硬截断上限:保住行号坐标系,同时控制单块体积 */
const MAX_LINE_CHARS = 4000;

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)} …[超长行已截断,原 ${line.length} 字符]`;
}

/**
 * 把精读清单里的文件切成带行号的块。
 * 行号是"证据引用"的坐标系:之后每一道题的 文件:行号 都来自这里。
 * - 行数 = splitFileLines(去掉末尾换行产生的空元素),与校验/摘录同一坐标系
 * - 按累计字符预算切块(不再只按行数估计),超长单行硬截断
 * - 每文件最多 3 块,超出部分记入 truncated;读取失败记入 skipped(不再静默丢失)
 */
export function loadChunks(
  root: string,
  files: string[],
  maxCharsPerFile = 14000,
  maxChunksPerFile = 3
): ChunkResult {
  const chunks: Chunk[] = [];
  const truncated: string[] = [];
  const skipped: string[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      skipped.push(rel);
      continue;
    }
    const lines = splitFileLines(content).map(clampLine);
    if (!lines.length) {
      skipped.push(rel);
      continue;
    }
    if (lines.join('\n').length <= maxCharsPerFile) {
      chunks.push({ file: rel, startLine: 1, endLine: lines.length, content: lines.join('\n') });
      continue;
    }
    // 按字符预算累积成块(行完整性优先:单行超预算也保持整行)
    const blocks: Array<{ start: number; text: string[] }> = [];
    let cur: string[] = [];
    let curChars = 0;
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const add = lines[i].length + 1;
      if (curChars + add > maxCharsPerFile && cur.length) {
        blocks.push({ start: startIdx, text: cur });
        cur = [];
        curChars = 0;
        startIdx = i;
      }
      cur.push(lines[i]);
      curChars += add;
    }
    if (cur.length) blocks.push({ start: startIdx, text: cur });
    const made = blocks.slice(0, maxChunksPerFile);
    for (const b of made) {
      chunks.push({
        file: rel,
        startLine: b.start + 1,
        endLine: b.start + b.text.length,
        content: b.text.join('\n'),
      });
    }
    const readLines = made.reduce((s, b) => s + b.text.length, 0);
    if (readLines < lines.length) {
      truncated.push(`${rel}(已读 ${readLines}/${lines.length} 行)`);
    }
  }
  return { chunks, truncated, skipped };
}

/** 渲染一组块为可直接放进 prompt 的文本 */
export function renderChunks(chunks: Chunk[]): string {
  return chunks
    .map(
      (c) =>
        `### 文件:${c.file}(第 ${c.startLine}-${c.endLine} 行)\n\`\`\`\n${c.content}\n\`\`\``
    )
    .join('\n\n');
}
